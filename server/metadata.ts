import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db.js";
import { config } from "./config.js";
import { fileYear, identify, rebuildCatalog, searchTitles } from "./catalog.js";
import { checkDoubanLogin, getDoubanSettings, getDoubanSubject, searchDouban, type DoubanSubject } from "./douban.js";
import { getSetting, setSetting } from "./settings.js";
import { CONFIDENT_SCORE, pickDoubanMatch, splitSeason, type MatchQuery, type MatchResult } from "./douban-match.js";

type JobRow = {
  id: number;
  status: string;
  phase: string;
  total: number;
  processed: number;
  matched: number;
  skipped: number;
  failed: number;
  current_title: string | null;
  error: string | null;
  finished_at: string | null;
};

type WorkRow = {
  id: number;
  title: string;
  kind: string;
  year: number | null;
  tmdb_id: number | null;
  poster_path: string | null;
  overview: string | null;
};

type SearchTerm = { search: string; title: string };
type WorkQuery = Omit<MatchQuery, "title"> & { terms: SearchTerm[] };

// Bump whenever matching changes enough that earlier matches cannot be
// trusted; every scraped work is then cleared once and scraped again.
const MATCHER_VERSION = "2";
const MATCHER_VERSION_KEY = "metadata:matcher_version";
const MAX_SEARCH_TERMS = 4;
const cnSeasons = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];

let activeJobId: number | null = null;
let abort = false;

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function alreadyMatched(work: WorkRow) {
  return Boolean(work.tmdb_id && work.poster_path && work.overview);
}

function updateJob(id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE metadata_jobs SET ${keys.map((key) => `${key}=@${key}`).join(",")} WHERE id=@id`;
  db.prepare(sql).run({ ...fields, id });
}

export function metadataStatus() {
  const job = db.prepare("SELECT * FROM metadata_jobs ORDER BY id DESC LIMIT 1").get() as JobRow | undefined;
  const pending = db.prepare(
    "SELECT COUNT(*) AS count FROM works WHERE tmdb_id IS NULL OR poster_path IS NULL OR poster_path='' OR overview IS NULL OR overview=''",
  ).get() as { count: number };
  const done = db.prepare(
    "SELECT COUNT(*) AS count FROM works WHERE tmdb_id IS NOT NULL AND poster_path IS NOT NULL AND poster_path!='' AND overview IS NOT NULL AND overview!=''",
  ).get() as { count: number };
  const settings = getDoubanSettings();
  return {
    provider: "douban",
    configured: true,
    hasCookie: Boolean(settings.cookies),
    avoidRiskControl: settings.avoidRiskControl,
    gapMs: settings.avoidRiskControl ? (settings.cookies ? 3000 : 5000) : 200,
    pending: pending.count,
    matchedWorks: done.count,
    running: Boolean(job && ["queued", "running"].includes(job.status)),
    job: job || null,
  };
}

// Matches made by an older matcher are not trustworthy (they were often
// simply wrong), so drop them once and let the next batch scrape them again.
export function resetOutdatedMatches() {
  if (getSetting(MATCHER_VERSION_KEY) === MATCHER_VERSION) return 0;
  const cleared = db.prepare(
    "UPDATE works SET tmdb_id=NULL,original_title=NULL,overview=NULL,poster_path=NULL,year=NULL WHERE tmdb_id IS NOT NULL",
  ).run().changes;
  setSetting(MATCHER_VERSION_KEY, MATCHER_VERSION);
  return cleared;
}

async function downloadPoster(workId: number, coverUrl?: string) {
  if (!coverUrl) return null;
  const dir = path.join(config.dataDir, "posters");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${workId}.jpg`);
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Referer: "https://movie.douban.com/",
  };
  const response = await fetch(coverUrl, { headers });
  if (!response.ok) return null;
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  return `/api/posters/${workId}.jpg`;
}

function buildOverview(subject: {
  intro: string;
  director: string;
  actor: string;
  genre: string;
  country: string;
}) {
  const parts = [subject.intro];
  const meta: string[] = [];
  if (subject.genre) meta.push(`类型：${subject.genre}`);
  if (subject.director) meta.push(`导演：${subject.director}`);
  if (subject.actor) meta.push(`主演：${subject.actor}`);
  if (subject.country) meta.push(`地区：${subject.country}`);
  if (meta.length) parts.push(meta.join(" · "));
  return parts.filter(Boolean).join("\n\n") || null;
}

