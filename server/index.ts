import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import { db } from "./db.js";
import { config } from "./config.js";
import { encrypt, hashPassword, hashToken, newSessionToken, signTranscode, verifyPassword, verifyTranscodeSig } from "./security.js";
import { mediaInputUrl, probe, sourceFile, acquireCredentialProxy, webdavHeaders, withCredentialProxy, deleteWorkEntirely, type CredentialProxy } from "./media.js";
import { activeCount, destroy, get, maxConcurrent, owns, register, activeSessionFor, producedSeq, withLock } from "./transcodes.js";
import { absSeq, blockHead, buildPlaylist, contiguousFrom, ensureCacheDir, fileExists, listSegments, readMeta, segSecFor, segmentFile, sweepCache, sweepStaleDirectories, touch, writeMeta, REMUX_SEGMENT_SECONDS, TRANSCODE_SEGMENT_SECONDS } from "./transcode-cache.js";
import { startScan, stopScan } from "./scans.js";
import { getAutoSyncSettings, restartAutoSync, saveAutoSyncSettings, startAutoSync } from "./sync.js";
import { rebuildCatalog } from "./catalog.js";
import { metadataStatus, startMetadataRefresh, stopMetadataRefresh, checkDoubanLogin, refreshWorkMetadata } from "./metadata.js";
import { getDoubanSettings, saveDoubanSettings } from "./douban.js";
import { getTranscodeAcceleration, isTranscodeQuality, isTranscodeMode, transcodeArgs, type TranscodeMode, type TranscodeQuality } from "./ffmpeg.js";
import { log } from "./log.js";
import type { AuthRequest, Source } from "./types.js";

const app = express(); app.use(express.json());
app.use(express.static(path.resolve("dist")));
// Baseline hardening headers. Referrer-Policy: no-referrer stops the session
// token from leaking to third parties through the Referer header.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
const publicUser = (user: any) => ({ id: user.id, username: user.username, role: user.role });
// Only the media stream endpoint may be reached with the token in the query
// string (a <video> element cannot set an Authorization header). Every other
// API refuses query tokens so a leaked URL token can only pull media files,
// never manage sources, metadata or settings.
const QUERY_TOKEN_PATHS = [/^\/api\/media\/\d+\/file$/];
function auth(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization?.replace("Bearer ", "");
  const query = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = header || (query && QUERY_TOKEN_PATHS.some((re) => re.test(req.path)) ? query : undefined);
  if (!token) return res.status(401).json({ error: "请先登录" });
  const session = db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP").get(hashToken(token)) as any;
  if (!session) return res.status(401).json({ error: "登录已过期" }); req.user = publicUser(session); next();
}
const admin = (req: AuthRequest, res: express.Response, next: express.NextFunction) => req.user?.role === "admin" ? next() : res.status(403).json({ error: "需要管理员权限" });
// Setup window: the admin account may only be created shortly after server
// start, before any user is claimed. Prevents account-claim hijacking on an
// exposed-but-uninitialized instance.
const setupWindowExpiresAt = Date.now() + config.setupWindowMs;
const setupAvailable = () => Date.now() <= setupWindowExpiresAt;
// Brute-force guard for login. In-memory, per IP+username: after 5 failed
// attempts the combination is locked for 15 minutes. Correct credentials are
// also rejected while locked so an attacker can't probe the real password.
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
function loginLockKey(req: express.Request, username: string) {
  return `${req.ip || "unknown"}:${username}`;
}
function loginLocked(key: string) {
  const entry = loginFailures.get(key);
  return Boolean(entry && entry.lockedUntil > Date.now());
}
function recordLoginFailure(key: string) {
  const entry = loginFailures.get(key) || { count: 0, lockedUntil: 0 };
  if (entry.count + 1 >= LOGIN_MAX_FAILURES) {
    entry.count = 0;
    entry.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  } else {
    entry.count += 1;
  }
  loginFailures.set(key, entry);
}

