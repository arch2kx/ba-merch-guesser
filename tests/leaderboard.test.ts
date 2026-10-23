import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import baAmiInfo from "../js/baAmiData.json";
import { CORRECT_RANGE, MAX_MISSES, YEN_TO_USD, isSafe, uniqueByName } from "../js/shared";
import { buildSeedSql } from "../scripts/gen-seed";

const migrations = await Promise.all(
  ["20261016000000_leaderboard.sql", "20261023000000_leaderboard_hardening.sql"].map((f) =>
    Bun.file(new URL(`../supabase/migrations/${f}`, import.meta.url)).text(),
  ),
);

const uniqueItems = uniqueByName(baAmiInfo.items);
const priceByName = new Map(uniqueItems.map((i) => [i.name, i.price * YEN_TO_USD]));

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const m of migrations) await db.exec(m);
  await db.exec(buildSeedSql(baAmiInfo.items));
});

beforeEach(async () => {
  await db.exec(`
    update public.game_sessions set created_at = created_at - interval '1 hour';
    update public.leaderboard set created_at = created_at - interval '1 hour';
  `);
});

async function asRole<T>(role: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

function asAnon<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asRole<T>("anon", sql, params);
}

async function callAs<T = any>(role: string, fn: string, args: unknown[]): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await asRole<{ r: T }>(role, `select public.${fn}(${placeholders}) as r`, args);
  return rows[0]!.r;
}

function call<T = any>(fn: string, args: unknown[]): Promise<T> {
  return callAs<T>(fn === "submit_score" ? "service_role" : "anon", fn, args);
}

interface Item { id: number; name: string; image_url: string }

async function start(mode = "safe") {
  return call<{ session_id: string; round: number; item: Item }>("start_game", [mode]);
}

function priceOf(item: Item) {
  const p = priceByName.get(item.name);
  if (p === undefined) throw new Error(`unknown item ${item.name}`);
  return p;
}

async function playToEnd(sessionId: string, first: Item, hits: number) {
  let item = first;
  let round = 0;
  let last: any;
  let made = 0;
  while (true) {
    const guess = made < hits ? priceOf(item) : priceOf(item) * 10;
    last = await call("submit_guess", [sessionId, round, guess]);
    if (made < hits) made++;
    round = last.round;
    if (last.game_over) return last;
    item = last.next_item;
  }
}

describe("seed", () => {
  test("loads every unique item with exact USD price and safe flag", async () => {
    const rows = (await db.query<{ name: string; price_usd: string; safe: boolean }>(
      "select name, price_usd::text, safe from public.items where active",
    )).rows;
    expect(rows.length).toBe(uniqueItems.length);
    for (const row of rows) {
      const src = uniqueItems.find((i) => i.name === row.name)!;
      expect(Number(row.price_usd)).toBeCloseTo(src.price * YEN_TO_USD, 6);
      expect(row.safe).toBe(isSafe(row.name));
    }
  });

  test("is idempotent", async () => {
    await db.exec(buildSeedSql(baAmiInfo.items));
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.items");
    expect(rows[0]!.n).toBe(uniqueItems.length);
  });
});

