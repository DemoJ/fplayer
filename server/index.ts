import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import { db } from "./db.js";
import { config } from "./config.js";
import { encrypt, hashPassword, hashToken, newSessionToken, signTranscode, verifyPassword, verifyTranscodeSig } from "./security.js";
import { mediaInputUrl, probe, sourceFile, webdavHeaders } from "./media.js";
import { activeCount, destroy, ensureDir, fileExists, get, maxConcurrent, owns, register, sweepStaleDirectories } from "./transcodes.js";
import { startScan, stopScan } from "./scans.js";
import { rebuildCatalog } from "./catalog.js";
import { metadataStatus, startMetadataRefresh, stopMetadataRefresh, checkDoubanLogin, refreshWorkMetadata } from "./metadata.js";
import { getDoubanSettings, saveDoubanSettings } from "./douban.js";
import { getTranscodeAcceleration, isTranscodeQuality, transcodeArgs, type TranscodeQuality } from "./ffmpeg.js";
import type { AuthRequest, Source } from "./types.js";

const app = express(); app.use(express.json());
app.use(express.static(path.resolve("dist")));
const publicUser = (user: any) => ({ id: user.id, username: user.username, role: user.role });
function auth(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "") || (typeof req.query.token === "string" ? req.query.token : undefined);
  if (!token) return res.status(401).json({ error: "请先登录" });
  const session = db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP").get(hashToken(token)) as any;
  if (!session) return res.status(401).json({ error: "登录已过期" }); req.user = publicUser(session); next();
}
const admin = (req: AuthRequest, res: express.Response, next: express.NextFunction) => req.user?.role === "admin" ? next() : res.status(403).json({ error: "需要管理员权限" });

