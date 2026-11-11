// Scores Douban search results against what we know about a local work
// (title, kind, year, season) and picks the best candidate, or none.
import type { DoubanSearchItem } from "./douban-parse.js";

export type MatchQuery = {
  title: string;
  kind: "movie" | "show";
  year?: number | null;
  /** Lowest season present locally; Douban lists every season as its own subject. */
  season?: number | null;
};

export type MatchResult = { item: DoubanSearchItem; score: number };

/** Minimum title similarity (0-100) before a candidate is considered at all. */
const MIN_TITLE_SCORE = 60;
/** Minimum total score for a candidate to be accepted. */
const MIN_TOTAL_SCORE = 60;
/** At or above this score a match is good enough to stop trying other search terms. */
export const CONFIDENT_SCORE = 110;

const cnDigits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnToNumber(raw: string) {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.includes("十")) {
    const [left, right = ""] = raw.split("十");
    return (left ? cnDigits[left] || 0 : 1) * 10 + (right ? cnDigits[right] || 0 : 0);
  }
  return cnDigits[raw] ?? null;
}

/** Lowercases and strips accents, punctuation and whitespace: "Joker: Folie à Deux" -> "jokerfolieadeux". */
export function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Splits "黑镜 第六季" / "Arcane Season 2" / "秘密森林2" into the series name
 * and its season. Names without a marker are season 1.
 */
export function splitSeason(name: string) {
  const marker = name.match(/第\s*([零〇一二两三四五六七八九十\d]+)\s*[季部期]|Season\s*(\d{1,2})/i);
  if (marker) {
    const season = marker[2] ? Number(marker[2]) : cnToNumber(marker[1]);
    return { base: name.replace(marker[0], " ").replace(/\s+/g, " ").trim(), season: season || 1 };
  }
  const trailing = name.match(/^(.*[㐀-鿿])\s*(\d)$/u);
  if (trailing && Number(trailing[2]) >= 2) return { base: trailing[1].trim(), season: Number(trailing[2]) };
  return { base: name.trim(), season: 1 };
}

function bigrams(text: string) {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
  return grams;
}

/** Similarity of two normalized titles, 0-100. */
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && long.includes(short)) return 40 + 50 * (short.length / long.length);
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared++;
  return 60 * ((2 * shared) / (ga.size + gb.size));
}

function candidateNames(item: DoubanSearchItem, isShow: boolean) {
  const names = new Set<string>();
  for (const raw of [item.name, item.originalName]) {
    if (!raw) continue;
    const base = isShow ? splitSeason(raw).base : raw;
    names.add(normalizeTitle(base));
    // "无耻之徒(美版)" should still match a folder simply called "无耻之徒".
    names.add(normalizeTitle(base.replace(/[（(][^）)]*[）)]/g, " ")));
  }
  names.delete("");
  return [...names];
}

// Null means the years contradict each other: same name, different work
// (a remake, or the British original of an American show).
function yearAdjustment(queryYear: number | null | undefined, itemYear: number) {
  if (!queryYear || !itemYear) return 0;
  const diff = Math.abs(queryYear - itemYear);
  if (diff === 0) return 30;
  return diff === 1 ? 15 : null;
}

export function scoreDoubanItem(item: DoubanSearchItem, query: MatchQuery, index = 0, total = 1) {
  const wanted = normalizeTitle(query.title);
  const itemIsShow = item.category === "电视剧";
  const titleScore = Math.max(0, ...candidateNames(item, itemIsShow).map((name) => similarity(wanted, name)));
  if (titleScore < MIN_TITLE_SCORE) return 0;

  let score = titleScore;
  score += itemIsShow === (query.kind === "show") ? 0 : -20;
  let sameSeason = true;
  if (query.kind === "show" && itemIsShow) {
    sameSeason = splitSeason(item.name).season === (query.season || 1);
    score += sameSeason ? 20 : -30;
  }
  // A different season legitimately has a different year, so only compare
  // years when the season lines up.
  const yearScore = sameSeason ? yearAdjustment(query.year, item.year) : 0;
  if (yearScore == null) return 0;
  score += yearScore;
  // Tie-breakers: well-known titles and Douban's own ordering.
  score += Math.min(10, Math.log10(item.votes + 1) * 1.5);
  score += 3 * (1 - index / Math.max(1, total));
  return score;
}

export function pickDoubanMatch(items: DoubanSearchItem[], query: MatchQuery): MatchResult | undefined {
  let best: MatchResult | undefined;
  items.forEach((item, index) => {
    const score = scoreDoubanItem(item, query, index, items.length);
    if (score >= MIN_TOTAL_SCORE && (!best || score > best.score)) best = { item, score };
  });
  return best;
}
