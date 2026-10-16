import baAmiInfo from "../js/baAmiData.json";
import { YEN_TO_USD, isSafe, uniqueByName, type RawItem } from "../js/shared";

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildSeedSql(items: RawItem[]): string {
  const rows = uniqueByName(items).map((item) => {
    if (!Number.isInteger(item.price) || item.price <= 0) {
      throw new Error(`Invalid price for ${item.name}: ${item.price}`);
    }
    return `  (${sqlString(item.name)}, ${sqlString(item.image_url)}, ${item.price} * ${YEN_TO_USD}, ${isSafe(item.name)}, true)`;
  });

  return [
    "begin;",
    "update public.items set active = false;",
    "insert into public.items (name, image_url, price_usd, safe, active) values",
    rows.join(",\n"),
    "on conflict (name) do update set",
    "  image_url = excluded.image_url,",
    "  price_usd = excluded.price_usd,",
    "  safe = excluded.safe,",
    "  active = true;",
    "commit;",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const out = new URL("../supabase/seed.sql", import.meta.url);
  await Bun.write(out, buildSeedSql(baAmiInfo.items));
  console.log(`Wrote ${out.pathname}`);
}