app.get("/api/setup", (_req, res) => res.json({ initialized: Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get()) }));
app.post("/api/setup", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 8) return res.status(400).json({ error: "用户名不能为空，密码至少 8 位" });
  // Atomically guard against concurrent setup creating multiple admins.
  const result = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) return null;
    return db.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)").run(username, hashPassword(password));
  })();
  if (!result) return res.status(409).json({ error: "已完成初始化" });
  res.json({ user: { id: result.lastInsertRowid, username, role: "admin" } });
});
app.post("/api/login", (req, res) => { const user = db.prepare("SELECT * FROM users WHERE username=?").get(req.body.username) as any; if (!user || !verifyPassword(req.body.password || "", user.password_hash)) return res.status(401).json({ error: "用户名或密码错误" }); const token = newSessionToken(); db.prepare("INSERT INTO sessions VALUES(?,?,datetime('now','+30 days'))").run(hashToken(token), user.id); res.json({ token, user: publicUser(user) }); });
app.get("/api/me", auth, (req: AuthRequest, res) => res.json({ user: req.user }));
app.get("/api/sources", auth, (_req, res) => res.json(db.prepare("SELECT id,name,type,base_path,username,enabled,last_scan_at,last_error FROM sources ORDER BY id DESC").all()));
app.post("/api/sources", auth, admin, (req, res) => { const { name, type, basePath, username, password } = req.body; if (!name || !basePath || !["local", "webdav"].includes(type)) return res.status(400).json({ error: "媒体源参数不完整" }); const result = db.prepare("INSERT INTO sources(name,type,base_path,username,secret) VALUES(?,?,?,?,?)").run(name, type, basePath, username || null, password ? encrypt(password) : null); res.json({ id: result.lastInsertRowid }); });
app.put("/api/sources/:id", auth, admin, (req, res) => { const { name, type, basePath, username, password } = req.body; if (!name || !basePath || !["local", "webdav"].includes(type)) return res.status(400).json({ error: "媒体源参数不完整" }); const existing = db.prepare("SELECT * FROM sources WHERE id=?").get(req.params.id) as Source | undefined; if (!existing) return res.status(404).json({ error: "媒体源不存在" }); const secret = type === "local" ? null : password ? encrypt(password) : existing.secret; db.prepare("UPDATE sources SET name=?,type=?,base_path=?,username=?,secret=?,last_error=NULL WHERE id=?").run(name, type, basePath, type === "webdav" ? username || null : null, secret, req.params.id); res.json({ ok: true }); });
app.delete("/api/sources/:id", auth, admin, (req, res) => { const result = db.prepare("DELETE FROM sources WHERE id=?").run(req.params.id); if (!result.changes) return res.status(404).json({ error: "媒体源不存在" }); res.json({ ok: true }); });
app.post("/api/sources/:id/test", auth, admin, async (req, res) => { try { const source = db.prepare("SELECT * FROM sources WHERE id=?").get(req.params.id) as Source; if (source.type === "local") await fs.access(source.base_path); else { const response = await fetch(source.base_path, { method: "PROPFIND", headers: { Depth: "0", ...webdavHeaders(source) } }); if (!response.ok) throw new Error(`WebDAV 返回 ${response.status}`); } res.json({ ok: true }); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "连接失败" }); } });
app.get("/api/scans", auth, (_req, res) => { const jobs = db.prepare("SELECT j.*,s.name source_name FROM scan_jobs j JOIN sources s ON s.id=j.source_id WHERE j.acknowledged=0 ORDER BY j.id DESC").all(); res.json(jobs); });
app.post("/api/sources/:id/scan", auth, admin, (req, res) => { const source = db.prepare("SELECT id FROM sources WHERE id=?").get(req.params.id); if (!source) return res.status(404).json({ error: "媒体源不存在" }); res.status(202).json(startScan(Number(req.params.id))); });
app.post("/api/scans/:id/stop", auth, admin, (req, res) => stopScan(Number(req.params.id)) ? res.json({ ok: true }) : res.status(409).json({ error: "扫描任务不在运行中" }));
app.post("/api/scans/:id/acknowledge", auth, admin, (req, res) => { db.prepare("UPDATE scan_jobs SET acknowledged=1 WHERE id=?").run(req.params.id); res.json({ ok: true }); });
app.get("/api/metadata/status", auth, admin, (_req, res) => res.json(metadataStatus()));
app.post("/api/metadata/refresh", auth, admin, (_req, res) => res.status(202).json(startMetadataRefresh()));
app.post("/api/metadata/stop", auth, admin, (_req, res) => stopMetadataRefresh() ? res.json({ ok: true }) : res.status(409).json({ error: "匹配任务不在运行中" }));
app.get("/api/metadata/settings", auth, admin, (_req, res) => {
  const settings = getDoubanSettings();
  res.json({ cookies: settings.cookies, avoidRiskControl: settings.avoidRiskControl, hasCookie: Boolean(settings.cookies) });
});
app.put("/api/metadata/settings", auth, admin, (req, res) => {
  const next = saveDoubanSettings({
    cookies: typeof req.body?.cookies === "string" ? req.body.cookies : undefined,
    avoidRiskControl: typeof req.body?.avoidRiskControl === "boolean" ? req.body.avoidRiskControl : undefined,
  });
  res.json({ cookies: next.cookies, avoidRiskControl: next.avoidRiskControl, hasCookie: Boolean(next.cookies) });
});
app.post("/api/metadata/check-login", auth, admin, async (_req, res) => {
  const info = await checkDoubanLogin();
  res.json(info);
});
app.post("/api/works/:id/metadata/refresh", auth, admin, async (req, res) => {
  try {
    res.json({ ok: true, work: await refreshWorkMetadata(Number(req.params.id)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "重新刮削失败" });
  }
});
app.get("/api/posters/:file", auth, (req, res) => res.sendFile(path.join(config.dataDir, "posters", path.basename(String(req.params.file)))));
app.get("/api/media", auth, (req: AuthRequest, res) => { const q = String(req.query.q || ""); const kind = String(req.query.kind || ""); const rows = db.prepare(`SELECT m.*, p.position, p.duration AS progress_duration, p.completed FROM media m LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE m.available=1 AND m.title LIKE ? AND (?='' OR m.kind=?) ORDER BY m.title COLLATE NOCASE`).all(req.user!.id, `%${q}%`, kind, kind); res.json(rows); });
app.get("/api/continue", auth, (req: AuthRequest, res) => {
  const limit = Math.min(24, Math.max(1, Number(req.query.limit) || 12));
  const rows = db.prepare(`
    SELECT m.*, p.position, p.duration AS progress_duration, p.completed, p.updated_at AS last_watched_at, s.name AS source_name, w.poster_path AS work_poster
    FROM progress p
    JOIN media m ON m.id = p.media_id AND m.available = 1
    JOIN sources s ON s.id = m.source_id
    LEFT JOIN works w ON w.id = m.work_id
    WHERE p.user_id = ? AND p.completed = 0 AND p.position > 5
    ORDER BY p.updated_at DESC
    LIMIT ?
  `).all(req.user!.id, limit);
  res.json(rows);
});
app.get("/api/up-next", auth, (req: AuthRequest, res) => {
  const limit = Math.min(24, Math.max(1, Number(req.query.limit) || 10));
  // For every show, take the most recently completed episode, then find the
  // next episode in the same work. Only include it while it hasn't been started
  // yet (position <= 5 keeps it out of /continue, so it never shows twice).
  const rows = db.prepare(`
    WITH latest AS (
      SELECT m.work_id, m.season AS s, m.episode AS e, p.updated_at,
             ROW_NUMBER() OVER (PARTITION BY m.work_id ORDER BY p.updated_at DESC) AS rn
      FROM progress p
      JOIN media m ON m.id = p.media_id
      WHERE p.user_id = ? AND p.completed = 1 AND m.work_id IS NOT NULL
        AND m.season IS NOT NULL AND m.episode IS NOT NULL
    ),
    picked AS (SELECT work_id, s, e, updated_at FROM latest WHERE rn = 1),
    pairs AS (
      SELECT m.work_id, m.season AS s, m.episode AS e
      FROM media m
      WHERE m.available = 1 AND m.season IS NOT NULL AND m.episode IS NOT NULL
      GROUP BY m.work_id, m.season, m.episode
    ),
    next_pair AS (
      SELECT p.work_id, pr.s AS ns, pr.e AS ne,
             ROW_NUMBER() OVER (PARTITION BY p.work_id ORDER BY pr.s, pr.e) AS rn
      FROM picked p
      JOIN pairs pr ON pr.work_id = p.work_id AND (pr.s > p.s OR (pr.s = p.s AND pr.e > p.e))
    ),
    np AS (SELECT work_id, ns, ne FROM next_pair WHERE rn = 1),
    target AS (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.work_id, m.season, m.episode ORDER BY m.size DESC, m.id) AS rn
      FROM media m
      JOIN np ON np.work_id = m.work_id AND np.ns = m.season AND np.ne = m.episode
      WHERE m.available = 1
    )
    SELECT t.id, t.title, t.kind, t.season, t.episode, t.duration, t.size, t.container, t.work_id,
           w.title AS work_title, w.poster_path AS work_poster, s.name AS source_name,
           p.s AS from_season, p.e AS from_episode
    FROM target t
    JOIN works w ON w.id = t.work_id
    JOIN sources s ON s.id = t.source_id
    JOIN picked p ON p.work_id = t.work_id
    LEFT JOIN progress nextp ON nextp.media_id = t.id AND nextp.user_id = ?
    WHERE t.rn = 1 AND (nextp.position IS NULL OR nextp.position <= 5)
    ORDER BY p.updated_at DESC
    LIMIT ?
  `).all(req.user!.id, req.user!.id, limit);
  res.json(rows);
});
app.get("/api/recent", auth, (req: AuthRequest, res) => {
  const limit = Math.min(24, Math.max(1, Number(req.query.limit) || 10));
  const rows = db.prepare(`
    SELECT m.*, p.position, p.duration AS progress_duration, p.completed, s.name AS source_name, w.poster_path AS work_poster
    FROM media m
    JOIN sources s ON s.id = m.source_id
    LEFT JOIN progress p ON p.media_id = m.id AND p.user_id = ?
    LEFT JOIN works w ON w.id = m.work_id
    WHERE m.available = 1
    ORDER BY m.id DESC
    LIMIT ?
  `).all(req.user!.id, limit);
  res.json(rows);
});
function sourceRootPath(source: { type: string; base_path: string }) {
  // Local scan stores paths relative to base_path; WebDAV stores absolute URL pathnames.
  if (source.type !== "webdav") return "";
  try {
    const pathname = decodeURIComponent(new URL(source.base_path).pathname || "/");
    return pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "";
  } catch {
    try {
      return decodeURIComponent(String(source.base_path || "")).replace(/\/+/g, "/").replace(/\/$/, "");
    } catch {
      return String(source.base_path || "").replace(/\/+/g, "/").replace(/\/$/, "");
    }
  }
}

app.get("/api/browse", auth, (req: AuthRequest, res) => {
  const sourceId = Number(req.query.sourceId || 0);
  const requested = String(req.query.path || "").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!sourceId) {
    const sources = db.prepare(`
      SELECT s.id, s.name, s.type, s.base_path, COUNT(m.id) AS file_count
      FROM sources s
      LEFT JOIN media m ON m.source_id = s.id AND m.available = 1
      GROUP BY s.id
      ORDER BY s.name COLLATE NOCASE
    `).all();
    return res.json({ level: "sources", path: "", crumbs: [], sources, folders: [], files: [] });
  }
  const source = db.prepare("SELECT id,name,type,base_path FROM sources WHERE id=?").get(sourceId) as { id: number; name: string; type: string; base_path: string } | undefined;
  if (!source) return res.status(404).json({ error: "媒体源不存在" });
  const root = sourceRootPath(source);
  // Browse relative to the configured source root, not filesystem root.
  const relative = requested.startsWith(root + "/") || requested === root
    ? requested.slice(root.length).replace(/^\/+/, "")
    : requested.replace(/^\/+/, "");
  const prefix = relative ? `${root}/${relative}`.replace(/\/+/g, "/") : root;
  const rows = db.prepare(`
    SELECT m.id, m.path, m.title, m.kind, m.season, m.episode, m.size, m.container, m.work_id,
           p.position, p.duration AS progress_duration, p.completed
    FROM media m
    LEFT JOIN progress p ON p.media_id = m.id AND p.user_id = ?
    WHERE m.source_id = ? AND m.available = 1
    ORDER BY m.path COLLATE NOCASE
  `).all(req.user!.id, sourceId) as Array<any>;
  const folderMap = new Map<string, number>();
  const files: any[] = [];
  const base = prefix ? `${prefix}/` : "/";
  for (const row of rows) {
    const full = String(row.path || "").replace(/\/+/g, "/");
    if (prefix && !full.startsWith(base) && full !== prefix) continue;
    const rest = prefix ? full.slice(base.length) : full.replace(/^\/+/, "");
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ ...row, name: rest });
    } else {
      const folder = rest.slice(0, slash);
      folderMap.set(folder, (folderMap.get(folder) || 0) + 1);
    }
  }
  const folders = [...folderMap.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh")).map(([name, count]) => ({
    name,
    path: relative ? `${relative}/${name}` : name,
    file_count: count,
  }));
  const crumbs = [{ name: source.name, path: "" }, ...relative.split("/").filter(Boolean).map((part, index, all) => ({
    name: part,
    path: all.slice(0, index + 1).join("/"),
  }))];
  res.json({ level: "folder", source, path: relative, root, crumbs, sources: [], folders, files });
});

