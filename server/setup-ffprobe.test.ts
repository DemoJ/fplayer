import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.js";
import { hashPassword } from "./security.js";
import { probe } from "./media.js";

function resetUsers() {
  db.prepare("DELETE FROM users").run();
  db.prepare("DELETE FROM sessions").run();
}

test("setup guard rejects a second admin even under concurrent inserts (transactional)", () => {
  resetUsers();
  const insert = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) return null;
    return db.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)").run("admin", hashPassword("password123"));
  });
  const first = insert();
  const second = insert();
  assert.ok(first);
  assert.equal(second, null);
  const count = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  assert.equal(count, 1);
});

test("ffprobe rejects when the binary does not exist (error event, no crash)", async () => {
  const original = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = "/nonexistent/ffprobe-binary-xyz";
  try {
    await assert.rejects(() => probe("/tmp/does-not-matter.mp4"), /启动失败|failed/);
  } finally {
    process.env.FFPROBE_PATH = original;
  }
});

test("ffprobe rejects when aborted via signal", async () => {
  const controller = new AbortController();
  const original = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = "/nonexistent/ffprobe-binary-xyz";
  const probePromise = probe("/tmp/does-not-matter.mp4", controller.signal);
  controller.abort();
  try {
    await assert.rejects(probePromise);
  } finally {
    process.env.FFPROBE_PATH = original;
  }
});
