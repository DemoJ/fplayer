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
  const transaction = db.transaction((items: typeof prepared) => {
    db.prepare("UPDATE media SET available=0 WHERE source_id=?").run(sourceId);
    for (const file of items) insert.run(file);
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
// The proxy is closed when the caller is done (fn resolves or rejects).
export async function withCredentialProxy<T>(source: Source, mediaPath: string, fn: (url: string) => Promise<T>): Promise<T> {
  const proxy = await startCredentialProxy(source, mediaPath);
  try {
    return await fn(proxy.url);
  } finally {
    proxy.close();
  }
}

export async function startCredentialProxy(source: Source, mediaPath: string): Promise<{ url: string; close: () => void }> {
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
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && !res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
          }
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
