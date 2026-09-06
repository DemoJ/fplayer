import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { XMLParser } from "fast-xml-parser";
import { db } from "./db.js";
import { config } from "./config.js";
import { decrypt } from "./security.js";
import type { Source } from "./types.js";

const extensions = new Set([".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts"]);
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function parseTitle(filePath: string) {
  const name = path.basename(filePath, path.extname(filePath)).replace(/[._]+/g, " ").trim();
  const episode = name.match(/S(\d{1,2})E(\d{1,3})/i);
  const clean = name.replace(/S\d{1,2}E\d{1,3}/i, "").replace(/[\[({].*?[\])}]/g, "").trim();
  return { title: clean || name, season: episode ? Number(episode[1]) : null, episode: episode ? Number(episode[2]) : null };
}

type ScanProgress = (phase: string, discovered: number, processed: number) => void;
type MediaFile = { path: string; size: number; modifiedAt: string };

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("扫描已停止", "AbortError");
}

async function walk(dir: string, root: string, files: MediaFile[], signal?: AbortSignal, progress?: ScanProgress): Promise<void> {
  throwIfAborted(signal);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, files, signal, progress);
    else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      const stat = await fs.stat(full);
      files.push({ path: full.slice(root.length).replace(/^[/\\]/, ""), size: stat.size, modifiedAt: stat.mtime.toISOString() });
      progress?.("discovering", files.length, 0);
    }
  }
}

async function webdavList(source: Source, signal?: AbortSignal, progress?: ScanProgress): Promise<MediaFile[]> {
  const files: MediaFile[] = [];
  const authHeaders: Record<string, string> = source.username
    ? { Authorization: `Basic ${Buffer.from(`${source.username}:${decrypt(source.secret)}`).toString("base64")}` }
    : {};
  // Layered traversal: list one collection at a time (Depth: 1) and recurse.
  // Some servers (Nextcloud and friends) reject or truncate Depth: infinity,
  // and a single infinity response for a large library would otherwise be
  // buffered fully in memory.
  async function listCollection(dirUrl: URL, seen: Set<string>): Promise<URL[]> {
    throwIfAborted(signal);
    const timeout = AbortSignal.timeout(60_000);
    const scanSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(dirUrl, {
      method: "PROPFIND",
      headers: { Depth: "1", ...authHeaders },
      signal: scanSignal,
    });
    if (!response.ok) throw new Error(`WebDAV returned ${response.status} (${dirUrl})`);
    const body = parser.parse(await response.text());
    const responses = body?.multistatus?.response ?? [];
    const list = (Array.isArray(responses) ? responses : [responses]) as Array<Record<string, unknown>>;
    const children: URL[] = [];
    for (const item of list) {
      throwIfAborted(signal);
      const href = String(item.href || "");
      if (!href) continue;
      const child = new URL(href, dirUrl);
      if (child.origin !== dirUrl.origin) continue;
      const key = child.pathname.replace(/\/+$/, "");
      if (key === dirUrl.pathname.replace(/\/+$/, "") || seen.has(key)) continue;
      seen.add(key);
      const propstats = Array.isArray(item.propstat) ? item.propstat : [item.propstat];
      const propstat = (propstats as Array<Record<string, unknown>>).find((p) => String(p?.status || "").includes("200"));
      const prop = (propstat as any)?.prop || {};
      const resourceType = JSON.stringify(prop.resourcetype || "");
      if (resourceType.includes("collection")) {
        children.push(child);
      } else if (extensions.has(path.extname(child.pathname).toLowerCase())) {
        files.push({
          path: decodeURIComponent(child.pathname),
          size: Number(prop.getcontentlength || 0),
          modifiedAt: String(prop.getlastmodified || ""),
        });
        progress?.("discovering", files.length, 0);
      }
    }
    return children;
  }

  const url = new URL(source.base_path);
  progress?.("connecting", 0, 0);
  const seen = new Set<string>([url.pathname.replace(/\/+$/, "")]);
  const queue = [url];
  while (queue.length) {
    throwIfAborted(signal);
    const dir = queue.shift()!;
    queue.push(...await listCollection(dir, seen));
  }
  return files;
}

