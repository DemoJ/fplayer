import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";
import { config } from "./config.js";

type SessionState = {
  child: ChildProcess;
  outputDir: string;
  userId: number;
  lastAccess: number;
  inputStream?: ReadableStream<Uint8Array> | null;
  inputAbort?: AbortController | null;
};

const sessions = new Map<string, SessionState>();
const MAX_CONCURRENT = 4;
const IDLE_TTL = 5 * 60 * 1000; // 5 min without access -> reclaim
const DISCONNECT_GRACE = 60 * 1000; // keep transcoding 60s after client disconnect

export function activeCount() {
  return sessions.size;
}

export function maxConcurrent() {
  return MAX_CONCURRENT;
}

export function register(session: string, state: SessionState) {
  sessions.set(session, state);
}

export function get(session: string) {
  const state = sessions.get(session);
  if (state) state.lastAccess = Date.now();
  return state;
}

export function owns(session: string, userId: number) {
  return sessions.get(session)?.userId === userId;
}

function cleanupState(state: SessionState) {
  try { state.child.kill("SIGKILL"); } catch {}
  state.inputAbort?.abort();
  // Best-effort directory removal; fire and forget.
  fs.rm(state.outputDir, { recursive: true, force: true }).catch(() => {});
}

export function destroy(session: string) {
  const state = sessions.get(session);
  if (!state) return false;
  sessions.delete(session);
  cleanupState(state);
  return true;
}

// Mark a session as possibly idle due to client disconnect; reclaimed after grace
// unless a new request refreshes lastAccess in the meantime.
export function noteDisconnect(session: string) {
  const state = sessions.get(session);
  if (!state) return;
  // Pretend the session is near the idle TTL so the reaper will reclaim it after
  // the disconnect grace, while still allowing a fresh request to refresh it.
  state.lastAccess = Date.now() - (IDLE_TTL - DISCONNECT_GRACE);
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [session, state] of sessions) {
    if (now - state.lastAccess > IDLE_TTL) {
      sessions.delete(session);
      cleanupState(state);
    }
  }
}, 60 * 1000);
reaper.unref();

export async function ensureDir(session: string) {
  const outputDir = path.join(config.dataDir, "transcodes", session);
  await fs.mkdir(outputDir, { recursive: true });
  return outputDir;
}

export function fileExists(full: string) {
  return fsSync.existsSync(full);
}
