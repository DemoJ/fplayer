import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { hashToken, migrateSessions, readSessionPolicy, SessionStore } from "./sessions.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);
const defaults = readSessionPolicy({});
const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
const legacyStamp = (ms: number) => stamp(ms).slice(0, 19);
const users = `CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT);
  INSERT INTO users VALUES(1,'admin','admin'),(2,'other','user')`;
const legacySchema = `CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`;
type Row = { token_hash: string; user_id: number; expires_at: string; created_at: string; absolute_expires_at: string; last_renewed_at: string };
const row = (db: Database.Database, token: string) => db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(hashToken(token)) as Row;
const changes = (db: Database.Database) => (db.prepare("SELECT total_changes() n").get() as { n: number }).n;

function fixture(t: TestContext, policy = defaults) {
  const statements: string[] = [];
  const db = new Database(":memory:", { verbose: (sql) => statements.push(String(sql)) });
  t.after(() => db.close());
  db.pragma("foreign_keys = ON");
  db.exec(users);
  migrateSessions(db, policy);
  let now = START;
  const clock = () => now;
  const store = new SessionStore(db, policy, clock);
  return { db, store, statements, clock, setTime: (time: number) => { now = time; } };
}

test("session defaults, decimal configuration and independent absolute cap", () => {
  assert.deepEqual(defaults, { idleMs: 30 * DAY, absoluteMs: 90 * DAY, renewIntervalMs: HOUR });
  assert.deepEqual(readSessionPolicy({ SESSION_IDLE_DAYS: " 1.5 ", SESSION_ABSOLUTE_DAYS: "0.5", SESSION_RENEW_INTERVAL_MINUTES: "1e-1" }),
    { idleMs: 1.5 * DAY, absoluteMs: DAY / 2, renewIntervalMs: 6_000 });
});

test("all duration settings reject blank, NaN, infinity, nonpositive, sub-ms and overflow values", () => {
  for (const name of ["SESSION_IDLE_DAYS", "SESSION_ABSOLUTE_DAYS", "SESSION_RENEW_INTERVAL_MINUTES"]) {
    for (const value of ["", " ", "NaN", "Infinity", "-Infinity", "-1", "0", "-0", "abc", "30days", "0x10", "1e309", "1e100", "1e-100"]) {
      assert.throws(() => readSessionPolicy({ [name]: value }), new RegExp(name), `${name}=${value}`);
    }
  }
  assert.throws(() => readSessionPolicy({ SESSION_RENEW_INTERVAL_MINUTES: String(30 * 24 * 60) }), /shorter/);
  assert.throws(() => readSessionPolicy({ SESSION_RENEW_INTERVAL_MINUTES: String(30 * 24 * 60 + 1) }), /shorter/);
  assert.equal(readSessionPolicy({ SESSION_RENEW_INTERVAL_MINUTES: "0.00002" }).renewIntervalMs, 1);
  assert.equal(readSessionPolicy({ SESSION_ABSOLUTE_DAYS: "50000000" }).absoluteMs, 4.32e15);
  assert.throws(() => readSessionPolicy({ SESSION_ABSOLUTE_DAYS: "50000001" }), /SESSION_ABSOLUTE_DAYS/);
});

test("creation keeps random opaque tokens and stores only hashes with bounded UTC deadlines", (t) => {
  const { db, store } = fixture(t);
  const token = store.create(1);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, store.create(1));
  assert.deepEqual(row(db, token), {
    token_hash: hashToken(token), user_id: 1, expires_at: stamp(START + 30 * DAY),
    created_at: stamp(START), absolute_expires_at: stamp(START + 90 * DAY), last_renewed_at: stamp(START),
  });
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM sessions").all()).includes(token), false);
  assert.deepEqual(store.authenticate(token), { id: 1, username: "admin", role: "admin" });
  assert.equal(store.authenticate("unknown"), undefined);
  assert.equal(store.authenticate(""), undefined);
});

test("absolute duration shorter than idle is honored at creation and renewal", (t) => {
  const { db, store, setTime } = fixture(t, readSessionPolicy({ SESSION_ABSOLUTE_DAYS: "2" }));
  const token = store.create(1);
  assert.equal(row(db, token).expires_at, stamp(START + 2 * DAY));
  setTime(START + DAY);
  assert.ok(store.authenticate(token));
  assert.equal(row(db, token).expires_at, stamp(START + 2 * DAY));
  setTime(START + 2 * DAY);
  assert.equal(store.authenticate(token), undefined);
});

