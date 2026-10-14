import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { hashToken } from "./sessions.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const stamp = (time: number) => new Date(time).toISOString().replace("T", " ").replace("Z", "");
const DAY = 86_400_000;

test("real auth routes preserve login, revocation and distinct session failure codes", { timeout: 30_000 }, async (t) => {
  // Never import db.ts/security.ts here: the real server gets a unique temp
  // DATA_DIR explicitly, regardless of the caller's environment or test runner.
  const directory = mkdtempSync(path.join(os.tmpdir(), "fplayer-auth-http-"));
  let db: Database.Database | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  const upstream = createServer((_req, res) => { res.writeHead(401); res.end("upstream credentials rejected"); });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    if (db?.open) db.close();
    if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  db = new Database(path.join(directory, "fplayer.db"));
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
    CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO app_settings(key,value) VALUES('auto_sync','{"enabled":false,"intervalMinutes":15}')`);
  const password = "password123";
  const passwordHash = `test-salt:${scryptSync(password, "test-salt", 64).toString("hex")}`;
  db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'admin',?)").run(passwordHash);
  const legacyToken = "existing-opaque-token";
  const legacyExpiry = stamp(Date.now() + 5 * DAY).slice(0, 19);
  const legacyCreated = Date.parse(legacyExpiry.replace(" ", "T") + "Z") - 30 * DAY;
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hashToken(legacyToken), 1, legacyExpiry);
  db.close();

  const reservation = createPortReservation();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  child = spawn(process.execPath, ["--import", "tsx", path.join(projectRoot, "server/index.ts")], {
    cwd: projectRoot,
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), APP_SECRET: "isolated-session-http-test", TRANSCODE_ACCELERATION: "cpu",
      SESSION_IDLE_DAYS: "30", SESSION_ABSOLUTE_DAYS: "90", SESSION_RENEW_INTERVAL_MINUTES: "60" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = new Promise((resolve) => child!.once("close", resolve));
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15_000);
    child!.once("error", (error) => { clearTimeout(timer); reject(error); });
    child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${output}`)); });
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`FPlayer listening on :${port}`)) { clearTimeout(timer); resolve(); }
    };
    child!.stdout!.on("data", collect);
    child!.stderr!.on("data", collect);
  });
  db = new Database(path.join(directory, "fplayer.db"));
  db.pragma("busy_timeout = 5000");
  const sql = db;
  const base = `http://127.0.0.1:${port}`;
  async function api(route: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + route, { headers, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }
  const session = (token: string) => sql.prepare("SELECT * FROM sessions WHERE token_hash=?").get(hashToken(token)) as { created_at: string; absolute_expires_at: string; expires_at: string } | undefined;
  const login = () => api("/api/login", undefined, { username: "admin", password });
  let firstToken = "";
  let secondToken = "";

  await t.test("startup migrates a valid legacy token without changing its creation or original expiry", async () => {
    assert.equal(session(legacyToken)?.created_at, stamp(legacyCreated));
    assert.equal(session(legacyToken)?.expires_at, legacyExpiry);
    const res = await api("/api/me", legacyToken);
    assert.deepEqual(res, { status: 200, body: { user: { id: 1, username: "admin", role: "admin" } } });
    assert.equal(session(legacyToken)?.absolute_expires_at, stamp(legacyCreated + 90 * DAY));
  });

  await t.test("missing and invalid credentials use stable auth codes, without broadening query token transport", async () => {
    assert.deepEqual(await api("/api/me"), { status: 401, body: { error: "请先登录", code: "SESSION_REQUIRED" } });
    assert.deepEqual(await api("/api/me", "not-a-token"), { status: 401, body: { error: "登录已过期", code: "SESSION_INVALID" } });
    assert.equal((await api(`/api/me?token=${legacyToken}`)).body.code, "SESSION_REQUIRED");
    assert.equal((await api(`/api/media/999/file?token=${legacyToken}`)).status, 404);
    assert.equal((await api(`/api/media/999/file?token=${legacyToken}`, "wrong-header")).body.code, "SESSION_INVALID");
  });

  await t.test("login errors differ from session failures, and success payload remains token/user", async () => {
    for (const credentials of [{ username: "admin", password: "wrong" }, { username: "unknown", password }]) {
      assert.deepEqual(await api("/api/login", undefined, credentials), { status: 401, body: { error: "用户名或密码错误", code: "INVALID_CREDENTIALS" } });
    }
    const first = await login();
    const second = await login();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ["token", "user"]);
    assert.deepEqual(first.body.user, { id: 1, username: "admin", role: "admin" });
    firstToken = first.body.token;
    secondToken = second.body.token;
    assert.notEqual(firstToken, secondToken);
    assert.match(firstToken, /^[A-Za-z0-9_-]{43}$/);
  });

  await t.test("logout deletes only the current session and cannot be undone by auth", async () => {
    assert.deepEqual(await api("/api/logout", secondToken, {}), { status: 200, body: { ok: true } });
    assert.equal(session(secondToken), undefined);
    assert.equal((await api("/api/me", secondToken)).body.code, "SESSION_INVALID");
    assert.equal(session(secondToken), undefined);
    assert.equal((await api("/api/me", firstToken)).status, 200);
    assert.equal((await api("/api/me", legacyToken)).status, 200);
  });

  await t.test("password change keeps current session, revokes others, and wrong current password is not auth expiry", async () => {
    const wrong = await api("/api/me/password", firstToken, { currentPassword: "wrong", newPassword: "new-password123" });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, undefined);
    assert.ok(session(legacyToken));
    assert.deepEqual(await api("/api/me/password", firstToken, { currentPassword: password, newPassword: "new-password123" }), { status: 200, body: { ok: true } });
    assert.equal((await api("/api/me", firstToken)).status, 200);
    assert.equal(session(legacyToken), undefined);
    assert.equal((await api("/api/me", legacyToken)).body.code, "SESSION_INVALID");
    assert.equal((await login()).body.code, "INVALID_CREDENTIALS");
    assert.equal((await api("/api/login", undefined, { username: "admin", password: "new-password123" })).status, 200);
  });

  await t.test("upstream business 401 carries no session-expired code and leaves login valid", async () => {
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    const upstreamPort = (upstream.address() as { port: number }).port;
    const sourceId = sql.prepare("INSERT INTO sources(name,type,base_path,enabled) VALUES('isolated-upstream','webdav',?,0)").run(`http://127.0.0.1:${upstreamPort}/`).lastInsertRowid;
    const mediaId = sql.prepare("INSERT INTO media(source_id,path,title) VALUES(?,'rejected.mp4','test')").run(sourceId).lastInsertRowid;
    const res = await api(`/api/media/${mediaId}/file`, firstToken);
    assert.deepEqual(res, { status: 401, body: { error: "无法读取媒体文件" } });
    assert.equal((await api("/api/me", firstToken)).status, 200);
  });

  await t.test("expired and absolute-expired sessions reject without renewal on real routes", async () => {
    const expired = stamp(Date.now() - 1_000);
    sql.prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?").run(expired, hashToken(firstToken));
    assert.equal((await api("/api/me", firstToken)).body.code, "SESSION_INVALID");
    assert.equal(session(firstToken)?.expires_at, expired);
    const fresh = await api("/api/login", undefined, { username: "admin", password: "new-password123" });
    sql.prepare("UPDATE sessions SET absolute_expires_at=? WHERE token_hash=?").run(expired, hashToken(fresh.body.token));
    assert.equal((await api("/api/me", fresh.body.token)).body.code, "SESSION_INVALID");
    assert.equal(session(fresh.body.token)?.absolute_expires_at, expired);
  });
});
