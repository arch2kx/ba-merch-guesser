export const MAX_MISSES = 5;
export const CORRECT_RANGE = 20;
export const ROUND_SECONDS = 20;
export const YEN_TO_USD = 0.0061;

export const SAFE_LINES = [
  "nendoroid",
  "chocopuni",
  "revoltech",
  "figma",
  "pop up parade",
];

export type Mode = "safe" | "all";

export interface RawItem {
  name: string;
  image_url: string;
  price: number;
}

export function uniqueByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export function isSafe(name: string): boolean {
  const lower = name.toLowerCase();
  return SAFE_LINES.some((line) => lower.includes(line));
}

export function cleanName(name: string): string {
  return name
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const NAME_MAX = 20;