test("daily activity survives 30 days without rotating token and stops exactly at 90 days", (t) => {
  const { db, store, setTime } = fixture(t);
  const token = store.create(1);
  for (let day = 1; day < 90; day++) {
    setTime(START + day * DAY);
    assert.ok(store.authenticate(token), `day ${day}`);
    assert.equal(row(db, token).expires_at, stamp(START + Math.min(day + 30, 90) * DAY));
    assert.equal(row(db, token).created_at, stamp(START));
    assert.equal(row(db, token).absolute_expires_at, stamp(START + 90 * DAY));
  }
  setTime(START + 90 * DAY - 1);
  assert.ok(store.authenticate(token));
  const before = changes(db);
  setTime(START + 90 * DAY);
  assert.equal(store.authenticate(token), undefined);
  setTime(START + 91 * DAY);
  assert.equal(store.authenticate(token), undefined);
  assert.equal(changes(db), before);
});

for (const delta of [-1, 0, 1]) {
  test(`idle expiry boundary at 30 days ${delta >= 0 ? "+" : ""}${delta} ms`, (t) => {
    const { db, store, setTime } = fixture(t);
    const token = store.create(1);
    const before = changes(db);
    setTime(START + 30 * DAY + delta);
    assert.equal(Boolean(store.authenticate(token)), delta < 0);
    if (delta >= 0) {
      assert.equal(changes(db), before);
      assert.equal(row(db, token).expires_at, stamp(START + 30 * DAY));
    }
  });
}

test("renewed idle deadline also expires on equality", (t) => {
  const { db, store, setTime } = fixture(t);
  const token = store.create(1);
  setTime(START + DAY);
  assert.ok(store.authenticate(token));
  assert.equal(row(db, token).expires_at, stamp(START + 31 * DAY));
  setTime(START + 31 * DAY);
  assert.equal(store.authenticate(token), undefined);
});

test("high-frequency auth executes no UPDATE before the interval; equality renews once across store restarts", (t) => {
  const { db, store, statements, clock, setTime } = fixture(t);
  const token = store.create(1);
  statements.length = 0;
  const before = changes(db);
  for (let i = 0; i < 2_000; i++) {
    setTime(START + i * 1_000);
    assert.ok(store.authenticate(token));
  }
  setTime(START + HOUR - 1);
  assert.ok(store.authenticate(token));
  assert.equal(changes(db), before);
  assert.equal(statements.some((sql) => /^UPDATE sessions/.test(sql)), false);
  setTime(START + HOUR);
  assert.ok(store.authenticate(token));
  assert.equal(changes(db), before + 1);
  assert.equal(row(db, token).expires_at, stamp(START + HOUR + 30 * DAY));
  const restarted = new SessionStore(db, defaults, clock);
  for (let i = 0; i < 1_000; i++) assert.ok(restarted.authenticate(token));
  setTime(START + 2 * HOUR - 1);
  assert.ok(restarted.authenticate(token));
  assert.equal(changes(db), before + 1);
  setTime(START + 2 * HOUR);
  assert.ok(restarted.authenticate(token));
  assert.equal(changes(db), before + 2);
});

test("revoking current/other sessions leaves the intended sessions and other users intact", (t) => {
  const { db, store, setTime } = fixture(t);
  const current = store.create(1);
  const sibling = store.create(1);
  const anotherUser = store.create(2);
  store.revokeOthers(1, current);
  const before = changes(db);
  assert.ok(store.authenticate(current));
  assert.ok(store.authenticate(anotherUser));
  assert.equal(store.authenticate(sibling), undefined);
  assert.equal(changes(db), before);
  store.revoke(current);
  setTime(START + HOUR);
  assert.equal(store.authenticate(current), undefined);
  assert.equal(store.authenticate(sibling), undefined);
  assert.equal(row(db, current), undefined);
  assert.ok(store.authenticate(anotherUser));
});

test("a row revoked between validation and UPDATE cannot be recreated or authenticated", (t) => {
  const { db, store, setTime } = fixture(t);
  const token = store.create(1);
  db.exec(`CREATE TRIGGER revoke_during_renew BEFORE UPDATE ON sessions BEGIN
    DELETE FROM sessions WHERE token_hash=OLD.token_hash;
    SELECT RAISE(IGNORE);
  END`);
  setTime(START + HOUR);
  assert.equal(store.authenticate(token), undefined);
  assert.equal(row(db, token), undefined);
});

test("absolute bound is checked independently of idle expires_at", (t) => {
  const { db, store, setTime } = fixture(t);
  const token = store.create(1);
  db.prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?").run(stamp(START + 200 * DAY), hashToken(token));
  setTime(START + 90 * DAY);
  const before = changes(db);
  assert.equal(store.authenticate(token), undefined);
  assert.equal(changes(db), before);
});