export async function scanSource(sourceId: number, signal?: AbortSignal, progress?: ScanProgress) {
  const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId) as Source;
  if (!source) throw new Error("Source not found");
  const files: MediaFile[] = [];
  if (source.type === "local") await walk(source.base_path, source.base_path, files, signal, progress);
  else files.push(...await webdavList(source, signal, progress));
  throwIfAborted(signal);
  progress?.("indexing", files.length, 0);
  const insert = db.prepare(`INSERT INTO media (source_id,path,title,kind,season,episode,size,modified_at,available) VALUES (@sourceId,@path,@title,@kind,@season,@episode,@size,@modifiedAt,1) ON CONFLICT(source_id,path) DO UPDATE SET title=@title, kind=@kind, season=@season, episode=@episode, size=@size, modified_at=@modifiedAt, available=1`);
  const prepared = [] as Array<MediaFile & { sourceId: number; title: string; kind: string; season: number | null; episode: number | null }>;
  for (let index = 0; index < files.length; index++) {
    throwIfAborted(signal);
    const file = files[index];
    const parsed = parseTitle(file.path);
    prepared.push({ ...file, sourceId, title: parsed.title, kind: parsed.season ? "show" : "movie", season: parsed.season, episode: parsed.episode });
    progress?.("indexing", files.length, index + 1);
    if (index % 50 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throwIfAborted(signal);
  // Incremental: upsert scanned files, then mark anything not seen this scan
  // as unavailable (deleted from source). Previously this was a full rebuild
  // that first set available=0 for every row, which caused a brief window
  // where the library appeared empty and broke foreign-key cascades.
  const transaction = db.transaction((items: typeof prepared) => {
    for (const file of items) insert.run(file);
    const seen = new Set(items.map((f) => f.path));
    const existing = db.prepare("SELECT path FROM media WHERE source_id=? AND available=1").all(sourceId) as Array<{ path: string }>;
    const missing = existing.filter((row) => !seen.has(row.path)).map((row) => row.path);
    if (missing.length) {
      const mark = db.prepare("UPDATE media SET available=0 WHERE source_id=? AND path=?");
      for (const p of missing) mark.run(sourceId, p);
    }
    db.prepare("UPDATE sources SET last_scan_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?").run(sourceId);
  });
  transaction(prepared);
  return files.length;
}

export async function probe(file: string, signal?: AbortSignal) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("已取消", "AbortError"));
    const child = spawn(config.ffprobe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file]);
    let output = ""; let error = "";
    child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { error += data; });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("ffprobe 超时")); }, 30000);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} reject(new DOMException("已取消", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new Error(error || err.message || "ffprobe 启动失败")); });
    child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error || "ffprobe failed")); });
  });
}

export function sourceFile(source: Source, relativePath: string) {
  return source.type === "local" ? path.join(source.base_path, relativePath) : new URL(relativePath, source.base_path).toString();
}

export function webdavHeaders(source: Source): Record<string, string> {
  return source.username ? { Authorization: `Basic ${Buffer.from(`${source.username}:${decrypt(source.secret)}`).toString("base64")}` } : {};
}

// Builds the input ffmpeg/ffprobe should read: a local path, or the WebDAV URL
// with credentials embedded so no header has to be passed on the command line.
export function mediaInputUrl(source: Source, mediaPath: string): string {
  if (source.type === "local") return path.join(source.base_path, mediaPath);
  const url = sourceFile(source, mediaPath);
  if (!source.username || !source.secret) return url;
  const decoded = Buffer.from(`${source.username}:${decrypt(source.secret)}`).toString("utf8");
  const u = new URL(url);
  u.username = encodeURIComponent(decoded.split(":")[0]);
  u.password = encodeURIComponent(decoded.slice(decoded.indexOf(":") + 1));
  return u.toString();
}

// Serves a WebDAV file through a localhost proxy that injects the credentials
// per request, so the ffmpeg/ffprobe command line never carries the username
// or password (URL-embedded credentials would leak via /proc/<pid>/cmdline).
export type CredentialProxy = { url: string; release: () => void };

