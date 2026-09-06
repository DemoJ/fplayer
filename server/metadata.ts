import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db.js";
import { config } from "./config.js";
import { identify, rebuildCatalog } from "./catalog.js";
import {
  checkDoubanLogin,
  getDoubanSettings,
  getDoubanSubject,
  pickDoubanMatch,
  searchDouban,
} from "./douban.js";

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

let activeJobId: number | null = null;
let abort = false;

function alreadyMatched(work: { tmdb_id?: number | null; poster_path?: string | null; overview?: string | null }) {
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

function searchTerms(title: string) {
  const terms = [title.trim()];
  const chinese = (title.match(/[\u3400-\u9fff][\u3400-\u9fff\s·]*/gu) || [])
    .map((part) => part.trim())
    .filter((part) => part.replace(/[^\u3400-\u9fff]/gu, "").length >= 2)
    .join(" ")
    .trim();
  if (chinese && chinese !== title.trim()) terms.unshift(chinese);
  return [...new Set(terms)].filter(Boolean);
}

async function searchWork(title: string, kind: "movie" | "show", workKind: string, year?: number | null) {
  for (const term of searchTerms(title)) {
    const items = await searchDouban(term, kind);
    const hit = pickDoubanMatch(items, term, workKind, year);
    if (hit) return hit;
  }
  return undefined;
}

async function run(jobId: number) {
  activeJobId = jobId;
  abort = false;
  updateJob(jobId, { status: "running", phase: "loading", started_at: new Date().toISOString().slice(0, 19).replace("T", " ") });
  const works = db.prepare("SELECT * FROM works ORDER BY id").all() as Array<any>;
  updateJob(jobId, { total: works.length, phase: "matching" });

  let processed = 0;
  let matched = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const work of works) {
      if (abort) {
        updateJob(jobId, {
          status: "cancelled",
          phase: "cancelled",
          processed,
          matched,
          skipped,
          failed,
          current_title: null,
          error: "匹配已由用户停止",
          finished_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        });
        return;
      }

      processed++;
      updateJob(jobId, { processed, current_title: work.title });

      if (alreadyMatched(work)) {
        skipped++;
        updateJob(jobId, { skipped, phase: "skipping" });
        continue;
      }

      try {
        updateJob(jobId, { phase: "searching" });
        const kind = work.kind === "show" ? "show" : "movie";
        const hit = await searchWork(work.title, kind, work.kind, work.year);
        if (!hit) {
          failed++;
          updateJob(jobId, { failed });
          continue;
        }

        updateJob(jobId, { phase: "detail" });
        const subject = await getDoubanSubject(hit.sid);
        if (!subject) {
          failed++;
          updateJob(jobId, { failed });
          continue;
        }

        updateJob(jobId, { phase: "downloading" });
        const poster = await downloadPoster(work.id, subject.img || hit.img);
        const overview = buildOverview(subject);
        db.prepare(
          "UPDATE works SET title=?,original_title=?,year=?,overview=?,poster_path=?,tmdb_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ).run(
          subject.name || hit.name,
          subject.originalName || hit.originalName || subject.name,
          subject.year || hit.year || work.year,
          overview,
          poster || work.poster_path,
          Number(subject.sid),
          work.id,
        );
        matched++;
        updateJob(jobId, { matched, phase: "matching" });
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : "匹配失败";
        updateJob(jobId, { failed, error: message });
        if (message.includes("风控") || message.includes("限流") || message.includes("太频繁") || message.includes("被封")) {
          updateJob(jobId, {
            status: "failed",
            phase: "rate_limited",
            current_title: work.title,
            finished_at: new Date().toISOString().slice(0, 19).replace("T", " "),
          });
          return;
        }
      }
    }

    updateJob(jobId, {
      status: "completed",
      phase: "completed",
      processed,
      matched,
      skipped,
      failed,
      current_title: null,
      error: null,
      finished_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
  } catch (error) {
    updateJob(jobId, {
      status: "failed",
      phase: "failed",
      processed,
      matched,
      skipped,
      failed,
      error: error instanceof Error ? error.message : "匹配失败",
      finished_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
  } finally {
    activeJobId = null;
    abort = false;
  }
}

export async function refreshWorkMetadata(workId: number) {
  const work = db.prepare("SELECT * FROM works WHERE id=?").get(workId) as any;
  if (!work) throw new Error("作品不存在");

  const media = db.prepare("SELECT path FROM media WHERE work_id=? AND available=1 ORDER BY id LIMIT 1").get(workId) as { path: string } | undefined;
  const identified = media ? identify(media.path) : null;
  const query = identified?.title || work.title;
  const workKind = identified?.kind || work.kind;

  const kind = workKind === "show" ? "show" : "movie";
  const hit = await searchWork(query, kind, workKind, identified?.year || work.year);
  if (!hit) throw new Error(`豆瓣没有找到「${query}」`);
  const subject = await getDoubanSubject(hit.sid);
  if (!subject) throw new Error("无法读取豆瓣详情");

  const poster = await downloadPoster(work.id, subject.img || hit.img);
  db.prepare(
    "UPDATE works SET title=?,original_title=?,year=?,overview=?,poster_path=?,tmdb_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(
    subject.name || hit.name,
    subject.originalName || hit.originalName || subject.name,
    subject.year || hit.year || work.year,
    buildOverview(subject),
    poster || work.poster_path,
    Number(subject.sid),
    workId,
  );
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
    updateJob(active.id, {
      status: "cancelled",
      phase: "cancelled",
      error: "匹配已由用户停止",
      finished_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
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
