import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";
import {
  CORRECT_RANGE,
  MAX_MISSES,
  ROUND_SECONDS,
  YEN_TO_USD,
  isSafe,
  uniqueByName,
  type Mode,
  type RawItem,
} from "./shared";

export interface Item {
  id: number | string;
  name: string;
  image_url: string;
}

export interface GuessResult {
  correct: boolean;
  timedOut: boolean;
  percentOff: number | null;
  realPrice: number;
  score: number;
  misses: number;
  gameOver: boolean;
}

export interface Round {
  item: Item;
  secondsLeft: number;
}

export interface SubmitResult {
  id: number;
  rank: number;
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  score: number;
  created_at: string;
}

export interface Game {
  readonly online: boolean;
  readonly firstItem: Item;
  guess(value: number | null): Promise<GuessResult>;
  next(): Promise<Round>;
  submitScore(name: string, captcha: string): Promise<SubmitResult>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export const leaderboardEnabled = SUPABASE_URL !== "" && SUPABASE_ANON_KEY !== "";

async function post<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  };
  if (SUPABASE_ANON_KEY.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ApiError("Couldn't reach the server.", null);
  }

  if (!res.ok) {
    let code: string | null = null;
    try {
      const body = (await res.json()) as { message?: unknown; error?: unknown } | null;
      if (typeof body?.message === "string") code = body.message;
      else if (typeof body?.error === "string") code = body.error;
    } catch {}
    throw new ApiError(code ?? `Server error (${res.status}).`, code);
  }

  return (await res.json()) as T;
}

function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return post<T>(`/rest/v1/rpc/${fn}`, args);
}

interface RemoteStart {
  session_id: string;
  round: number;
  item: Item;
}

interface RemoteGuess {
  round: number;
  correct: boolean;
  timed_out: boolean;
  percent_off: number | null;
  real_price: number;
  score: number;
  misses: number;
  game_over: boolean;
}

interface RemoteNext {
  round: number;
  item: Item;
  seconds_left: number;
}

class RemoteGame implements Game {
  readonly online = true;

  private constructor(
    private readonly sessionId: string,
    private round: number,
    readonly firstItem: Item,
  ) {}

  static async create(mode: Mode): Promise<RemoteGame> {
    const data = await rpc<RemoteStart>("start_game", { p_mode: mode });
    return new RemoteGame(data.session_id, data.round, data.item);
  }

  async guess(value: number | null): Promise<GuessResult> {
    const data = await rpc<RemoteGuess>("submit_guess", {
      p_session_id: this.sessionId,
      p_round: this.round,
      p_guess: value,
    });
    this.round = data.round;
    return {
      correct: data.correct,
      timedOut: data.timed_out,
      percentOff: data.percent_off === null ? null : Number(data.percent_off),
      realPrice: Number(data.real_price),
      score: data.score,
      misses: data.misses,
      gameOver: data.game_over,
    };
  }

  async next(): Promise<Round> {
    const data = await rpc<RemoteNext>("next_item", {
      p_session_id: this.sessionId,
      p_round: this.round,
    });
    return { item: data.item, secondsLeft: Number(data.seconds_left) };
  }

  submitScore(name: string, captcha: string): Promise<SubmitResult> {
    return post<SubmitResult>("/functions/v1/leaderboard-submit", {
      session_id: this.sessionId,
      name,
      captcha,
    });
  }
}

interface LocalItem extends Item {
  price: number;
}

let localItemsCache: Promise<LocalItem[]> | null = null;

function loadLocalItems(): Promise<LocalItem[]> {
  localItemsCache ??= fetch("js/baAmiData.json")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ items: RawItem[] }>;
    })
    .then((data) =>
      uniqueByName(data.items).map((item) => ({
        id: item.name,
        name: item.name,
        image_url: item.image_url,
        price: item.price,
      })),
    )
    .catch((err) => {
      localItemsCache = null;
      throw err;
    });
  return localItemsCache;
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = temp;
  }
  return a;
}

class LocalGame implements Game {
  readonly online = false;
  readonly firstItem: Item;
  private deck: LocalItem[] = [];
  private deckIndex = 0;
  private current: LocalItem;
  private score = 0;
  private misses = 0;

  private constructor(private readonly pool: LocalItem[]) {
    this.current = this.draw();
    this.firstItem = this.current;
  }

  static async create(mode: Mode): Promise<LocalGame> {
    const items = await loadLocalItems();
    const pool = mode === "all" ? items : items.filter((item) => isSafe(item.name));
    if (pool.length === 0) throw new ApiError("No items available.", "no_items");
    return new LocalGame(pool);
  }

  private draw(): LocalItem {
    if (this.deckIndex >= this.deck.length) {
      this.deck = shuffleArray(this.pool);
      this.deckIndex = 0;
    }
    const item = this.deck[this.deckIndex] as LocalItem;
    this.deckIndex += 1;
    return item;
  }

  async guess(value: number | null): Promise<GuessResult> {
    if (this.misses >= MAX_MISSES) throw new ApiError("Game over.", "game_over");

    const realPrice = this.current.price * YEN_TO_USD;
    const percentOff =
      value === null ? null : (Math.abs(value - realPrice) / realPrice) * 100;
    const correct = percentOff !== null && percentOff <= CORRECT_RANGE;

    if (correct) this.score += 1;
    else this.misses += 1;

    const gameOver = this.misses >= MAX_MISSES;
    if (!gameOver) this.current = this.draw();

    return {
      correct,
      timedOut: value === null,
      percentOff,
      realPrice,
      score: this.score,
      misses: this.misses,
      gameOver,
    };
  }

  async next(): Promise<Round> {
    return { item: this.current, secondsLeft: ROUND_SECONDS };
  }

  async submitScore(): Promise<SubmitResult> {
    throw new ApiError("Leaderboard is unavailable offline.", "offline");
  }
}

export async function startGame(mode: Mode): Promise<Game> {
  if (leaderboardEnabled) {
    try {
      return await RemoteGame.create(mode);
    } catch (err) {
      console.warn("Leaderboard server unavailable, playing offline.", err);
    }
  }
  return LocalGame.create(mode);
}

export function fetchLeaderboard(mode: Mode, limit = 10): Promise<LeaderboardEntry[]> {
  return rpc<LeaderboardEntry[]>("get_leaderboard", { p_mode: mode, p_limit: limit });
}

const ERROR_MESSAGES: Record<string, string> = {
  unknown_session: "This game expired. Press Play Again to start a new one.",
  stale_round: "This round is out of sync. Press Play Again to start a new game.",
  game_over: "This game is already over.",
  invalid_guess: "Invalid input! Try again.",
  game_not_over: "Finish the game before saving your score.",
  score_too_low: "You need at least 1 point to join the leaderboard.",
  invalid_name: "Name must be 1–20 characters.",
  no_items: "No items available.",
  round_not_started: "This round is out of sync. Press Play Again to start a new game.",
  rate_limited: "The leaderboard is busy. Try again in a minute.",
  captcha_failed: "Captcha check failed. Please try again.",
  captcha_unavailable: "Couldn't verify the captcha. Try again.",
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return (err.code && ERROR_MESSAGES[err.code]) || err.message;
  }
  return "Something went wrong. Try again.";
}
