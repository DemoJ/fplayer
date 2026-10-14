import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionUser } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_LIFETIME_MS = 30 * DAY_MS;
// Leave ample room for adding the current timestamp within JavaScript's Date range.
const MAX_DURATION_MS = 8.64e15 / 2;
export type SessionPolicy = Readonly<{ idleMs: number; absoluteMs: number; renewIntervalMs: number }>;

export function readSessionPolicy(env: Record<string, string | undefined>): SessionPolicy {
  function duration(name: string, fallback: number, unit: number) {
    const text = env[name]?.trim() ?? String(fallback);
    const value = Number(text);
    const ms = Math.floor(value * unit);
    if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
      || !Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(ms) || ms < 1 || ms > MAX_DURATION_MS) {
      throw new Error(`${name} must be a finite positive number representing at least 1 ms and a supported duration`);
    }
    return ms;
  }
  const idleMs = duration("SESSION_IDLE_DAYS", 30, DAY_MS);
  const absoluteMs = duration("SESSION_ABSOLUTE_DAYS", 90, DAY_MS);
  const renewIntervalMs = duration("SESSION_RENEW_INTERVAL_MINUTES", 60, 60 * 1000);
  if (renewIntervalMs >= idleMs) {
    throw new Error("SESSION_RENEW_INTERVAL_MINUTES must be shorter than SESSION_IDLE_DAYS");
  }
  return Object.freeze({ idleMs, absoluteMs, renewIntervalMs });
}

// Keep expires_at compatible with SQLite's existing UTC datetime text. New
// timestamps include milliseconds so equality is expired, even at subsecond boundaries.
function timestamp(ms: number) {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?$/.test(value)) return NaN;
  const iso = value.replace(" ", "T").replace(/Z$/, "").replace(/(:\d{2})$/, "$1.000") + "Z";
  const ms = Date.parse(iso);
  // Reject normalized invalid dates (e.g. February 30), not just NaN.
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : NaN;
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Transactional and idempotent; never use deployment time as a legacy creation time. */
export function migrateSessions(db: Database.Database, policy: SessionPolicy) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT,
      absolute_expires_at TEXT,
      last_renewed_at TEXT
    )`);
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    for (const name of ["created_at", "absolute_expires_at", "last_renewed_at"]) {
      if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} TEXT`);
    }
    const legacy = db.prepare(`SELECT token_hash, expires_at FROM sessions
      WHERE created_at IS NULL AND absolute_expires_at IS NULL AND last_renewed_at IS NULL`).all() as Array<{ token_hash: string; expires_at: string }>;
    const update = db.prepare(`UPDATE sessions SET created_at=?, absolute_expires_at=?, last_renewed_at=? WHERE token_hash=?`);
    for (const row of legacy) {
      const created = parseTimestamp(row.expires_at) - LEGACY_LIFETIME_MS;
      const absolute = created + policy.absoluteMs;
      // Malformed legacy dates fail closed and are marked migrated too. In
      // particular, no fallback to Date.now() can give a corrupt session new life.
      const valid = Number.isFinite(created) && Number.isFinite(new Date(absolute).getTime());
      update.run(valid ? timestamp(created) : "", valid ? timestamp(absolute) : "", valid ? timestamp(created) : "", row.token_hash);
      // Deliberately leave expires_at untouched, including already-expired rows.
    }
  })();
}

type SessionRow = SessionUser & {
  expires_at: string;
  created_at: string;
  absolute_expires_at: string;
  last_renewed_at: string;
};

export class SessionStore {
  private readonly select;
  private readonly insert;
  private readonly renew;
  private readonly deleteCurrent;
  private readonly deleteOthers;

  constructor(private readonly db: Database.Database, private readonly policy: SessionPolicy, private readonly clock = Date.now) {
    this.select = db.prepare(`SELECT u.id, u.username, u.role, s.expires_at, s.created_at, s.absolute_expires_at, s.last_renewed_at
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`);
    this.insert = db.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,created_at,absolute_expires_at,last_renewed_at) VALUES(?,?,?,?,?,?)`);
    // Compare the exact validated row: a concurrent logout, password change or
    // renewal must not be undone. There is deliberately no INSERT/UPSERT here.
    this.renew = db.prepare(`UPDATE sessions SET expires_at=?, last_renewed_at=?
      WHERE token_hash=? AND expires_at=? AND created_at=? AND absolute_expires_at=? AND last_renewed_at=?`);
    this.deleteCurrent = db.prepare("DELETE FROM sessions WHERE token_hash=?");
    this.deleteOthers = db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?");
  }

  create(userId: number): string {
    const now = this.now();
    const token = newSessionToken();
    this.insert.run(hashToken(token), userId, timestamp(now + Math.min(this.policy.idleMs, this.policy.absoluteMs)),
      timestamp(now), timestamp(now + this.policy.absoluteMs), timestamp(now));
    return token;
  }

  authenticate(token: string): SessionUser | undefined {
    const now = this.now();
    const hash = hashToken(token);
    let row = this.select.get(hash) as SessionRow | undefined;
    if (!this.valid(row, now)) return undefined;
    if (now - parseTimestamp(row.last_renewed_at) >= this.policy.renewIntervalMs) {
      const expires = Math.min(now + this.policy.idleMs, parseTimestamp(row.absolute_expires_at));
      const result = this.renew.run(timestamp(expires), timestamp(now), hash, row.expires_at,
        row.created_at, row.absolute_expires_at, row.last_renewed_at);
      if (!result.changes) {
        // Another connection may have revoked/renewed the row since our read.
        row = this.select.get(hash) as SessionRow | undefined;
        if (!this.valid(row, now)) return undefined;
      }
    }
    return { id: row.id, username: row.username, role: row.role };
  }

  revoke(token: string) {
    this.deleteCurrent.run(hashToken(token));
  }

  revokeOthers(userId: number, currentToken: string) {
    this.deleteOthers.run(userId, hashToken(currentToken));
  }

  private now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new Error("Invalid session clock");
    return now;
  }

  private valid(row: SessionRow | undefined, now: number): row is SessionRow {
    if (!row) return false;
    const created = parseTimestamp(row.created_at);
    const renewed = parseTimestamp(row.last_renewed_at);
    const expires = parseTimestamp(row.expires_at);
    const absolute = parseTimestamp(row.absolute_expires_at);
    return [created, renewed, expires, absolute].every(Number.isFinite)
      && created <= renewed && renewed <= now && created < absolute
      && expires > now && absolute > now;
  }
}
