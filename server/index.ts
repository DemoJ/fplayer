import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import { db } from "./db.js";
import { config } from "./config.js";
import { encrypt, hashPassword, hashToken, newSessionToken, verifyPassword } from "./security.js";
import { sourceFile, webdavHeaders } from "./media.js";
import { startScan, stopScan } from "./scans.js";
import { metadataStatus, startMetadataRefresh, stopMetadataRefresh, checkDoubanLogin, refreshWorkMetadata } from "./metadata.js";
import { getDoubanSettings, saveDoubanSettings } from "./douban.js";
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
app.post("/api/setup", (req, res) => { if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) return res.status(409).json({ error: "已完成初始化" }); const { username, password } = req.body; if (!username || !password || password.length < 8) return res.status(400).json({ error: "用户名不能为空，密码至少 8 位" }); const result = db.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)").run(username, hashPassword(password)); res.json({ user: { id: result.lastInsertRowid, username, role: "admin" } }); });
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
app.put("/api/media/:id/progress", auth, (req: AuthRequest, res) => { const { position = 0, duration = 0, completed = false } = req.body; db.prepare("INSERT INTO progress(user_id,media_id,position,duration,completed) VALUES(?,?,?,?,?) ON CONFLICT(user_id,media_id) DO UPDATE SET position=excluded.position,duration=excluded.duration,completed=excluded.completed,updated_at=CURRENT_TIMESTAMP").run(req.user!.id, req.params.id, position, duration, completed ? 1 : 0); res.json({ ok: true }); });
async function openMedia(req: AuthRequest, res: express.Response, next: express.NextFunction) { const media = db.prepare("SELECT m.path media_path,m.size media_size,s.* FROM media m JOIN sources s ON s.id=m.source_id WHERE m.id=? AND m.available=1").get(req.params.id) as any; if (!media) return res.status(404).end(); (req as any).media = media; next(); }
app.get("/api/media/:id/file", auth, openMedia, async (req: AuthRequest, res) => { const media = (req as any).media as Source & { media_path: string; media_size: number }; const url = sourceFile(media, media.media_path); const range = req.headers.range; const headers: any = { ...webdavHeaders(media) }; if (range) headers.Range = range; const upstream = media.type === "local" ? null : await fetch(url, { headers }); if (media.type === "local") { res.setHeader("Accept-Ranges", "bytes"); res.sendFile(path.resolve(url)); return; } if (!upstream?.ok && upstream?.status !== 206) return res.status(upstream?.status || 502).end(); res.status(upstream.status); ["content-type", "content-length", "content-range", "accept-ranges"].forEach((header) => { const value = upstream.headers.get(header); if (value) res.setHeader(header, value); }); res.setHeader("Content-Disposition", "inline"); if (upstream.body) for await (const chunk of upstream.body) if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve)); res.end(); });
app.post("/api/media/:id/transcode", auth, openMedia, async (req: AuthRequest, res) => {
  const media = (req as any).media as Source & { media_path: string };
  const session = randomUUID();
  const outputDir = path.join(config.dataDir, "transcodes", session);
  await fs.mkdir(outputDir, { recursive: true });
  const input = sourceFile(media, media.media_path);
  const authHeader = media.type === "webdav" && media.username ? `Authorization: ${webdavHeaders(media).Authorization}\r\n` : "";
  const args = [...(authHeader ? ["-headers", authHeader] : []), "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "192k", "-f", "hls", "-hls_time", "6", "-hls_list_size", "0", "-hls_segment_filename", path.join(outputDir, "segment-%05d.ts"), path.join(outputDir, "index.m3u8")];
  const child = spawn(config.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
  let ffmpegError = ""; child.stderr.on("data", (chunk) => { ffmpegError = (ffmpegError + chunk).slice(-4000); });
  child.on("close", (code) => { if (code && !fsSync.existsSync(path.join(outputDir, "index.m3u8"))) fs.writeFile(path.join(outputDir, "error.txt"), ffmpegError).catch(() => {}); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (fsSync.existsSync(path.join(outputDir, "index.m3u8"))) return res.json({ session, playlist: `/api/transcode/${session}/index.m3u8` });
    if (fsSync.existsSync(path.join(outputDir, "error.txt"))) return res.status(500).json({ error: "FFmpeg 转码启动失败" });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM"); res.status(504).json({ error: "转码启动超时" });
});
app.get("/api/transcode/:session/:file", auth, async (req, res) => { const file = path.basename(String(req.params.file)); const full = path.join(config.dataDir, "transcodes", String(req.params.session), file); try { await fs.access(full); if (file.endsWith(".m3u8") && typeof req.query.token === "string") { const playlist = await fs.readFile(full, "utf8"); return res.type("application/vnd.apple.mpegurl").send(playlist.replace(/^(segment-.*\.ts)$/gm, `$1?token=${encodeURIComponent(req.query.token)}`)); } res.type(path.extname(file)); res.sendFile(full); } catch { res.status(404).end(); } });
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
app.listen(config.port, () => console.log(`FPlayer listening on :${config.port}`));
