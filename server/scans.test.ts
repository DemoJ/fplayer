import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.js";

// The scan_jobs schema may predate the origin column; the migration in db.ts
// must add it without losing rows. Seed the legacy shape by hand: drop the
// table, recreate it without origin, then re-run the migration SQL.
test("scan_jobs migration adds origin column defaulting to manual", () => {
  db.exec("DROP TABLE scan_jobs");
  db.exec(`CREATE TABLE scan_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'queued',
    discovered INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    result_count INTEGER,
    error TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT
  )`);
  db.exec("INSERT INTO scan_jobs(source_id,status,phase,acknowledged,finished_at) VALUES (1,'completed','completed',0,CURRENT_TIMESTAMP)");
  db.exec("ALTER TABLE scan_jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
  const columns = db.prepare("PRAGMA table_info(scan_jobs)").all().map((column) => column.name);
  assert.ok(columns.includes("origin"));
  assert.equal(db.prepare("SELECT origin FROM scan_jobs").get().origin, "manual");
});

test("auto scans are acknowledged on finish, manual scans are not", () => {
  db.exec("DELETE FROM scan_jobs");
  db.exec("INSERT INTO scan_jobs(id,source_id,status,phase,acknowledged,finished_at,origin) VALUES (101,1,'completed','completed',0,CURRENT_TIMESTAMP,'auto')");
  db.exec("INSERT INTO scan_jobs(id,source_id,status,phase,acknowledged,finished_at,origin) VALUES (102,1,'completed','completed',0,CURRENT_TIMESTAMP,'manual')");
  db.exec("INSERT INTO scan_jobs(id,source_id,status,phase,acknowledged,origin) VALUES (103,1,'running','indexing',0,'manual')");

  // Same statement as acknowledgeIfAuto in scans.ts: only auto jobs silence.
  db.prepare("UPDATE scan_jobs SET acknowledged=1 WHERE id=? AND origin='auto'").run(101);
  assert.equal(db.prepare("SELECT acknowledged FROM scan_jobs WHERE id=101").get().acknowledged, 1);
  assert.equal(db.prepare("SELECT acknowledged FROM scan_jobs WHERE id=102").get().acknowledged, 0);
  assert.equal(db.prepare("SELECT acknowledged FROM scan_jobs WHERE id=103").get().acknowledged, 0);

  // Same statement as POST /api/scans/acknowledge-finished: finished only, active untouched.
  db.prepare("UPDATE scan_jobs SET acknowledged=1 WHERE acknowledged=0 AND status IN ('completed','failed','cancelled')").run();
  assert.equal(db.prepare("SELECT acknowledged FROM scan_jobs WHERE id=103").get().acknowledged, 0);
  assert.deepEqual(db.prepare("SELECT id FROM scan_jobs WHERE acknowledged=0").all().map((row) => row.id), [103]);
});