describe("access control", () => {
  test("anon cannot read or write tables directly", async () => {
    await expect(asAnon("select * from public.items")).rejects.toThrow(/permission denied/);
    await expect(asAnon("select * from public.game_sessions")).rejects.toThrow(/permission denied/);
    await expect(asAnon("select * from public.leaderboard")).rejects.toThrow(/permission denied/);
    await expect(
      asAnon("insert into public.leaderboard (name, mode, score) values ('x', 'safe', 999)"),
    ).rejects.toThrow(/permission denied/);
    await expect(asAnon("update public.game_sessions set score = 999")).rejects.toThrow(/permission denied/);
  });

  test("anon cannot call internal helpers", async () => {
    await expect(asAnon("select public.lb_item_json(1)")).rejects.toThrow(/permission denied/);
    await expect(asAnon("select public.lb_rank(1)")).rejects.toThrow(/permission denied/);
    await expect(asAnon("select * from public.lb_draw('all', '{}', 1)")).rejects.toThrow(/permission denied/);
  });

  test("only service_role can submit scores", async () => {
    const s = await start("safe");
    await playToEnd(s.session_id, s.item, 1);
    for (const role of ["anon", "authenticated"]) {
      await expect(callAs(role, "submit_score", [s.session_id, "Bot"])).rejects.toThrow(/permission denied/);
    }
    const ok: any = await call("submit_score", [s.session_id, "Human"]);
    expect(ok.id).toBeDefined();
  });

  test("new public objects are not exposed by default", async () => {
    await db.exec(`
      create table public.lb_probe (id int);
      create function public.lb_probe_fn() returns int language sql as 'select 1';
    `);
    try {
      await expect(asAnon("select * from public.lb_probe")).rejects.toThrow(/permission denied/);
      await expect(asAnon("select public.lb_probe_fn()")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("drop table public.lb_probe; drop function public.lb_probe_fn();");
    }
  });

  test("start_game never leaks prices", async () => {
    const s = await start("all");
    expect(Object.keys(s.item).sort()).toEqual(["id", "image_url", "name"]);
  });
});

describe("gameplay", () => {
  test("rejects invalid modes", async () => {
    await expect(start("hard")).rejects.toThrow(/invalid_mode/);
  });

  test("safe mode only serves safe items without repeats per deck", async () => {
    const safeCount = uniqueItems.filter((i) => isSafe(i.name)).length;
    const s = await start("safe");
    const seen = [s.item.name];
    let item = s.item;
    let round = 0;
    for (let i = 1; i < safeCount; i++) {
      const r: any = await call("submit_guess", [s.session_id, round, priceOf(item)]);
      round = r.round;
      item = r.next_item;
      seen.push(item.name);
    }
    expect(seen.every(isSafe)).toBe(true);
    expect(new Set(seen).size).toBe(safeCount);
  });

  test(`guess within ${CORRECT_RANGE}% scores, beyond misses`, async () => {
    const s = await start("all");
    const price = priceOf(s.item);
    const hit: any = await call("submit_guess", [s.session_id, 0, price * (1 + CORRECT_RANGE / 100) * 0.999]);
    expect(hit.correct).toBe(true);
    expect(hit.score).toBe(1);
    expect(hit.misses).toBe(0);
    expect(Number(hit.real_price)).toBeCloseTo(price, 6);

    const price2 = priceOf(hit.next_item);
    const miss: any = await call("submit_guess", [s.session_id, 1, price2 * (1 + CORRECT_RANGE / 100) * 1.001]);
    expect(miss.correct).toBe(false);
    expect(miss.score).toBe(1);
    expect(miss.misses).toBe(1);
  });

  test(`game ends after ${MAX_MISSES} misses and rejects further guesses`, async () => {
    const s = await start("all");
    const last = await playToEnd(s.session_id, s.item, 3);
    expect(last.game_over).toBe(true);
    expect(last.score).toBe(3);
    expect(last.misses).toBe(MAX_MISSES);
    expect(last.next_item).toBeNull();
    expect(last.round).toBe(3 + MAX_MISSES);
    await expect(call("submit_guess", [s.session_id, last.round, 1])).rejects.toThrow(/game_over/);
  });

  test("retrying a round returns the original result instead of regrading", async () => {
    const s = await start("all");
    const first: any = await call("submit_guess", [s.session_id, 0, priceOf(s.item) * 50]);
    const retry: any = await call("submit_guess", [s.session_id, 0, priceOf(s.item)]);
    expect(retry).toEqual(first);
    expect(retry.correct).toBe(false);
    await expect(call("submit_guess", [s.session_id, 5, 10])).rejects.toThrow(/stale_round/);
    await expect(call("submit_guess", [s.session_id, -1, 10])).rejects.toThrow(/stale_round/);
  });

  test("rejects invalid guesses without consuming the round", async () => {
    const s = await start("all");
    for (const bad of [0, -5, "NaN", "Infinity", 1e12, null]) {
      await expect(call("submit_guess", [s.session_id, 0, bad])).rejects.toThrow(/invalid_guess/);
    }
    const ok: any = await call("submit_guess", [s.session_id, 0, priceOf(s.item)]);
    expect(ok.round).toBe(1);
    expect(ok.correct).toBe(true);
  });

  test("unknown sessions are rejected", async () => {
    const fake = "00000000-0000-0000-0000-000000000000";
    await expect(call("submit_guess", [fake, 0, 10])).rejects.toThrow(/unknown_session/);
    await expect(call("submit_score", [fake, "x"])).rejects.toThrow(/unknown_session/);
  });
});

describe("leaderboard", () => {
  test("only finished games can be submitted, with the server-side score", async () => {
    const s = await start("all");
    await expect(call("submit_score", [s.session_id, "Early"])).rejects.toThrow(/game_not_over/);
    await playToEnd(s.session_id, s.item, 4);
    const res: any = await call("submit_score", [s.session_id, "  Sensei \n  Arona\t"]);
    expect(res.rank).toBeGreaterThanOrEqual(1);
    const board: any[] = await asAnon("select * from public.get_leaderboard('all')");
    const entry = board.find((e) => e.id === Number(res.id));
    expect(entry.name).toBe("Sensei Arona");
    expect(entry.score).toBe(4);
  });

  test("a session can only be submitted once", async () => {
    const s = await start("safe");
    await playToEnd(s.session_id, s.item, 2);
    const a: any = await call("submit_score", [s.session_id, "Once"]);
    const b: any = await call("submit_score", [s.session_id, "Twice"]);
    expect(b.id).toBe(a.id);
    const board: any[] = await asAnon("select * from public.get_leaderboard('safe', 50)");
    expect(board.filter((e) => e.name === "Twice")).toHaveLength(0);
    expect(board.filter((e) => e.name === "Once")).toHaveLength(1);
  });

  test("zero scores and bad names are rejected", async () => {
    const zero = await start("safe");
    await playToEnd(zero.session_id, zero.item, 0);
    await expect(call("submit_score", [zero.session_id, "Zero"])).rejects.toThrow(/score_too_low/);

    const s = await start("safe");
    await playToEnd(s.session_id, s.item, 1);
    for (const bad of ["", "   ", "\u0007\u001b", "x".repeat(21), null]) {
      await expect(call("submit_score", [s.session_id, bad])).rejects.toThrow(/invalid_name/);
    }
    const ok: any = await call("submit_score", [s.session_id, "x".repeat(20)]);
    expect(ok.id).toBeDefined();
  });

  test("boards are separated by mode and ranked by score then time", async () => {
    await db.exec("delete from public.leaderboard");
    const scores = [3, 5, 3, 1];
    const ids: number[] = [];
    for (const [i, hits] of scores.entries()) {
      const s = await start("safe");
      await playToEnd(s.session_id, s.item, hits);
      const r: any = await call("submit_score", [s.session_id, `P${i}`]);
      ids.push(Number(r.id));
    }
    const other = await start("all");
    await playToEnd(other.session_id, other.item, 9);
    await call("submit_score", [other.session_id, "AllMode"]);

    const safe: any[] = await asAnon("select * from public.get_leaderboard('safe')");
    expect(safe.map((e) => e.name)).toEqual(["P1", "P0", "P2", "P3"]);
    expect(safe.map((e) => e.score)).toEqual([5, 3, 3, 1]);

    const all: any[] = await asAnon("select * from public.get_leaderboard('all')");
    expect(all.map((e) => e.name)).toEqual(["AllMode"]);

    const ranks: number[] = [];
    for (const id of ids) {
      const { rows } = await db.query<{ r: number }>("select public.lb_rank($1) as r", [id]);
      ranks.push(rows[0]!.r);
    }
    expect(ranks).toEqual([2, 1, 3, 4]);
  });

  test("limit is clamped", async () => {
    const big: any[] = await asAnon("select * from public.get_leaderboard('safe', 100000)");
    expect(big.length).toBeLessThanOrEqual(50);
    const tiny: any[] = await asAnon("select * from public.get_leaderboard('safe', -3)");
    expect(tiny.length).toBe(1);
  });

  test("stale sessions are cleaned up without losing leaderboard rows", async () => {
    const s = await start("safe");
    await playToEnd(s.session_id, s.item, 2);
    const r: any = await call("submit_score", [s.session_id, "Old"]);
    await db.query("update public.game_sessions set updated_at = now() - interval '2 days' where id = $1", [s.session_id]);
    await start("safe");
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.game_sessions where id = $1", [s.session_id]);
    expect(rows[0]!.n).toBe(0);
    const lb = await db.query<{ session_id: string | null }>("select session_id from public.leaderboard where id = $1", [r.id]);
    expect(lb.rows[0]!.session_id).toBeNull();
  });
});

describe("rate limits", () => {
  test("start_game is capped per minute", async () => {
    await db.exec("delete from public.game_sessions where created_at > now() - interval '1 minute'");
    for (let i = 0; i < 60; i++) await start("safe");
    await expect(start("safe")).rejects.toThrow(/rate_limited/);
  });

  test("leaderboard timestamps are server-set", async () => {
    const { rows } = await db.query<{ created_at: Date }>(`
      insert into public.leaderboard (name, mode, score, created_at)
      values ('Backdated', 'safe', 1, '2000-01-01')
      returning created_at
    `);
    expect(Date.now() - rows[0]!.created_at.getTime()).toBeLessThan(60_000);
    await db.exec("delete from public.leaderboard where name = 'Backdated'");
  });

  test("leaderboard inserts are capped per minute", async () => {
    const sessions = [];
    for (let i = 0; i < 11; i++) {
      const s = await start("safe");
      await playToEnd(s.session_id, s.item, 1);
      sessions.push(s.session_id);
    }
    for (const id of sessions.slice(0, 10)) await call("submit_score", [id, "Burst"]);
    await expect(call("submit_score", [sessions[10], "Burst"])).rejects.toThrow(/rate_limited/);
  });
});
