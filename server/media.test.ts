import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { deleteWorkEntirely } from "./media.js";

// Lives inside DATA_DIR so `npm test` wipes it between runs.
const fixtureRoot = path.join(config.dataDir, "work-delete-fixture");

async function makeFile(relPath: string) {
  const full = path.join(fixtureRoot, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, "data");
  return full;
}

function insertSource(name: string) {
  return Number(db.prepare("INSERT INTO sources(name,type,base_path) VALUES(?,?,?)").run(name, "local", fixtureRoot).lastInsertRowid);
}

function insertWork(sourceId: number, key: string, title: string, kind: "movie" | "show") {
  return Number(db.prepare("INSERT INTO works(source_id,work_key,title,kind) VALUES(?,?,?,?)").run(sourceId, key, title, kind).lastInsertRowid);
}

function insertMedia(sourceId: number, workId: number, relPath: string, season: number | null = null, episode: number | null = null) {
  return Number(db.prepare("INSERT INTO media(source_id,path,title,kind,season,episode,work_id) VALUES(?,?,?,?,?,?,?)").run(
    sourceId, relPath, path.basename(relPath), season ? "show" : "movie", season, episode, workId,
  ).lastInsertRowid);
}

async function exists(relPath: string) {
  try { await fs.access(path.join(fixtureRoot, relPath)); return true; } catch { return false; }
}

test("deletes the topmost folder that belongs only to the work, then the DB rows", async () => {
  const sourceId = insertSource("delete-work-basic");
  const workId = insertWork(sourceId, "show:测试剧", "测试剧", "show");
  const otherWorkId = insertWork(sourceId, "show:另一剧", "另一剧", "show");
  await makeFile("测试剧/S01/e01.mkv");
  await makeFile("测试剧/S02/e01.mkv");
  await makeFile("测试剧/poster.jpg");
  await makeFile("另一剧/e01.mkv");
  insertMedia(sourceId, workId, "测试剧/S01/e01.mkv", 1, 1);
  insertMedia(sourceId, workId, "测试剧/S02/e01.mkv", 2, 1);
  insertMedia(sourceId, otherWorkId, "另一剧/e01.mkv", 1, 1);

  const result = await deleteWorkEntirely(workId);

  assert.deepEqual(result.folders, ["测试剧"]);
  assert.equal(await exists("测试剧"), false);
  assert.equal(await exists("测试剧/poster.jpg"), false);
  assert.equal(await exists("另一剧/e01.mkv"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM media WHERE work_id=?").get(workId).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM works WHERE id=?").get(workId).c, 0);
});

test("falls back to per-file deletion when another work shares the folder", async () => {
  const sourceId = insertSource("delete-work-shared");
  const workA = insertWork(sourceId, "show:同目录A", "同目录A", "show");
  const workB = insertWork(sourceId, "show:同目录B", "同目录B", "show");
  await makeFile("共享/A1.mkv");
  await makeFile("共享/B1.mkv");
  insertMedia(sourceId, workA, "共享/A1.mkv", 1, 1);
  insertMedia(sourceId, workB, "共享/B1.mkv", 1, 1);

  const result = await deleteWorkEntirely(workA);

  assert.deepEqual(result.folders, []);
  assert.equal(result.files, 1);
  assert.equal(await exists("共享/A1.mkv"), false);
  assert.equal(await exists("共享/B1.mkv"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM works WHERE id=?").get(workA).c, 0);
});

test("normalizes backslash paths and still removes the whole series folder", async () => {
  const sourceId = insertSource("delete-work-backslash");
  const workId = insertWork(sourceId, "show:反斜杠剧", "反斜杠剧", "show");
  await makeFile("反斜杠剧/S01/e01.mkv");
  await makeFile("反斜杠剧/S02/e01.mkv");
  const mediaA = insertMedia(sourceId, workId, "反斜杠剧\\S01\\e01.mkv", 1, 1);
  insertMedia(sourceId, workId, "反斜杠剧\\S02\\e01.mkv", 2, 1);
  const userId = Number(db.prepare("INSERT INTO users(username,password_hash) VALUES('delete-work-user','x')").run().lastInsertRowid);
  db.prepare("INSERT INTO progress(user_id,media_id,position,duration) VALUES(?,?,?,?)").run(userId, mediaA, 10, 100);

  const result = await deleteWorkEntirely(workId);

  assert.deepEqual(result.folders, ["反斜杠剧"]);
  assert.equal(await exists("反斜杠剧"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM progress WHERE media_id=?").get(mediaA).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM works WHERE id=?").get(workId).c, 0);
});

test("deletes files one by one when they sit in the source root, and keeps the root", async () => {
  const sourceId = insertSource("delete-work-root-flat");
  const workId = insertWork(sourceId, "show:平铺剧", "平铺剧", "show");
  await makeFile("平铺剧 e01.mkv");
  await makeFile("平铺剧 e02.mkv");
  const mediaA = insertMedia(sourceId, workId, "平铺剧 e01.mkv", 1, 1);
  insertMedia(sourceId, workId, "平铺剧 e02.mkv", 1, 2);

  const result = await deleteWorkEntirely(workId);

  assert.deepEqual(result.folders, []);
  assert.equal(result.files, 2);
  assert.equal(await exists("平铺剧 e01.mkv"), false);
  assert.equal(await exists("平铺剧 e02.mkv"), false);
  assert.equal(await exists(""), true, "source root itself must survive");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM progress WHERE media_id=?").get(mediaA).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM works WHERE id=?").get(workId).c, 0);
});