// "幸福谷 Happy Valley" searches best as "幸福谷": Douban indexes the Chinese
// name, and the Latin half only dilutes the query.
function chinesePart(title: string) {
  if (!/[A-Za-z]/.test(title)) return "";
  const chinese = title.replace(/[A-Za-z][A-Za-z\d'’.&-]*/g, " ").replace(/\s+/g, " ").trim();
  return chinese.replace(/[^㐀-鿿]/gu, "").length >= 2 ? chinese : "";
}

export function buildSearchTerms(titles: string[], kind: "movie" | "show", season?: number | null) {
  const terms: SearchTerm[] = [];
  for (const title of titles) {
    const chinese = chinesePart(title);
    if (chinese) terms.push({ search: chinese, title: chinese });
    terms.push({ search: title, title });
  }
  // Douban lists each season separately and a plain search may only return
  // the later ones, so ask for the wanted season by name as well.
  const first = terms[0];
  if (first && kind === "show" && cnSeasons[season || 1]) {
    terms.splice(1, 0, { search: `${first.title} 第${cnSeasons[season || 1]}季`, title: first.title });
  }
  const seen = new Set<string>();
  return terms.filter((term) => !seen.has(term.search) && Boolean(seen.add(term.search))).slice(0, MAX_SEARCH_TERMS);
}

// What to search for comes from the files rather than the stored work row:
// the first episode of the lowest season names the work, its year and season.
function workQuery(work: WorkRow): WorkQuery {
  const media = db.prepare(
    "SELECT path FROM media WHERE work_id=? AND available=1 ORDER BY season IS NULL,season,episode,id LIMIT 1",
  ).get(work.id) as { path: string } | undefined;
  const identified = media ? identify(media.path) : null;
  const kind = (identified?.kind || work.kind) === "show" ? "show" : "movie";
  const titles = media ? searchTitles(media.path) : [];
  // A folder year ("权力的游戏 (2011)") dates the first season only; later
  // seasons may only trust a year written in the file name.
  const laterSeason = kind === "show" && (identified?.season || 1) > 1;
  return {
    terms: buildSearchTerms(titles.length ? titles : [work.title], kind, identified?.season),
    kind,
    year: !media || !identified ? work.year : laterSeason ? fileYear(media.path) : identified.year,
    season: identified?.season ?? null,
  };
}

async function searchWork(query: WorkQuery) {
  let best: MatchResult | undefined;
  for (const term of query.terms) {
    const items = await searchDouban(term.search);
    const hit = pickDoubanMatch(items, { title: term.title, kind: query.kind, year: query.year, season: query.season });
    if (hit && (!best || hit.score > best.score)) best = hit;
    // A show is named by its folder, so a confident hit settles it. A movie's
    // file name and folder can disagree; compare every term before deciding.
    if (query.kind === "show" && best && best.score >= CONFIDENT_SCORE) break;
  }
  return best;
}

/** Subject id of the wanted season when `subject` turned out to be another season of the same show. */
export function siblingSeason(subject: Pick<DoubanSubject, "sid" | "name" | "seasons">, season: number) {
  if (splitSeason(subject.name).season === season) return undefined;
  return subject.seasons.find((entry) => entry.season === season && entry.sid !== subject.sid)?.sid;
}

async function scrapeWork(work: WorkRow, onPhase: (phase: string) => void = () => {}) {
  onPhase("searching");
  const query = workQuery(work);
  const hit = await searchWork(query);
  if (!hit) throw new Error(`豆瓣没有找到「${query.terms[0]?.title || work.title}」`);

  onPhase("detail");
  let subject = await getDoubanSubject(hit.item.sid);
  if (!subject) throw new Error("无法读取豆瓣详情");
  // Search does not always list the wanted season (it hides the first seasons
  // of 无耻之徒(美版)), but any season's page links to all the others.
  const sibling = query.kind === "show" ? siblingSeason(subject, query.season || 1) : undefined;
  if (sibling) subject = (await getDoubanSubject(sibling)) || subject;

  onPhase("downloading");
  const poster = await downloadPoster(work.id, subject.img || hit.item.img);
  const name = subject.name || hit.item.name;
  db.prepare(
    "UPDATE works SET title=?,original_title=?,year=?,overview=?,poster_path=?,tmdb_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(
    // One work holds every season, so drop the "第一季" Douban appends.
    query.kind === "show" ? splitSeason(name).base || name : name,
    subject.originalName || hit.item.originalName || name,
    subject.year || hit.item.year || work.year,
    buildOverview(subject),
    poster || work.poster_path,
    Number(subject.sid),
    work.id,
  );
}

const isRateLimited = (message: string) => ["风控", "限流", "太频繁", "被封"].some((word) => message.includes(word));

async function run(jobId: number) {
  activeJobId = jobId;
  abort = false;
  updateJob(jobId, { status: "running", phase: "loading", started_at: now() });
  const works = db.prepare("SELECT * FROM works ORDER BY id").all() as WorkRow[];
  updateJob(jobId, { total: works.length, phase: "matching" });
  const counts = { processed: 0, matched: 0, skipped: 0, failed: 0 };
  const finish = (status: string, phase: string, extra: Record<string, unknown> = {}) =>
    updateJob(jobId, { status, phase, ...counts, current_title: null, finished_at: now(), ...extra });

  try {
    for (const work of works) {
      if (abort) return finish("cancelled", "cancelled", { error: "匹配已由用户停止" });
      counts.processed++;
      updateJob(jobId, { processed: counts.processed, current_title: work.title });
      if (alreadyMatched(work)) {
        counts.skipped++;
        updateJob(jobId, { skipped: counts.skipped, phase: "skipping" });
        continue;
      }
      try {
        await scrapeWork(work, (phase) => updateJob(jobId, { phase }));
        counts.matched++;
        updateJob(jobId, { matched: counts.matched, phase: "matching" });
      } catch (error) {
        counts.failed++;
        const message = error instanceof Error ? error.message : "匹配失败";
        updateJob(jobId, { failed: counts.failed, error: message });
        if (isRateLimited(message)) return finish("failed", "rate_limited", { current_title: work.title, error: message });
      }
    }
    finish("completed", "completed", { error: null });
  } catch (error) {
    finish("failed", "failed", { error: error instanceof Error ? error.message : "匹配失败" });
  } finally {
    activeJobId = null;
    abort = false;
  }
}

export async function refreshWorkMetadata(workId: number) {
  const work = db.prepare("SELECT * FROM works WHERE id=?").get(workId) as WorkRow | undefined;
  if (!work) throw new Error("作品不存在");
  await scrapeWork(work);
  return db.prepare("SELECT * FROM works WHERE id=?").get(workId);
}

export function startMetadataRefresh() {
  const active = db.prepare("SELECT id FROM metadata_jobs WHERE status IN ('queued','running') ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (active) return { id: active.id, existing: true };

  // Rebuild from original paths before every batch. This repairs works that
  // were created from a bad title during an earlier scan.
  rebuildCatalog();
  const pending = db.prepare(
    "SELECT COUNT(*) AS count FROM works WHERE tmdb_id IS NULL OR poster_path IS NULL OR poster_path='' OR overview IS NULL OR overview=''",
  ).get() as { count: number };
  const result = db.prepare("INSERT INTO metadata_jobs(status,phase,total) VALUES('queued','queued',?)").run(pending.count);
  const id = Number(result.lastInsertRowid);
  setImmediate(() => void run(id));
  return { id, existing: false, pending: pending.count };
}

export function stopMetadataRefresh() {
  const active = db.prepare("SELECT id,status FROM metadata_jobs WHERE status IN ('queued','running') ORDER BY id DESC LIMIT 1").get() as { id: number; status: string } | undefined;
  if (!active) return false;
  if (active.status === "queued") {
    updateJob(active.id, { status: "cancelled", phase: "cancelled", error: "匹配已由用户停止", finished_at: now() });
    return true;
  }
  if (activeJobId === active.id) abort = true;
  return true;
}

export async function enrichCatalog() {
  const started = startMetadataRefresh();
  return { accepted: true, ...started };
}

export { checkDoubanLogin };