test("invalid persisted timestamps and invalid clocks fail closed", (t) => {
  const { db, store, setTime } = fixture(t);
  for (const column of ["created_at", "expires_at", "absolute_expires_at", "last_renewed_at"]) {
    for (const value of [null, "", "NaN", "Infinity", "2026-02-30 00:00:00.000", "2026-01-01 garbage"]) {
      if (column === "expires_at" && value === null) continue; // Existing NOT NULL constraint.
      const token = store.create(1);
      db.prepare(`UPDATE sessions SET ${column}=? WHERE token_hash=?`).run(value, hashToken(token));
      const before = changes(db);
      assert.equal(store.authenticate(token), undefined, `${column}=${value}`);
      assert.equal(changes(db), before);
    }
  }
  for (const time of [NaN, Infinity, START + 0.5, 9e15]) {
    setTime(time);
    assert.throws(() => store.create(1), /clock/);
    assert.throws(() => store.authenticate("token"), /clock/);
  }
});

test("legacy migration derives original creation, preserves expiry, and is idempotent", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(users + ";" + legacySchema);
  const insert = db.prepare("INSERT INTO sessions VALUES(?,?,?)");
  insert.run(hashToken("valid"), 1, legacyStamp(START + 5 * DAY)); // Born 25 days ago.
  insert.run(hashToken("expired"), 1, legacyStamp(START - DAY));
  insert.run(hashToken("boundary"), 1, legacyStamp(START));
  insert.run(hashToken("corrupt"), 1, "NaN");
  migrateSessions(db, defaults);
  assert.deepEqual(row(db, "valid"), {
    token_hash: hashToken("valid"), user_id: 1, expires_at: legacyStamp(START + 5 * DAY),
    created_at: stamp(START - 25 * DAY), last_renewed_at: stamp(START - 25 * DAY),
    absolute_expires_at: stamp(START + 65 * DAY),
  });
  const snapshot = db.prepare("SELECT * FROM sessions ORDER BY token_hash").all();
  const before = changes(db);
  migrateSessions(db, readSessionPolicy({ SESSION_ABSOLUTE_DAYS: "180" }));
  assert.deepEqual(db.prepare("SELECT * FROM sessions ORDER BY token_hash").all(), snapshot);
  assert.equal(changes(db), before);
  const store = new SessionStore(db, defaults, () => START);
  for (const token of ["expired", "boundary", "corrupt"]) assert.equal(store.authenticate(token), undefined);
  assert.equal(changes(db), before);
  assert.ok(store.authenticate("valid"));
  assert.equal(row(db, "valid").expires_at, stamp(START + 30 * DAY));
  assert.equal(row(db, "valid").absolute_expires_at, stamp(START + 65 * DAY));
});

test("migration uses historical fixed 30 days, not a newly configured idle duration", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(users + ";" + legacySchema);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hashToken("legacy"), 1, legacyStamp(START + 5 * DAY));
  const policy = readSessionPolicy({ SESSION_IDLE_DAYS: "7", SESSION_ABSOLUTE_DAYS: "45" });
  migrateSessions(db, policy);
  assert.equal(row(db, "legacy").created_at, stamp(START - 25 * DAY));
  assert.equal(row(db, "legacy").absolute_expires_at, stamp(START + 20 * DAY));
  assert.ok(new SessionStore(db, policy, () => START).authenticate("legacy"));
  assert.equal(row(db, "legacy").expires_at, stamp(START + 7 * DAY));
});

test("partially populated or corrupt metadata is never reset from a renewed expires_at", (t) => {
  const { db, store } = fixture(t);
  const token = store.create(1);
  db.prepare("UPDATE sessions SET last_renewed_at=NULL WHERE token_hash=?").run(hashToken(token));
  const before = row(db, token);
  migrateSessions(db, defaults);
  assert.deepEqual(row(db, token), before);
  assert.equal(store.authenticate(token), undefined);
});

test("database reopen and configuration changes never reset migrated absolute lifetime", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fplayer-sessions-"));
  const filename = path.join(directory, "test.db");
  let db = new Database(filename);
  t.after(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(users + ";" + legacySchema);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hashToken("legacy"), 1, legacyStamp(START + 5 * DAY));
  migrateSessions(db, defaults);
  let now = START;
  const first = new SessionStore(db, defaults, () => now);
  for (let day = 0; day < 60; day++) {
    now = START + day * DAY;
    assert.ok(first.authenticate("legacy"));
  }
  const original = row(db, "legacy");
  db.close();
  db = new Database(filename);
  const changed = readSessionPolicy({ SESSION_ABSOLUTE_DAYS: "180" });
  migrateSessions(db, changed);
  assert.deepEqual(row(db, "legacy"), original);
  const restarted = new SessionStore(db, changed, () => now);
  now = START + 65 * DAY - 1;
  assert.ok(restarted.authenticate("legacy"));
  now = START + 65 * DAY;
  assert.equal(restarted.authenticate("legacy"), undefined);
  assert.equal(row(db, "legacy").absolute_expires_at, stamp(START + 65 * DAY));
});