app.get("/api/setup", (_req, res) => {
  const initialized = Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get());
  // Expose the window so the client can disable the setup form once expired.
  res.json({ initialized, setupExpired: !initialized && !setupAvailable() });
});
app.post("/api/setup", (req, res) => {
  // Prevent account-claim hijacking: on an uninitialized instance exposed to
  // the internet, anyone could otherwise register themselves as admin first.
  if (!setupAvailable()) return res.status(403).json({ error: `初始化窗口已过期：请在服务启动后 ${Math.round(config.setupWindowMs / 60000)} 分钟内创建管理员。如需重新初始化，请删除数据目录后重启服务。` });
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
app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "");
  const key = loginLockKey(req, username);
  if (loginLocked(key)) return res.status(429).json({ error: "失败次数过多，请 15 分钟后再试" });
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username) as any;
  if (!user || !verifyPassword(req.body?.password || "", user.password_hash)) {
    recordLoginFailure(key);
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  loginFailures.delete(key);
  const token = newSessionToken();
  db.prepare("INSERT INTO sessions VALUES(?,?,datetime('now','+30 days'))").run(hashToken(token), user.id);
  res.json({ token, user: publicUser(user) });
});
app.post("/api/logout", auth, (req: AuthRequest, res) => {
  // Revoke the session server-side so a leaked token can't be reused.
  const token = req.headers.authorization?.replace("Bearer ", "") || (typeof req.query.token === "string" ? req.query.token : "");
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hashToken(token));
  res.json({ ok: true });
});
app.get("/api/me", auth, (req: AuthRequest, res) => res.json({ user: req.user }));
app.post("/api/me/password", auth, (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword) return res.status(400).json({ error: "请输入当前密码" });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "新密码至少 8 位" });
  if (currentPassword === newPassword) return res.status(400).json({ error: "新密码不能与当前密码相同" });
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user!.id) as any;
  if (!user || !verifyPassword(currentPassword, user.password_hash)) return res.status(403).json({ error: "当前密码不正确" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(newPassword), user.id);
  // Revoke the user's other sessions so a leaked one can't survive a password change.
  const token = req.headers.authorization?.replace("Bearer ", "") || "";
  if (token) db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(user.id, hashToken(token));
  res.json({ ok: true });
});
app.get("/api/sources", auth, (_req, res) => res.json(db.prepare("SELECT id,name,type,base_path,username,enabled,last_scan_at,last_error FROM sources ORDER BY id DESC").all()));
app.post("/api/sources", auth, admin, (req, res) => { const { name, type, basePath, username, password } = req.body; if (!name || !basePath || !["local", "webdav"].includes(type)) return res.status(400).json({ error: "媒体源参数不完整" }); const result = db.prepare("INSERT INTO sources(name,type,base_path,username,secret) VALUES(?,?,?,?,?)").run(name, type, basePath, username || null, password ? encrypt(password) : null); res.json({ id: result.lastInsertRowid }); });
app.put("/api/sources/:id", auth, admin, (req, res) => { const { name, type, basePath, username, password } = req.body; if (!name || !basePath || !["local", "webdav"].includes(type)) return res.status(400).json({ error: "媒体源参数不完整" }); const existing = db.prepare("SELECT * FROM sources WHERE id=?").get(req.params.id) as Source | undefined; if (!existing) return res.status(404).json({ error: "媒体源不存在" }); const secret = type === "local" ? null : password ? encrypt(password) : existing.secret; db.prepare("UPDATE sources SET name=?,type=?,base_path=?,username=?,secret=?,last_error=NULL WHERE id=?").run(name, type, basePath, type === "webdav" ? username || null : null, secret, req.params.id); res.json({ ok: true }); });
app.delete("/api/sources/:id", auth, admin, (req, res) => { const result = db.prepare("DELETE FROM sources WHERE id=?").run(req.params.id); if (!result.changes) return res.status(404).json({ error: "媒体源不存在" }); res.json({ ok: true }); });
app.post("/api/sources/:id/test", auth, admin, async (req, res) => { try { const source = db.prepare("SELECT * FROM sources WHERE id=?").get(req.params.id) as Source; if (source.type === "local") await fs.access(source.base_path); else { const response = await fetch(source.base_path, { method: "PROPFIND", headers: { Depth: "0", ...webdavHeaders(source) }, signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`WebDAV 返回 ${response.status}`); } res.json({ ok: true }); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "连接失败" }); } });
app.get("/api/scans", auth, (_req, res) => { const jobs = db.prepare("SELECT j.*,s.name source_name FROM scan_jobs j JOIN sources s ON s.id=j.source_id WHERE j.acknowledged=0 ORDER BY j.id DESC").all(); res.json(jobs); });
app.post("/api/sources/:id/scan", auth, admin, (req, res) => { const source = db.prepare("SELECT id FROM sources WHERE id=?").get(req.params.id); if (!source) return res.status(404).json({ error: "媒体源不存在" }); res.status(202).json(startScan(Number(req.params.id))); });
app.post("/api/scans/:id/stop", auth, admin, (req, res) => stopScan(Number(req.params.id)) ? res.json({ ok: true }) : res.status(409).json({ error: "扫描任务不在运行中" }));
app.post("/api/scans/:id/acknowledge", auth, admin, (req, res) => { db.prepare("UPDATE scan_jobs SET acknowledged=1 WHERE id=?").run(req.params.id); res.json({ ok: true }); });
// Acknowledge every finished job at once: the client calls this on page load so
// scans that finished while nobody was watching never toast retroactively.
app.post("/api/scans/acknowledge-finished", auth, admin, (_req, res) => { db.prepare("UPDATE scan_jobs SET acknowledged=1 WHERE acknowledged=0 AND status IN ('completed','failed','cancelled')").run(); res.json({ ok: true }); });

// Auto-sync settings: how often the server should run incremental scans
// to pick up new files added to WebDAV/local sources.
app.get("/api/settings/auto-sync", auth, (_req, res) => res.json(getAutoSyncSettings()));
app.put("/api/settings/auto-sync", auth, admin, (req, res) => {
  const { enabled, intervalMinutes } = req.body as { enabled?: boolean; intervalMinutes?: number };
  const settings = { enabled: enabled !== false, intervalMinutes: Math.max(1, Number(intervalMinutes) || 15) };
  saveAutoSyncSettings(settings);
  restartAutoSync();
  res.json(settings);
});
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
    JOIN media m ON m.id = p.media_id AND m.available=1
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
      WHERE m.available=1 AND m.season IS NOT NULL AND m.episode IS NOT NULL
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
      WHERE m.available=1
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
    WHERE m.available=1
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
      LEFT JOIN media m ON m.source_id = s.id AND m.available=1
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
    WHERE m.source_id = ? AND m.available=1
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