// Reused credential proxies, keyed by `${sourceId}:${mediaPath}`. A proxy lives
// for the lifetime of the media being watched: every transcode restart (seek)
// grabs the same proxy instead of opening a fresh HTTP connection to the drive.
// Each ffmpeg holds one reference; the proxy closes when the last reference is
// released and the idle grace elapses. This is the key to "seek without
// re-arming the connection" — Jellyfin's LiveStream model.
type ProxyPoolEntry = {
  url: string;
  refs: number;
  close: () => void;
  idleTimer?: NodeJS.Timeout;
};
const proxyPool = new Map<string, ProxyPoolEntry>();
const PROXY_IDLE_TTL = 2 * 60 * 1000; // close an unreferenced proxy after 2 min

async function startCredentialProxy(source: Source, mediaPath: string): Promise<{ url: string; close: () => void }> {
  const upstream = sourceFile(source, mediaPath);
  if (source.type === "local") return { url: upstream, close: () => {} };
  const auth = webdavHeaders(source);
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    const headers: Record<string, string> = { ...auth };
    if (req.headers.range) headers.Range = String(req.headers.range);
    fetch(upstream, { method: "GET", headers })
      .then(async (up) => {
        const out: Record<string, string> = {};
        for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
          const value = up.headers.get(key);
          if (value) out[key] = value;
        }
        res.writeHead(up.status, out);
        if (up.body) {
          const reader = up.body.getReader();
          // Stop reading the upstream the moment the downstream (ffmpeg) goes
          // away. Without this, an aborted transcode keeps pulling data from
          // the drive until the whole file is drained - burning drive traffic
          // and deepening rate limits for a session nobody is watching.
          const onAbort = () => { try { reader.cancel().catch(() => {}); } catch {} };
          res.on("close", onAbort);
          // Drain-wait with full listener cleanup so repeated backpressure does
          // not leak `close`/`drain` listeners on the downstream response.
          const waitForDrain = () => new Promise<void>((resolve) => {
            const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
            res.on("drain", done);
            res.on("close", done);
          });
          try {
            while (true) {
              if (res.destroyed || res.writableEnded) break;
              const { done, value } = await reader.read();
              if (done) break;
              if (value && !res.write(Buffer.from(value))) await waitForDrain();
            }
          } catch {} // downstream cancelled; ignore.
          res.off("close", onAbort);
        }
        res.end();
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const parsed = new URL(upstream);
  return { url: `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, close: () => server.close() };
}

// Acquire a shared credential proxy for a media file. Local sources return a
// no-op proxy (the local path is used directly, no localhost hop needed).
export async function acquireCredentialProxy(source: Source, mediaPath: string): Promise<CredentialProxy> {
  const upstream = sourceFile(source, mediaPath);
  if (source.type === "local") return { url: upstream, release: () => {} };
  const key = `${source.id}:${mediaPath}`;
  const existing = proxyPool.get(key);
  if (existing) {
    existing.refs++;
    if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = undefined; }
    return { url: existing.url, release: () => releaseCredentialProxy(key) };
  }
  const created = await startCredentialProxy(source, mediaPath);
  proxyPool.set(key, { url: created.url, refs: 1, close: created.close });
  return { url: created.url, release: () => releaseCredentialProxy(key) };
}

function releaseCredentialProxy(key: string) {
  const entry = proxyPool.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const current = proxyPool.get(key);
      if (current && current.refs === 0) {
        proxyPool.delete(key);
        current.close();
      }
    }, PROXY_IDLE_TTL);
    entry.idleTimer.unref?.();
  }
}

// Simple one-shot proxy for short operations (probe): acquire, use, release.
export async function withCredentialProxy<T>(source: Source, mediaPath: string, fn: (url: string) => Promise<T>): Promise<T> {
  const proxy = await acquireCredentialProxy(source, mediaPath);
  try {
    return await fn(proxy.url);
  } finally {
    proxy.release();
  }
}

// Stored paths mix separators: local scans keep the OS separator (backslashes
// on Windows), WebDAV scans store URL pathnames. Normalize to "/" for the
// directory math below; on-disk operations go through path.join, which accepts
// either separator.
function toPosix(p: string) {
  return p.replace(/\\+/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

// Deepest "/"-separated directory containing every given file path.
// "" means the files sit directly in the source root.
function commonParentDir(filePaths: string[]): string {
  let segments = filePaths[0] ? filePaths[0].split("/").slice(0, -1) : [];
  for (const filePath of filePaths.slice(1)) {
    const parts = filePath.split("/").slice(0, -1);
    let i = 0;
    while (i < segments.length && i < parts.length && segments[i] === parts[i]) i++;
    segments = segments.slice(0, i);
  }
  return segments.join("/");
}

function isInsideDir(dir: string, filePath: string) {
  return dir === "" || filePath.startsWith(`${dir}/`);
}

export type WorkDeletion = { files: number; folders: string[] };

// Deletes a work together with its files. The folder removed is the topmost
// directory (walking up from the files' common parent) that contains no media
// of any OTHER work — that boundary is the series folder, so its posters/nfos
// go with it. When the folder is shared with another work (flat layouts), the
// work's files are deleted one by one and the folder stays. DB rows are only
// removed after every file deletion succeeded, so a failed run can be retried.
export async function deleteWorkEntirely(workId: number): Promise<WorkDeletion> {
  const work = db.prepare("SELECT * FROM works WHERE id=?").get(workId) as any;
  if (!work) throw new Error("作品不存在");
  const rows = db.prepare("SELECT m.*, s.type AS source_type, s.base_path, s.username, s.secret FROM media m JOIN sources s ON s.id=m.source_id WHERE m.work_id=?").all(workId) as any[];
  const folders: string[] = [];
  let files = 0;
  const failures: string[] = [];
  for (const sourceRow of new Map(rows.map((row) => [row.source_id, row])).values()) {
    const source = { type: sourceRow.source_type, base_path: sourceRow.base_path, username: sourceRow.username, secret: sourceRow.secret } as Source;
    const own = rows.filter((row) => row.source_id === sourceRow.source_id).map((row) => toPosix(row.path));
    if (!own.length) continue;
    const others = (db.prepare("SELECT path FROM media WHERE source_id=? AND work_id IS NOT ?").all(sourceRow.source_id, workId) as Array<{ path: string }>)
      .map((row) => toPosix(row.path));
    const deleteOne = async (relPath: string) => {
      if (source.type === "local") {
        await fs.unlink(path.join(source.base_path, relPath)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        const response = await fetch(sourceFile(source, relPath), { method: "DELETE", headers: webdavHeaders(source) });
        if (!response.ok && response.status !== 404) throw new Error(`WebDAV 删除失败 (${response.status})`);
      }
    };
    let dir = commonParentDir(own);
    // "" = the files sit in the source root itself; the root is never removed
    // as a folder (it belongs to the source config), so delete files directly.
    if (dir === "" || others.some((filePath) => isInsideDir(dir, filePath))) {
      for (const relPath of own) {
        try {
          await deleteOne(relPath);
          files++;
        } catch (error) {
          failures.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      continue;
    }
    // Walk up while the parent still contains only this work's media. The
    // source root ("") is never removed itself — it belongs to the source
    // config and may hold unrelated non-media files.
    while (dir) {
      const slash = dir.lastIndexOf("/");
      const parent = slash === -1 ? "" : dir.slice(0, slash);
      if (parent === "" || others.some((filePath) => isInsideDir(parent, filePath))) break;
      dir = parent;
    }
    try {
      if (source.type === "local") {
        await fs.rm(path.join(source.base_path, dir), { recursive: true, force: true });
      } else {
        const response = await fetch(sourceFile(source, `${dir}/`), { method: "DELETE", headers: webdavHeaders(source) });
        if (!response.ok && response.status !== 404) throw new Error(`WebDAV 删除失败 (${response.status})`);
      }
      folders.push(dir);
      files += own.length;
    } catch {
      // Folder removal failed: fall back to per-file deletion so whatever can
      // be removed still is.
      for (const relPath of own) {
        try {
          await deleteOne(relPath);
          files++;
        } catch (error) {
          failures.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  if (failures.length) throw new Error(`部分文件删除失败，已保留记录，可重试：${failures.slice(0, 3).join("；")}`);
  const removeWork = db.transaction(() => {
    db.prepare("DELETE FROM progress WHERE media_id IN (SELECT id FROM media WHERE work_id=?)").run(workId);
    db.prepare("DELETE FROM media WHERE work_id=?").run(workId);
    db.prepare("DELETE FROM works WHERE id=?").run(workId);
  });
  removeWork();
  for (const poster of [work.poster_path, work.backdrop_path]) {
    if (poster) await fs.rm(path.join(config.dataDir, "posters", path.basename(String(poster))), { force: true }).catch(() => {});
  }
  return { files, folders };
}
