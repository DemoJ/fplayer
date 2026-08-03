import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

// Persistent transcode/remux cache, keyed by absolute source time.
//
// Segments are written as `{mediaId}/{quality}/segment-{absSeq}.ts` where
// absSeq = floor(sourceSeconds / segSec), so any seek target maps to a stable
// file name regardless of where the encoder started. A replay at the same
// position (or a seek back into already-transcoded territory) hits these
// files directly without pulling the source from the drive again — the main
// cause of drive rate limiting ("播放着播放着就不能播放了").

export const TRANSCODE_SEGMENT_SECONDS = 6;
export const REMUX_SEGMENT_SECONDS = 10;
// Directory-count cap kept before LRU eviction (media × quality dirs).
const MAX_CACHE_DIRS = 200;

export type TranscodeMeta = {
  segSec: number;
  quality: string;
  // Absolute source second where the aggregate playlist currently begins.
  activeStart: number;
  // True once ffmpeg reached EOF naturally: the cache is complete and the
  // aggregate playlist is VOD (ENDLIST), so the client never waits for new
  // segments it would never come.
  complete: boolean;
  updatedAt: number;
};

export function segSecFor(mode: "transcode" | "remux") {
  return mode === "remux" ? REMUX_SEGMENT_SECONDS : TRANSCODE_SEGMENT_SECONDS;
}

// Absolute segment sequence number covering the given source second.
export function absSeq(seconds: number, segSec: number) {
  return Math.max(0, Math.floor(seconds / segSec));
}

export function cacheRoot(mediaId: number, quality: string) {
  return path.join(config.dataDir, "transcodes", String(mediaId), quality);
}

export function segmentFile(mediaId: number, quality: string, seq: number) {
  return path.join(cacheRoot(mediaId, quality), `segment-${seq}.ts`);
}

export function metaFile(mediaId: number, quality: string) {
  return path.join(cacheRoot(mediaId, quality), "meta.json");
}

export async function ensureCacheDir(mediaId: number, quality: string) {
  const dir = cacheRoot(mediaId, quality);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readMeta(mediaId: number, quality: string): Promise<TranscodeMeta | null> {
  try {
    const raw = await fs.readFile(metaFile(mediaId, quality), "utf8");
    const meta = JSON.parse(raw);
    if (typeof meta?.segSec !== "number") return null;
    return { quality, segSec: meta.segSec, activeStart: meta.activeStart ?? 0, complete: Boolean(meta.complete), updatedAt: meta.updatedAt ?? 0 };
  } catch {
    return null;
  }
}

export async function writeMeta(mediaId: number, quality: string, meta: Partial<TranscodeMeta> & Pick<TranscodeMeta, "segSec">) {
  const prev = await readMeta(mediaId, quality).catch(() => null);
  const base: TranscodeMeta = { quality, segSec: TRANSCODE_SEGMENT_SECONDS, activeStart: 0, complete: false, updatedAt: Date.now() };
  const next: TranscodeMeta = { ...base, ...prev, ...meta, updatedAt: Date.now() };
  await fs.mkdir(cacheRoot(mediaId, quality), { recursive: true }).catch(() => {});
  await fs.writeFile(metaFile(mediaId, quality), JSON.stringify(next), "utf8");
  return next;
}

export async function touch(mediaId: number, quality: string) {
  try {
    const file = metaFile(mediaId, quality);
    const stat = await fs.stat(file);
    await fs.utimes(file, stat.atime, new Date());
  } catch {}
}

const SEGMENT_RE = /^segment-(\d+)\.ts$/;

// All segment sequence numbers present for this media/quality, ascending.
export async function listSegments(mediaId: number, quality: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(cacheRoot(mediaId, quality));
    const seqs: number[] = [];
    for (const name of entries) {
      const m = SEGMENT_RE.exec(name);
      if (m) seqs.push(Number(m[1]));
    }
    return seqs.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function fileExists(full: string) {
  return fsSync.existsSync(full);
}

// Longest run of contiguous segment numbers beginning at `from`.
export function contiguousFrom(seqs: number[], from: number): number[] {
  const present = new Set(seqs);
  const out: number[] = [];
  let seq = from;
  while (present.has(seq)) {
    out.push(seq);
    seq++;
  }
  return out;
}

// Head of the contiguous cache block containing `target` (walk backwards from
// the target while segments exist). If the target itself is not cached,
// returns the target — the encoder starts a fresh block there.
export function blockHead(seqs: number[], target: number): number {
  const present = new Set(seqs);
  if (!present.has(target)) return target;
  let head = target;
  while (present.has(head - 1)) head--;
  return head;
}

// Renders the aggregate HLS playlist for a media/quality directory. The
// playlist contains every cached segment (allowing backward seeks into
// already-transcoded territory) plus whatever the live encoder is producing;
// hls.js reloads it on live streams, picking up newly written segments.
export function buildPlaylist(
  mediaId: number,
  quality: string,
  seqs: number[],
  segSec: number,
  endlist: boolean,
  sign: (file: string) => string,
) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${segSec}`,
    `#EXT-X-MEDIA-SEQUENCE:${seqs[0] ?? 0}`,
  ];
  for (const seq of seqs) {
    const file = `segment-${seq}.ts`;
    lines.push(`#EXTINF:${segSec.toFixed(3)},`);
    lines.push(`${file}?sig=${sign(file)}`);
  }
  if (endlist) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

// LRU eviction: drop the oldest media/quality directories until under the cap.
export async function sweepCache() {
  const root = path.join(config.dataDir, "transcodes");
  const candidates: Array<{ key: string; dir: string; updatedAt: number }> = [];
  try {
    for (const mediaId of await fs.readdir(root)) {
      const mediaDir = path.join(root, mediaId);
      for (const quality of await fs.readdir(mediaDir)) {
        const dir = path.join(mediaDir, quality);
        const metaPath = path.join(dir, "meta.json");
        try {
          const stat = await fs.stat(metaPath);
          candidates.push({ key: `${mediaId}/${quality}`, dir, updatedAt: stat.mtimeMs });
        } catch {
          candidates.push({ key: `${mediaId}/${quality}`, dir, updatedAt: Date.now() });
        }
      }
    }
  } catch {
    return; // root missing — nothing to sweep
  }
  if (candidates.length <= MAX_CACHE_DIRS) return;
  candidates.sort((a, b) => a.updatedAt - b.updatedAt);
  const victims = candidates.slice(0, candidates.length - MAX_CACHE_DIRS);
  log("cache", `sweep: ${candidates.length} dirs, evicting ${victims.length} (${victims.map((v) => v.key).join(", ")})`);
  for (const stale of victims) {
    await fs.rm(stale.dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Legacy session (uuid-named) directories from pre-cache builds may still
// linger; remove them so the cache tree stays strictly media/quality/segments.
export async function sweepStaleDirectories() {
  const root = path.join(config.dataDir, "transcodes");
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (uuidRe.test(entry.name)) {
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // Directory missing (fresh install) — nothing to do.
  }
}