app.get("/api/works", auth, (req: AuthRequest, res) => { const q = String(req.query.q || ""); const kind = String(req.query.kind || ""); const rows = db.prepare(`SELECT w.*,COUNT(DISTINCT m.id) AS file_count,COUNT(DISTINCT CASE WHEN m.season IS NOT NULL THEN m.season END) AS season_count,MAX(p.updated_at) AS last_watched_at FROM works w LEFT JOIN media m ON m.work_id=w.id AND m.available=1 LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE w.title LIKE ? AND (?='' OR w.kind=?) GROUP BY w.id ORDER BY w.title COLLATE NOCASE`).all(req.user!.id, `%${q}%`, kind, kind); res.json(rows); });
app.get("/api/works/:id", auth, (req, res) => { const work = db.prepare("SELECT * FROM works WHERE id=?").get(req.params.id); if (!work) return res.status(404).json({ error: "作品不存在" }); const media = db.prepare("SELECT m.*,p.position,p.duration AS progress_duration,p.completed FROM media m LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE m.work_id=? AND m.available=1 ORDER BY m.season,m.episode,m.size DESC").all((req as AuthRequest).user!.id, req.params.id); res.json({ work, media }); });
app.get("/api/media/:id", auth, (req: AuthRequest, res) => { const row = db.prepare("SELECT m.*,p.position,p.duration AS progress_duration,p.completed,s.name source_name FROM media m JOIN sources s ON s.id=m.source_id LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE m.id=?").get(req.user!.id, req.params.id); row ? res.json(row) : res.status(404).json({ error: "媒体不存在" }); });
// Probes a media file (ffprobe reading the source directly) and caches the
// codec info in the media row. The player uses this to decide whether the
// browser can play the file natively or whether it must go through
// transcoding, avoiding a full download of the original file first.
app.post("/api/media/:id/probe", auth, openMedia, async (req: AuthRequest, res) => {
  const media = (req as any).media as Source & { media_path: string };
  try {
    const info = await probe(mediaInputUrl(media, media.media_path));
    const video = (info.streams || []).find((stream: any) => stream.codec_type === "video");
    const audio = (info.streams || []).find((stream: any) => stream.codec_type === "audio");
    db.prepare("UPDATE media SET duration=?,container=?,video_codec=?,audio_codec=? WHERE id=?").run(
      Number(info.format?.duration) || null,
      String(info.format?.format_name || "").split(",")[0] || null,
      video?.codec_name || null,
      audio?.codec_name || null,
      media.id,
    );
    const updated = db.prepare("SELECT m.*,p.position,p.duration AS progress_duration,p.completed,s.name source_name FROM media m JOIN sources s ON s.id=m.source_id LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE m.id=?").get(req.user!.id, media.id);
    res.json({ media: updated });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "媒体探测失败" });
  }
});
app.put("/api/media/:id", auth, admin, async (req, res) => {
  const media = db.prepare("SELECT m.*,s.type,s.base_path,s.username,s.secret FROM media m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.available=1").get(req.params.id) as any;
  if (!media) return res.status(404).json({ error: "媒体不存在" });
  const requestedName = typeof req.body?.name === "string" ? req.body.name.trim() : path.basename(media.path);
  const name = path.basename(requestedName);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return res.status(400).json({ error: "文件名不合法" });
  const title = typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim() : media.title;
  const season = req.body?.season === null || req.body?.season === "" ? null : Number(req.body?.season);
  const episode = req.body?.episode === null || req.body?.episode === "" ? null : Number(req.body?.episode);
  if ((season !== null && (!Number.isInteger(season) || season < 1)) || (episode !== null && (!Number.isInteger(episode) || episode < 1))) return res.status(400).json({ error: "季数和集数必须是正整数" });
  const oldName = path.basename(media.path);
  const newPath = name === oldName ? media.path : `${media.path.slice(0, media.path.length - oldName.length)}${name}`;
  try {
    if (newPath !== media.path) {
      if (media.type === "local") {
        await fs.rename(path.join(media.base_path, media.path), path.join(media.base_path, newPath));
      } else {
        const source = { type: media.type, base_path: media.base_path, username: media.username, secret: media.secret } as Source;
        const from = sourceFile(source, media.path);
        const to = sourceFile(source, newPath);
        const response = await fetch(from, { method: "MOVE", headers: { Destination: to, ...webdavHeaders(source) } });
        if (!response.ok) throw new Error(`WebDAV 重命名失败 (${response.status})`);
      }
    }
    db.prepare("UPDATE media SET path=?,title=?,season=?,episode=? WHERE id=?").run(newPath, title, season, episode, media.id);
    res.json({ ok: true, media: db.prepare("SELECT * FROM media WHERE id=?").get(media.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "修改文件失败" });
  }
});
app.delete("/api/media/:id", auth, admin, async (req, res) => {
  const media = db.prepare("SELECT m.*,s.type,s.base_path,s.username,s.secret FROM media m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.available=1").get(req.params.id) as any;
  if (!media) return res.status(404).json({ error: "媒体不存在" });
  try {
    if (media.type === "local") {
      await fs.unlink(path.join(media.base_path, media.path));
    } else {
      const source = { type: media.type, base_path: media.base_path, username: media.username, secret: media.secret } as Source;
      const response = await fetch(sourceFile(source, media.path), { method: "DELETE", headers: webdavHeaders(source) });
      if (!response.ok && response.status !== 404) throw new Error(`WebDAV 删除失败 (${response.status})`);
    }
    db.prepare("DELETE FROM media WHERE id=?").run(media.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除文件失败" });
  }
});
app.put("/api/media/:id/progress", auth, (req: AuthRequest, res) => {
  const position = Math.max(0, Number(req.body?.position) || 0);
  const duration = Math.max(0, Number(req.body?.duration) || 0);
  const requestedCompleted = Boolean(req.body?.completed);
  // Server-side completion guard: only when the position is essentially at the
  // very end (last 15s). The client is the source of truth for completion —
  // it knows whether the end was reached by watching or by a drag/seek — so
  // the loose "last 90s or 5%" fallback would re-mark dragged positions done.
  const nearEnd = duration > 0 && position >= duration - 15;
  const completed = requestedCompleted || nearEnd ? 1 : 0;
  db.prepare("INSERT INTO progress(user_id,media_id,position,duration,completed) VALUES(?,?,?,?,?) ON CONFLICT(user_id,media_id) DO UPDATE SET position=excluded.position,duration=excluded.duration,completed=excluded.completed,updated_at=CURRENT_TIMESTAMP").run(req.user!.id, req.params.id, position, duration, completed); res.json({ ok: true });
});
async function openMedia(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  // Select source fields explicitly: `s.*` would overwrite m.id with the
  // source id, breaking every downstream use of media.id.
  const media = db.prepare("SELECT m.id, m.path media_path, m.size media_size, m.source_id, s.type, s.base_path, s.username, s.secret FROM media m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.available=1").get(req.params.id) as any;
  if (!media) return res.status(404).end(); (req as any).media = media; next();
}
app.get("/api/media/:id/file", auth, openMedia, async (req: AuthRequest, res) => { const media = (req as any).media as Source & { media_path: string; media_size: number }; const url = sourceFile(media, media.media_path); const range = req.headers.range; const headers: any = { ...webdavHeaders(media) }; if (range) headers.Range = range; const upstream = media.type === "local" ? null : await fetch(url, { headers }); if (media.type === "local") { res.setHeader("Accept-Ranges", "bytes"); res.sendFile(path.resolve(url)); return; } if (!upstream?.ok && upstream?.status !== 206) { if (upstream?.status === 416 || upstream?.status === 429) { const body = await upstream.text().catch(() => ""); if (upstream.status === 429 || body.includes("429") || body.toLowerCase().includes("too many")) return res.status(429).json({ error: "网盘请求过于频繁，请稍后重试" }); } return res.status(upstream?.status || 502).json({ error: "无法读取媒体文件" }); }   res.status(upstream.status); ["content-type", "content-length", "content-range", "accept-ranges"].forEach((header) => { const value = upstream.headers.get(header); if (value) res.setHeader(header, value); }); res.setHeader("Content-Disposition", "inline"); // Close the upstream connection when the client disconnects so we don't
  // keep downloading from the WebDAV source after the browser stops reading.
  // Note: cancel() returns a rejected promise when the stream is mid-read
  // (locked by the for-await loop) — the rejection must be swallowed or the
  // process dies from an unhandled rejection.
  const onClose = () => { try { upstream.body?.cancel().catch(() => {}); } catch {} }; res.on("close", onClose);
  // When the client disconnects mid-write, `drain` never fires and an await on
  // it alone would hang the request forever. Resolve on `close` as well.
  const waitForDrain = () => new Promise<void>((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
  try {
    if (upstream.body) for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await waitForDrain();
    }
  } catch {} // upstream cancelled on client disconnect; ignore.
  res.end(); });
app.post("/api/media/:id/transcode", auth, openMedia, async (req: AuthRequest, res) => {
  const media = (req as any).media as Source & { media_path: string };
  // Resume position: start transcoding from this offset in the source file so
  // a resumed episode becomes playable immediately instead of from the top.
  const start = Math.max(0, Number(req.body?.start) || 0);
  const quality: TranscodeQuality = isTranscodeQuality(String(req.body?.quality || "")) ? req.body.quality : "1080";
  if (activeCount() >= maxConcurrent()) return res.status(429).json({ error: "转码并发已满，请稍后再试" });
  const session = randomUUID();
  const outputDir = await ensureDir(session);
  const segFile = path.join(outputDir, "segment-%05d.ts");
  const playlistFile = path.join(outputDir, "index.m3u8");
  // Streaming HLS: keep a sliding window of segments, never finalize the playlist,
  // so large files start playing after the first segment instead of timing out.
  const acceleration = await getTranscodeAcceleration();
  // For WebDAV sources, let ffmpeg read the HTTP URL directly instead of piping
  // through Node.js. This avoids a redundant full-file download (the /file
  // endpoint may also be requested by the browser) and lets ffmpeg seek via
  // HTTP Range, which is far more efficient and avoids triggering upstream
  // rate limits from double-fetching large files.
  let ffmpegInput: string | undefined;
  let localStream: ReadableStream<Uint8Array> | null = null;
  const inputAbort = new AbortController();
  if (media.type === "webdav") {
    ffmpegInput = mediaInputUrl(media, media.media_path);
  } else {
    localStream = fsSync.createReadStream(mediaInputUrl(media, media.media_path)) as unknown as ReadableStream<Uint8Array>;
  }
  const args = transcodeArgs(acceleration, segFile, playlistFile, ffmpegInput, start, quality);
  const child = spawn(config.ffmpeg, args, { stdio: ffmpegInput ? ["ignore", "ignore", "pipe"] : ["pipe", "ignore", "pipe"] });
  let ffmpegError = ""; child.stderr?.on("data", (chunk) => { ffmpegError = (ffmpegError + chunk).slice(-4000); });
  if (localStream) {
    register(session, { child, outputDir, userId: req.user!.id, lastAccess: Date.now(), inputStream: localStream, inputAbort, exited: false });
    const nodeStream = localStream as any;
    nodeStream.pipe(child.stdin, { end: true });
    nodeStream.on("error", () => { try { child.stdin?.end(); } catch {} });
    child.stdin?.on("error", () => {});
  } else {
    register(session, { child, outputDir, userId: req.user!.id, lastAccess: Date.now(), inputStream: null, inputAbort, exited: false });
  }
  child.on("close", (code) => {
    if (code && !fileExists(playlistFile)) fs.writeFile(path.join(outputDir, "error.txt"), ffmpegError).catch(() => {});
    // Normal finish (or session kill): finalize the playlist so the player
    // reaches a proper ended state instead of hanging on a live stream. With
    // -hls_list_size 0 all segments are kept, so the player can always fetch
    // its current position.
    fs.appendFile(playlistFile, "#EXT-X-ENDLIST\n").catch(() => {});
  });
  // If the client disconnects during start-up nothing is playable yet, so stop
  // ffmpeg immediately instead of letting the reaper reclaim it minutes later.
  // (After the playlist is ready the listener is removed below.)
  const onClientClose = () => destroy(session);
  res.on("close", onClientClose);
  const countSegments = async () => {
    try { return (await fs.readFile(playlistFile, "utf8")).match(/^segment-\d+\.ts/gm)?.length ?? 0; } catch { return 0; }
  };
  for (let attempt = 0; attempt < 300; attempt++) { // 30s start-up window
    if (res.destroyed || res.writableEnded) { destroy(session); return; }
    if (fileExists(playlistFile)) {
      // Pre-warm: a cold ffmpeg run (WebDAV connect + GPU init + first decode)
      // is slowest on the very first frames, so hand the stream over only after
      // a few segments exist. Otherwise the player burns through segment #1 and
      // stalls waiting for #2 — the "plays a few seconds, then buffers" hiccup.
      const warmDeadline = Date.now() + 5000;
      while (Date.now() < warmDeadline) {
        if (res.destroyed || res.writableEnded) { destroy(session); return; }
        if ((await countSegments()) >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      res.off("close", onClientClose);
      return res.json({ session, playlist: `/api/transcode/${session}/index.m3u8` });
    }
    if (fileExists(path.join(outputDir, "error.txt"))) { destroy(session); return res.status(500).json({ error: "FFmpeg 转码启动失败" }); }
    if (child.exitCode !== null || child.killed) { destroy(session); return res.status(500).json({ error: "FFmpeg 意外退出" }); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  destroy(session);
  res.status(504).json({ error: "转码启动超时" });
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Stops a running transcode session early (e.g. when the user switches
// quality), so its ffmpeg process stops hogging the GPU immediately.
app.delete("/api/transcode/:session", auth, (req: AuthRequest, res) => {
  const session = String(req.params.session);
  if (!UUID_RE.test(session)) return res.status(400).json({ error: "无效的转码会话" });
  if (!owns(session, req.user!.id)) return res.status(403).end();
  destroy(session);
  res.json({ ok: true });
});
// The player pings this while mounted so a paused stream is not reclaimed by
// the idle reaper: pausing stops HLS segment requests, which would otherwise
// freeze lastAccess and kill the ffmpeg process within the idle TTL.
app.get("/api/transcode/:session/keepalive", auth, (req: AuthRequest, res) => {
  const session = String(req.params.session);
  if (!UUID_RE.test(session)) return res.status(400).json({ error: "无效的转码会话" });
  if (!owns(session, req.user!.id)) return res.status(403).end();
  get(session);
  res.json({ ok: true });
});
app.get("/api/transcode/:session/:file", auth, async (req: AuthRequest, res) => {
  const session = String(req.params.session);
  if (!UUID_RE.test(session)) return res.status(400).json({ error: "无效的转码会话" });
  const file = path.basename(String(req.params.file));
  if (!file || file === "." || file === "..") return res.status(400).end();
  // Authorize: either the owner of the session, or a valid short-lived signature.
  const ownerOk = owns(session, req.user!.id);
  const sig = typeof req.query.sig === "string" ? req.query.sig : undefined;
  const sigOk = sig ? verifyTranscodeSig(session, file, sig) : false;
  if (!ownerOk && !sigOk) return res.status(403).end();
  get(session); // refresh lastAccess
  const full = path.join(config.dataDir, "transcodes", session, file);
  try {
    await fs.access(full);
    if (file.endsWith(".m3u8")) {
      // Rewrite segment URLs to carry a short-lived signature instead of the main
      // session token, so the token never lands in playlist/segment URLs or logs.
      const playlist = await fs.readFile(full, "utf8");
      const rewritten = playlist.replace(/^(segment-.*\.ts)$/gm, (_, seg) => `${seg}?sig=${signTranscode(session, seg)}`);
      return res.type("application/vnd.apple.mpegurl").send(rewritten);
    }
    res.type(path.extname(file));
    res.sendFile(full);
  } catch {
    // Segment not ready yet (streaming HLS): ask the client to retry shortly.
    if (file.endsWith(".ts")) return res.status(503).set("Retry-After", "1").end();
    res.status(404).end();
  }
});
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
rebuildCatalog();
void sweepStaleDirectories();
app.listen(config.port, () => console.log(`FPlayer listening on :${config.port}`));