app.get("/api/works", auth, (req: AuthRequest, res) => {
  const q = String(req.query.q || "");
  const kind = String(req.query.kind || "");
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const totalRow = db.prepare("SELECT COUNT(*) AS count FROM works WHERE title LIKE ? AND (?='' OR kind=?)").get(`%${q}%`, kind, kind) as { count: number };
  const rows = db.prepare(`SELECT w.*,COUNT(DISTINCT m.id) AS file_count,COUNT(DISTINCT CASE WHEN m.season IS NOT NULL THEN m.season END) AS season_count,MAX(p.updated_at) AS last_watched_at FROM works w LEFT JOIN media m ON m.work_id=w.id AND m.available=1 LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE w.title LIKE ? AND (?='' OR w.kind=?) GROUP BY w.id ORDER BY w.title COLLATE NOCASE LIMIT ? OFFSET ?`).all(req.user!.id, `%${q}%`, kind, kind, limit, offset);
  res.json({ items: rows, total: totalRow.count });
});
app.get("/api/works/:id", auth, (req, res) => { const work = db.prepare("SELECT * FROM works WHERE id=?").get(req.params.id); if (!work) return res.status(404).json({ error: "作品不存在" }); const media = db.prepare("SELECT m.*,p.position,p.duration AS progress_duration,p.completed FROM media m LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE m.work_id=? AND m.available=1 ORDER BY m.season,m.episode,m.size DESC").all((req as AuthRequest).user!.id, req.params.id); res.json({ work, media }); });
// Whole-work deletion: removes the series/movie folder from the source (not
// just the DB entries), so the user does not have to confirm episode by
// episode. All deletions in this app are direct and unrecoverable.
app.delete("/api/works/:id", auth, admin, async (req, res) => {
  try {
    const result = await deleteWorkEntirely(Number(req.params.id));
    log("works", `deleted work=${req.params.id} files=${result.files} folders=${result.folders.join(",") || "none"}`);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
});
app.get("/api/media/:id", auth, (req: AuthRequest, res) => { const row = db.prepare("SELECT m.*,p.position,p.duration AS progress_duration,p.completed,s.name source_name,s.type AS source_type FROM media m JOIN sources s ON s.id=m.source_id LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE m.id=?").get(req.user!.id, req.params.id); row ? res.json(row) : res.status(404).json({ error: "媒体不存在" }); });
// Probes a media file (ffprobe reading the source directly) and caches the
// codec info in the media row. The player uses this to decide whether the
// browser can play the file natively or whether it must go through
// transcoding, avoiding a full download of the original file first.
app.post("/api/media/:id/probe", auth, openMedia, async (req: AuthRequest, res) => {
  const media = (req as any).media as Source & { media_path: string };
  try {
    const info = await withCredentialProxy(media, media.media_path, (url) => probe(url));
    const video = (info.streams || []).find((stream: any) => stream.codec_type === "video");
    const audio = (info.streams || []).find((stream: any) => stream.codec_type === "audio");
    const subtitle = (info.streams || []).find((stream: any) => stream.codec_type === "subtitle");
    log("probe", `media=${media.id} codec=${video?.codec_name} container=${String(info.format?.format_name || "").split(",")[0]} duration=${Number(info.format?.duration) || null}`);
    db.prepare("UPDATE media SET duration=?,container=?,video_codec=?,audio_codec=?,subtitle_codec=? WHERE id=?").run(
      Number(info.format?.duration) || null,
      String(info.format?.format_name || "").split(",")[0] || null,
      video?.codec_name || null,
      audio?.codec_name || null,
      subtitle?.codec_name || null,
      media.id,
    );
    const updated = db.prepare("SELECT m.*,p.position,p.duration AS progress_duration,p.completed,s.name source_name,s.type AS source_type FROM media m JOIN sources s ON s.id=m.source_id LEFT JOIN progress p ON p.media_id=m.id AND p.user_id=? WHERE m.id=?").get(req.user!.id, media.id);
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
  // Direct deletion: removes the file from the source and the DB row. There is
  // no trash bin — the client's confirm dialog states this is unrecoverable.
  // A file that is already gone still counts as deleted.
  const media = db.prepare("SELECT m.*,s.type,s.base_path,s.username,s.secret FROM media m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.available=1").get(req.params.id) as any;
  if (!media) return res.status(404).json({ error: "媒体不存在" });
  try {
    if (media.type === "local") {
      await fs.unlink(path.join(media.base_path, media.path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      const source = { type: media.type, base_path: media.base_path, username: media.username, secret: media.secret } as Source;
      const response = await fetch(sourceFile(source, media.path), { method: "DELETE", headers: webdavHeaders(source) });
      if (!response.ok && response.status !== 404) throw new Error(`WebDAV 删除失败 (${response.status})`);
    }
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
  db.prepare("DELETE FROM progress WHERE media_id=?").run(media.id);
  db.prepare("DELETE FROM media WHERE id=?").run(media.id);
  res.json({ ok: true });
});
app.post("/api/media/:id/remove-from-list", auth, (req: AuthRequest, res) => {
  // 「移除」只清理首页列表（继续播放/接下来）的数据来源（progress 观看记录），
  // 不触碰文件本身。重新观看会自动重建记录，条目随即回到列表。
  const media = db.prepare("SELECT id, work_id FROM media WHERE id=? AND available=1").get(req.params.id) as { id: number; work_id: number | null } | undefined;
  if (!media) return res.status(404).json({ error: "媒体不存在" });
  const removed: Array<{ media_id: number; position: number; duration: number }> = [];
  const take = (mediaId: number) => {
    const row = db.prepare("SELECT media_id, position, duration FROM progress WHERE user_id=? AND media_id=?").get(req.user!.id, mediaId) as { media_id: number; position: number; duration: number } | undefined;
    if (row) {
      removed.push(row);
      db.prepare("DELETE FROM progress WHERE user_id=? AND media_id=?").run(req.user!.id, mediaId);
    }
  };
  take(media.id);
  // 剧集：同时移除推导「接下来」的来源（该作品最近看完的一集），否则下一集
  // 推荐会立刻再次出现。
  if (media.work_id) {
    const last = db.prepare("SELECT p.media_id FROM progress p JOIN media m ON m.id=p.media_id WHERE p.user_id=? AND m.work_id=? AND p.completed=1 ORDER BY p.updated_at DESC LIMIT 1").get(req.user!.id, media.work_id) as { media_id: number } | undefined;
    if (last && last.media_id !== media.id) take(last.media_id);
  }
  res.json({ ok: true, removed });
});
app.put("/api/media/:id/progress", auth, (req: AuthRequest, res) => {
  const duration = Math.max(0, Number(req.body?.duration) || 0);
  const position = Math.min(Math.max(0, Number(req.body?.position) || 0), duration);
  // 完成判定收敛到服务端：剩余 ≤5%（+1s 容差）即视为看完，多客户端判定规则
  // 不再各自实现（TV/Web 曾因 seek 抑制、拖动语义不同而漂移）。客户端只上报
  // position/duration 事实；手动"标记完成/取消"仍生效——它们通过
  // position=duration 或 position=0 表达，服务端规则天然兼容。
  const completed = duration > 0 && duration - position <= duration * 0.05 + 1 ? 1 : 0;
  db.prepare("INSERT INTO progress(user_id,media_id,position,duration,completed) VALUES(?,?,?,?,?) ON CONFLICT(user_id,media_id) DO UPDATE SET position=excluded.position,duration=excluded.duration,completed=excluded.completed,updated_at=CURRENT_TIMESTAMP").run(req.user!.id, req.params.id, position, duration, completed); res.json({ ok: true });
});
async function openMedia(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  // Accept both `:id` (media routes) and `:mediaId` (transcode segment routes).
  const id = Number(req.params.id ?? req.params.mediaId);
  // Select source fields explicitly: `s.*` would overwrite m.id with the
  // source id, breaking every downstream use of media.id.
  const media = db.prepare("SELECT m.id, m.path media_path, m.size media_size, m.source_id, m.subtitle_codec, s.type, s.base_path, s.username, s.secret FROM media m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.available=1").get(id) as any;
  if (!media) return res.status(404).end(); (req as any).media = media; next();
}
app.get("/api/media/:id/file", auth, openMedia, async (req: AuthRequest, res) => {
  const media = (req as any).media as Source & { media_path: string; media_size: number; source_id: number };
  const url = sourceFile(media, media.media_path);
  const range = req.headers.range;
  // Local files: send straight from disk. No upstream throttle concern.
  if (media.type === "local") {
    res.setHeader("Accept-Ranges", "bytes");
    res.sendFile(path.resolve(url));
    return;
  }
  // Remote (WebDAV): fetch upstream and pipe through. No circuit breaker -
  // when the drive throttles, just fail this one request and let the client
  // decide. The frontend clears <video src> on error so the browser does NOT
  // auto-retry (which would hammer the drive dozens of times per second and
  // deepen the throttle). A user-initiated retry (refresh / re-click) is the
  // only thing that re-hits the upstream, by design.
  const headers: Record<string, string> = { ...webdavHeaders(media) };
  if (range) headers.Range = range;
  const upstream = await fetch(url, { headers });
  // Non-2xx/206: classify and translate. The drive (夸克 via OpenList) wraps
  // its 429 throttles as HTTP 416 with a "429|Too Many Requests" body. A bare
  // 416 without that body is a genuine "Range Not Satisfiable" and must NOT be
  // treated as throttle.
  if (!upstream?.ok && upstream?.status !== 206) {
    const status = upstream?.status || 502;
    let throttled = status === 429;
    if (status === 416 || status === 429) {
      const body = await upstream.text().catch(() => "");
      throttled = status === 429 || body.includes("429") || body.toLowerCase().includes("too many");
    }
    log("file", `direct stream FAILED media=${media.id} upstream=${status} throttled=${throttled} range=${range || "none"}`);
    if (throttled) return res.status(429).json({ error: "网盘请求过于频繁，请稍后重试" });
    // Genuine non-throttle failure (403/404/416-range/5xx): return as-is so the
    // browser stops retrying a genuinely unreadable file instead of hammering.
    return res.status(status).json({ error: "无法读取媒体文件" });
  }
  res.status(upstream.status);
  ["content-type", "content-length", "content-range", "accept-ranges"].forEach((header) => {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  });
  res.setHeader("Content-Disposition", "inline");
  // Pipe the upstream body to the client with correct backpressure and FULL
  // listener cleanup. The previous implementation leaked a `close` listener on
  // every backpressure wait (res.once("close") without removal), which tripped
  // MaxListenersExceededWarning on large streams and left stale handlers that
  // could fire after the response was reused.
  const onClose = () => { try { upstream.body?.cancel().catch(() => {}); } catch {} };
  res.on("close", onClose);
  // A single drain-wait promise whose listeners are removed once it resolves,
  // so repeated backpressure never accumulates listeners on `res`.
  const waitForDrain = () => new Promise<void>((resolve) => {
    const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
    res.on("drain", done);
    res.on("close", done);
  });
  try {
    if (upstream.body) for await (const chunk of upstream.body) {
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(chunk)) await waitForDrain();
    }
  } catch {} // upstream cancelled on client disconnect; ignore.
  res.off("close", onClose);
  try { res.end(); } catch {}
});
// Shared transcode orchestrator. Starts (or restarts) an ffmpeg producing the
// absolutely-addressed segment cache for media/quality, serialized per key so
// concurrent requests (a seek burst, double mounts) can never each spawn their
// own encoder against the same cache — the main cause of drive rate limiting.
// Returns the session id and the produced/expected segment numbers.
type TranscodeHandle = { session: string; outputDir: string; segSec: number; startNumber: number };

async function spawnTranscode(media: any, userId: number, start: number, quality: TranscodeQuality, mode: TranscodeMode, segSec: number): Promise<TranscodeHandle> {
  const outputDir = await ensureCacheDir(media.id, quality);
  // 上一轮失败的 error.txt 会误导本轮的启动循环，先清掉。
  await fs.rm(path.join(outputDir, "error.txt"), { force: true }).catch(() => {});
  // Remove the previous encoder's playlist: producedSeq reads it to judge how
  // far the encoder has gotten, and a stale playlist from a prior block would
  // fool the startup loop into returning before THIS encoder produced anything.
  await fs.rm(path.join(outputDir, "index.m3u8"), { force: true }).catch(() => {});
  const startNumber = absSeq(start, segSec);
  const segFile = path.join(outputDir, "segment-%d.ts");
  const playlistFile = path.join(outputDir, "index.m3u8");
  const acceleration = await getTranscodeAcceleration();
  // WebDAV 源走共享 credential proxy（连接复用），本地源直接读文件。
  let ffmpegInput: string | undefined;
  let localStream: ReadableStream<Uint8Array> | null = null;
  let credentialProxy: CredentialProxy | undefined;
  const inputAbort = new AbortController();
  if (media.type === "webdav") {
    try {
      credentialProxy = await acquireCredentialProxy(media, media.media_path);
      ffmpegInput = credentialProxy.url;
    } catch {
      throw new Error("无法建立媒体连接");
    }
  } else {
    localStream = fsSync.createReadStream(mediaInputUrl(media, media.media_path)) as unknown as ReadableStream<Uint8Array>;
  }
  const args = transcodeArgs(acceleration, segFile, playlistFile, ffmpegInput, start, quality, media.subtitle_codec, mode, startNumber, segSec);
  const child = spawn(config.ffmpeg, args, { stdio: ffmpegInput ? ["ignore", "ignore", "pipe"] : ["pipe", "ignore", "pipe"] });
  const session = randomUUID();
  log("transcode", `ffmpeg spawned pid=${child.pid} media=${media.id} start=${start} seq=${startNumber} mode=${mode} accel=${acceleration}`);
  let ffmpegError = ""; child.stderr?.on("data", (chunk) => { ffmpegError = (ffmpegError + chunk).slice(-4000); });
  register(session, {
    child, mediaId: media.id, quality, outputDir, userId,
    lastAccess: Date.now(), inputAbort,
    closeProxy: credentialProxy?.release,
    exited: false, start, segSec,
  });
  if (localStream) {
    const nodeStream = localStream as any;
    nodeStream.pipe(child.stdin, { end: true });
    nodeStream.on("error", () => { try { child.stdin?.end(); } catch {} });
    child.stdin?.on("error", () => {});
  }
  child.on("close", (code) => {
    const lastError = ffmpegError.slice(-300);
    if (code) {
      log("transcode", `ffmpeg exited code=${code} media=${media.id} — ${lastError}`);
      fs.writeFile(path.join(outputDir, "error.txt"), ffmpegError).catch(() => {});
    } else {
      // Natural EOF: the cache is complete, future playbacks hit VOD. Keep the
      // existing activeStart (the block head), only flip the complete flag.
      log("transcode", `ffmpeg finished cleanly media=${media.id} (EOF reached) — cache complete`);
      void readMeta(media.id, quality).then((prev) => writeMeta(media.id, quality, {
        segSec,
        activeStart: prev?.activeStart ?? start,
        complete: true,
      })).catch(() => {});
    }
  });
  return { session, outputDir, segSec, startNumber };
}

// Serialized "ensure the encoder covers targetSeq": reuse the live session if
// it is already producing at/after the target and not far ahead; otherwise
// kill it and restart at the target. When the target is covered by a partial
// cache (interrupted), the encoder resumes from the cache tail so the
// already-transcoded prefix is never re-pulled. Returns the active handle plus
// the aggregate playlist head (the cache block head for the target), which the
// client uses as its timeline offset.
async function ensureEncoder(media: any, userId: number, start: number, quality: TranscodeQuality, mode: TranscodeMode, segSec: number, targetSeq: number): Promise<{ handle: TranscodeHandle; playlistStart: number }> {
  const key = `${media.id}/${quality}`;
  const existingId = activeSessionFor(key);
  const segs = await listSegments(media.id, quality);
  if (existingId) {
    const existing = get(existingId)!;
    const produced = await producedSeq(existing.outputDir);
    const existingStartSeq = absSeq(existing.start, existing.segSec);
    // Reuse if the target is not behind the session start and the encoder has
    // not already raced far past it (no point jumping the gun on a restart).
    if (targetSeq >= existingStartSeq && targetSeq <= produced + 2) {
      log("transcode", `reuse session media=${media.id} q=${quality} targetSeq=${targetSeq} produced=${produced} startSeq=${existingStartSeq}`);
      const playlistHead = blockHead(segs, targetSeq);
      await writeMeta(media.id, quality, { segSec, activeStart: playlistHead * segSec, complete: false });
      return {
        handle: { session: existingId, outputDir: existing.outputDir, segSec: existing.segSec, startNumber: absSeq(existing.start, existing.segSec) },
        playlistStart: playlistHead,
      };
    }
    destroy(existingId);
  }
  // Resume from the cache tail: if the target sits inside a partial cache,
  // start the encoder where it left off, not from the requested position, so
  // replaying a watched prefix stays free of source traffic.
  const present = new Set(segs);
  let resumeSeq = targetSeq;
  while (present.has(resumeSeq)) resumeSeq++;
  if (resumeSeq > targetSeq) log("transcode", `resume from cache tail media=${media.id} q=${quality} targetSeq=${targetSeq} tail=${resumeSeq}`);
  if (activeCount() >= maxConcurrent()) {
    const err: any = new Error("转码并发已满，请稍后再试");
    err.status = 429;
    throw err;
  }
  const handle = await spawnTranscode(media, userId, resumeSeq * segSec, quality, mode, segSec);
  // The aggregate playlist starts at the head of the cache block the target
  // belongs to (so a backward seek into cached territory is covered), not at
  // the encoder's resume point. Overwrite the activeStart written by
  // spawnTranscode with the correct block head.
  const playlistHead = blockHead(segs, targetSeq);
  await writeMeta(media.id, quality, { segSec, activeStart: playlistHead * segSec, complete: false });
  return { handle, playlistStart: playlistHead };
}

// Reads the current playlist coverage of a cache dir without a live encoder,
// matching the aggregate playlist's start (activeStart or cache head).
async function cachedCoverage(mediaId: number, quality: string): Promise<number | null> {
  const segs = await listSegments(mediaId, quality);
  if (!segs.length) return null;
  const meta = await readMeta(mediaId, quality);
  const segSec = meta?.segSec ?? TRANSCODE_SEGMENT_SECONDS;
  const startSeq = meta?.complete ? segs[0] : (meta?.activeStart !== undefined ? absSeq(meta.activeStart, segSec) : segs[0]);
  const seqs = contiguousFrom(segs, startSeq);
  return (startSeq + seqs.length) * segSec;
}

app.post("/api/media/:id/transcode", auth, openMedia, async (req: AuthRequest, res) => {
  const media = (req as any).media as Source & { media_path: string; subtitle_codec?: string | null };
  const userId = req.user!.id;
  // Resume position: start transcoding from this offset in the source file so
  // a resumed episode becomes playable immediately instead of from the top.
  const start = Math.max(0, Number(req.body?.start) || 0);
  const quality: TranscodeQuality = isTranscodeQuality(String(req.body?.quality || "")) ? req.body.quality : "1080";
  const mode: TranscodeMode = isTranscodeMode(String(req.body?.mode || "")) ? req.body.mode : "transcode";
  const segSec = segSecFor(mode);
  const targetSeq = absSeq(start, segSec);
  const key = `${media.id}/${quality}`;
  const startedAt = Date.now();
  log("transcode", `request media=${media.id} start=${start} quality=${quality} mode=${mode} segSec=${segSec} targetSeq=${targetSeq} by user=${userId}`);
  // Fast path: the requested position is fully covered by a COMPLETE cache
  // (ffmpeg reached EOF last time), so serve the aggregate playlist without
  // touching the source at all. A partial cache (interrupted mid-stream) must
  // still spin the encoder back up from its tail — see ensureEncoder.
  const covered = await withLock(key, async () => {
    const segs = await listSegments(media.id, quality);
    if (!segs.length) return null;
    const meta = await readMeta(media.id, quality);
    if (!meta?.complete) return null;
    const s = meta.segSec;
    const seqs = contiguousFrom(segs, segs[0]);
    if (segs[0] <= targetSeq && seqs.length * s >= targetSeq * s + s) return seqs.length * s;
    return null;
  });
  if (covered !== null) {
    touch(media.id, quality).catch(() => {});
    const playlist = `/api/transcode/${media.id}/${quality}/index.m3u8`;
    log("transcode", `cache HIT media=${media.id} start=${start} (covered to ${covered}) — serving cached playlist, no ffmpeg`);
    // start: absolute source position where the playlist begins. The player
    // offsets its timeline by this, NOT by the requested start — a cache hit
    // may begin before the resume point.
    const head = (await listSegments(media.id, quality))[0] ?? targetSeq;
    return res.json({ session: "", playlist: `${playlist}?sig=${signTranscode(`${media.id}/${quality}`, "index.m3u8")}`, cached: true, start: head * segSec, coveredUntil: covered });
  }
  // Fresh or partial cache: (re)start ffmpeg, serialized per media/quality so a
  // burst of seeks cannot spawn multiple encoders against the same files.
  let handle: TranscodeHandle;
  let playlistStart: number;
  try {
    ({ handle, playlistStart } = await withLock(key, () => ensureEncoder(media, userId, start, quality, mode, segSec, targetSeq)));
  } catch (error) {
    const status = (error as any)?.status;
    return res.status(status || 500).json({ error: error instanceof Error ? error.message : "转码启动失败" });
  }
  // If the client disconnects during start-up nothing is playable yet, so stop
  // ffmpeg immediately instead of letting the reaper reclaim it minutes later.
  // (After the playlist is ready the listener is removed below.)
  const onClientClose = () => destroy(handle.session);
  res.on("close", onClientClose);
  const playlistUrl = `/api/transcode/${media.id}/${quality}/index.m3u8`;
  const countSegments = async () => {
    try { return (await fs.readFile(path.join(handle.outputDir, "index.m3u8"), "utf8")).match(/segment-\d+\.ts/g)?.length ?? 0; } catch { return 0; }
  };
  for (let attempt = 0; attempt < 300; attempt++) { // 30s start-up window
    if (res.destroyed || res.writableEnded) { destroy(handle.session); return; }
    const produced = await producedSeq(handle.outputDir);
    if (produced >= handle.startNumber) {
      // Pre-warm: hand the stream over as soon as a couple of segments exist so
      // startup stays fast — the player's forward buffer absorbs the jitter.
      const warmDeadline = Date.now() + 4000;
      while (Date.now() < warmDeadline) {
        if (res.destroyed || res.writableEnded) { destroy(handle.session); return; }
        if ((await countSegments()) >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      res.off("close", onClientClose);
      const segCount = await countSegments();
      const coverage = await cachedCoverage(media.id, quality);
      log("transcode", `playlist ready media=${media.id} seq=${produced} segments=${segCount} startupMs=${Date.now() - startedAt}`);
      // start: the absolute source position the playlist begins at (the cache
      // block head for the requested position), used by the player as its
      // timeline offset. NOT the encoder's resume point: older cached segments
      // may exist before it and are included in the aggregate playlist.
      const headSec = playlistStart * segSec;
      return res.json({ session: handle.session, playlist: `${playlistUrl}?sig=${signTranscode(`${media.id}/${quality}`, "index.m3u8")}`, cached: false, start: headSec, coveredUntil: coverage });
    }
    if (fileExists(path.join(handle.outputDir, "error.txt"))) {
      destroy(handle.session);
      // 网盘限流时 OpenList 会把夸克返回的 429 包装成 HTTP 416（响应体里
      // 是 "429|Too Many Requests"），ffmpeg 读源直接失败。
      const detail = await fs.readFile(path.join(handle.outputDir, "error.txt"), "utf8").catch(() => "");
      const throttled = /429|Too Many Requests|too many requests|416 Range/i.test(detail);
      log("transcode", `ffmpeg failed media=${media.id} throttled=${throttled} — ${detail.slice(-300)}`);
      return res.status(throttled ? 429 : 500).json({ error: throttled ? "网盘请求过于频繁，请稍后重试" : "FFmpeg 转码启动失败" });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  destroy(handle.session);
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
// Serves the aggregate playlist and segments of a media/quality cache.
// Paths are stable across sessions: /api/transcode/{mediaId}/{quality}/... The
// playlist is generated on the fly from the segments present on disk, so a
// seek back into already-transcoded territory is served without touching the
// source drive. Access is via a short-lived signature bound to the cache key.
app.get("/api/transcode/:mediaId/:quality/index.m3u8", auth, async (req: AuthRequest, res) => {
  const mediaId = Number(req.params.mediaId);
  const quality = String(req.params.quality);
  if (!Number.isInteger(mediaId) || mediaId <= 0) return res.status(400).end();
  const key = `${mediaId}/${quality}`;
  const sig = typeof req.query.sig === "string" ? req.query.sig : undefined;
  if (!sig || !verifyTranscodeSig(key, "index.m3u8", sig)) {
    log("segment", `rejected sig media=${mediaId} q=${quality} file=index.m3u8 — invalid/expired signature`);
    return res.status(403).end();
  }
  touch(mediaId, quality).catch(() => {});
  const segs = await listSegments(mediaId, quality);
  if (!segs.length) return res.status(404).end();
  const meta = await readMeta(mediaId, quality);
  const segSec = meta?.segSec ?? TRANSCODE_SEGMENT_SECONDS;
  // The aggregate playlist starts at the encoder's active start (the cache
  // head for the current playback). Complete caches keep every segment from
  // the earliest one; a live cache lists only the contiguous run from the
  // active start, so segments before a forward-seek restart are excluded and
  // the playlist never contains a hole that hls.js would stall on.
  const activeStart = meta?.complete ? segs[0] : (meta?.activeStart !== undefined ? absSeq(meta.activeStart, segSec) : segs[0]);
  const seqs = contiguousFrom(segs, activeStart);
  // Live edge: whether an encoder is still producing for this cache. If so the
  // playlist must not carry ENDLIST, so hls.js keeps polling for new segments.
  const live = Boolean(activeSessionFor(key));
  const playlist = buildPlaylist(mediaId, quality, seqs, segSec, !live, (file) => signTranscode(key, file));
  log("segment", `serve playlist media=${mediaId} q=${quality} (${seqs.length} segments, live=${live})`);
  return res.type("application/vnd.apple.mpegurl").send(playlist);
});

// Segment delivery. If the segment already exists (cache hit — including a
// backward seek into previously transcoded territory), it is served straight
// off disk. If it does not exist yet, an encoder is (re)started on demand at
// that position — this is how a forward seek into un-transcoded territory
// works: the player requests segment N, the server begins encoding at N and
// returns once the segment is ready, instead of the client orchestrating a
// full transcode restart itself.
app.get("/api/transcode/:mediaId/:quality/segment-:seq.ts", auth, openMedia, async (req: AuthRequest, res) => {
  const media = (req as any).media as Source & { media_path: string; subtitle_codec?: string | null };
  const mediaId = Number(req.params.mediaId);
  const quality = String(req.params.quality);
  const seq = Number(req.params.seq);
  if (!Number.isInteger(mediaId) || mediaId <= 0 || !Number.isInteger(seq) || seq < 0) return res.status(400).end();
  const key = `${mediaId}/${quality}`;
  const sig = typeof req.query.sig === "string" ? req.query.sig : undefined;
  const file = `segment-${seq}.ts`;
  if (!sig || !verifyTranscodeSig(key, file, sig)) {
    log("segment", `rejected sig media=${mediaId} q=${quality} file=${file} — invalid/expired signature`);
    return res.status(403).end();
  }
  touch(mediaId, quality).catch(() => {});
  const full = segmentFile(mediaId, quality, seq);
  const serveFile = async () => {
    try {
      await fs.access(full);
    } catch {
      return false;
    }
    res.type("video/mp2t");
    const fd = await fs.open(full, "r");
    try {
      const stat = await fd.stat();
      if (stat.size === 0) {
        await fd.close();
        return res.setHeader("Content-Length", "0").end();
      }
      res.setHeader("Content-Length", String(stat.size));
      const stream = fd.createReadStream({ start: 0, end: stat.size - 1 });
      const closeFd = () => fd.close().catch(() => {});
      stream.on("error", () => { closeFd(); res.destroy(); });
      stream.on("end", closeFd);
      stream.pipe(res);
    } catch {
      fd.close().catch(() => {});
      res.status(404).end();
    }
    return true;
  };
  if (await serveFile()) return;
  // Not cached yet. Serialize the "ensure encoder at this position" decision so
  // a burst of forward-seek segment requests starts one encoder, not many.
  const meta = await readMeta(mediaId, quality);
  const mode: TranscodeMode = meta?.segSec === REMUX_SEGMENT_SECONDS ? "remux" : "transcode";
  const segSec = meta?.segSec ?? segSecFor(mode);
  const transcodeQuality: TranscodeQuality = isTranscodeQuality(quality) ? quality : "1080";
  let handle: TranscodeHandle;
  try {
    ({ handle } = await withLock(key, () => ensureEncoder(media, req.user!.id, seq * segSec, transcodeQuality, mode, segSec, seq)));
  } catch (error) {
    const status = (error as any)?.status;
    return res.status(status || 500).json({ error: error instanceof Error ? error.message : "转码启动失败" });
  }
  // Poll for the requested segment (and a following one, so the response is not
  // a half-written file). The encoder may already be running slightly ahead.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fileExists(full)) {
      const next = segmentFile(mediaId, quality, seq + 1);
      const state = get(handle.session);
      // Segment is complete once the encoder exited (natural EOF) or the next
      // segment also exists (temp_file renames make "exists" = "complete").
      if (state?.exited || fileExists(next)) {
        return await serveFile() ? undefined : res.status(404).end();
      }
    }
    const state = get(handle.session);
    if (state?.exited && fileExists(path.join(handle.outputDir, "error.txt"))) {
      const detail = await fs.readFile(path.join(handle.outputDir, "error.txt"), "utf8").catch(() => "");
      if (/429|Too Many Requests|too many requests|416 Range/i.test(detail)) {
        log("segment", `encoder died from rate limit media=${mediaId} q=${quality} seq=${seq} — 429 to player`);
        return res.status(429).json({ error: "网盘请求过于频繁，请稍后重试" });
      }
      return res.status(500).json({ error: "FFmpeg 转码启动失败" });
    }
    if (res.destroyed || res.writableEnded) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  log("segment", `segment timeout media=${mediaId} q=${quality} seq=${seq} — 503 to player`);
  return res.status(503).set("Retry-After", "1").end();
});
// SPA fallback for client-side routes. Static assets are excluded so a
// missing CSS/JS file returns a real 404 instead of an HTML page that the
// browser rejects with a MIME type error.
app.get(/^(?!\/api)(?!\/assets).*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
// A previous instance may have been killed while a scan or metadata job was
// running. Mark those as interrupted at real startup (kept out of db.ts so
// importing modules for tests stays side-effect free).
db.prepare("UPDATE scan_jobs SET status='failed',phase='interrupted',error='服务重启，扫描已中断',finished_at=CURRENT_TIMESTAMP WHERE status IN ('queued','running')").run();
db.prepare("UPDATE metadata_jobs SET status='failed',phase='interrupted',error='服务重启，匹配已中断',finished_at=CURRENT_TIMESTAMP WHERE status IN ('queued','running')").run();
// Anything that finished before startup is old news; acknowledge it so users
// are not greeted by a wall of stale scan notifications on the next visit.
db.prepare("UPDATE scan_jobs SET acknowledged=1 WHERE acknowledged=0 AND status IN ('completed','failed','cancelled')").run();
rebuildCatalog();
void sweepStaleDirectories();
void sweepCache();
const cacheSweepTimer = setInterval(() => void sweepCache(), 10 * 60 * 1000);
cacheSweepTimer.unref();
startAutoSync();
app.listen(config.port, () => console.log(`FPlayer listening on :${config.port}`));
