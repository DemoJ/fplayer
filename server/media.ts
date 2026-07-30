import fs from "node:fs/promises";
import path from "node:path";
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
  const current = source.base_path;
  const url = new URL(current);
  progress?.("connecting", 0, 0);
  const response = await fetch(url, {
    method: "PROPFIND",
    headers: { Depth: "infinity", ...(source.username ? { Authorization: `Basic ${Buffer.from(`${source.username}:${decrypt(source.secret)}`).toString("base64")}` } : {}) },
    signal,
  });
  if (!response.ok) throw new Error(`WebDAV returned ${response.status}`);
  const body = parser.parse(await response.text());
  const responses = body?.multistatus?.response ?? [];
  const list = (Array.isArray(responses) ? responses : [responses]) as Array<Record<string, unknown>>;
  const files: MediaFile[] = [];
  for (const item of list) {
    throwIfAborted(signal);
    const href = String(item.href || "");
    const propstat = Array.isArray(item.propstat) ? item.propstat[0] : item.propstat;
    const prop = (propstat as any)?.prop || {};
    const resourceType = JSON.stringify(prop.resourcetype || "");
    if (!resourceType.includes("collection") && extensions.has(path.extname(href).toLowerCase())) {
      files.push({ path: decodeURIComponent(new URL(href, url).pathname), size: Number(prop.getcontentlength || 0), modifiedAt: String(prop.getlastmodified || "") });
      progress?.("discovering", files.length, 0);
    }
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
