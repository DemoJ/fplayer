import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, "fplayer.db"));
db.pragma("busy_timeout = 5000");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('local', 'webdav')),
    base_path TEXT NOT NULL,
    username TEXT,
    secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_scan_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'movie',
    season INTEGER,
    episode INTEGER,
    size INTEGER,
    modified_at TEXT,
    duration REAL,
    container TEXT,
    video_codec TEXT,
    audio_codec TEXT,
    available INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, path)
  );
  CREATE TABLE IF NOT EXISTS works (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    work_key TEXT NOT NULL,
    title TEXT NOT NULL,
    original_title TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('movie','show')),
    year INTEGER,
    overview TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    tmdb_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, work_key)
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, media_id)
  );
  CREATE TABLE IF NOT EXISTS scan_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    phase TEXT NOT NULL DEFAULT 'queued',
    discovered INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    result_count INTEGER,
    error TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS metadata_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    phase TEXT NOT NULL DEFAULT 'queued',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    matched INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    current_title TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_media_source ON media(source_id);
  CREATE INDEX IF NOT EXISTS idx_media_title ON media(title);
  CREATE INDEX IF NOT EXISTS idx_works_kind ON works(kind, title);
  CREATE INDEX IF NOT EXISTS idx_scan_jobs_source ON scan_jobs(source_id, id DESC);
`);

// Note: the "mark interrupted jobs as failed on restart" cleanup used to live
// here but ran on every module import, which made `npm test` write to the real
// database. It now runs in index.ts at real startup instead.

const mediaColumns = db.prepare("PRAGMA table_info(media)").all() as Array<{ name: string }>;
const hasColumn = (name: string) => mediaColumns.some((column) => column.name === name);
if (!hasColumn("work_id")) db.exec("ALTER TABLE media ADD COLUMN work_id INTEGER REFERENCES works(id) ON DELETE SET NULL");
if (!hasColumn("subtitle_codec")) db.exec("ALTER TABLE media ADD COLUMN subtitle_codec TEXT");

// origin marks who started a scan: 'manual' (admin clicked) or 'auto'
// (scheduled auto-sync). Auto scans are acknowledged when they finish so they
// never pile up as unread notifications.
const scanJobColumns = db.prepare("PRAGMA table_info(scan_jobs)").all() as Array<{ name: string }>;
if (!scanJobColumns.some((column) => column.name === "origin")) db.exec("ALTER TABLE scan_jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
