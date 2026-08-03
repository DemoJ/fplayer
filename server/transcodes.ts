import fs from "node:fs/promises";
import path from "node:path";
import { ChildProcess } from "node:child_process";

export type SessionState = {
  child: ChildProcess;
  mediaId: number;
  quality: string;
  outputDir: string;
  userId: number;
  lastAccess: number;
  inputAbort?: AbortController | null;
  // Closes the local credential proxy when the session is reclaimed, so the
  // WebDAV credentials never outlive the ffmpeg process they were created for.
  closeProxy?: () => void;
  // Set once ffmpeg has exited; the session may still be held for file access
  // until the reaper reclaims it, but it no longer consumes an encoder slot.
  exited: boolean;
  // Absolute source second the encoder was (re)started from.
  start: number;
  // Segment duration in seconds (6 transcode / 10 remux).
  segSec: number;
};

const sessions = new Map<string, SessionState>();
// Active-session index keyed by `${mediaId}/${quality}` — only one live ffmpeg
// may write a given media/quality cache, otherwise two encoders race on the
// same segment files and double the source traffic.
const sessionIndex = new Map<string, string>();
const MAX_CONCURRENT = 4;
const IDLE_TTL = 5 * 60 * 1000; // 5 min without access -> reclaim
const DISCONNECT_GRACE = 60 * 1000; // keep transcoding 60s after client disconnect

// Only count sessions whose ffmpeg is still running. A finished session lingers
// in the map until the reaper reclaims it; counting it would falsely saturate
// the concurrent transcode limit and reject new requests with 429.
export function activeCount() {
  let count = 0;
  for (const state of sessions.values()) if (!state.exited) count++;
  return count;
}

export function maxConcurrent() {
  return MAX_CONCURRENT;
}

export function register(session: string, state: SessionState) {
  sessions.set(session, state);
  const key = `${state.mediaId}/${state.quality}`;
  sessionIndex.set(key, session);
  state.child.once("close", () => {
    const current = sessions.get(session);
    if (current === state) current.exited = true;
  });
}

function dropIndex(state: SessionState, session: string) {
  const key = `${state.mediaId}/${state.quality}`;
  if (sessionIndex.get(key) === session) sessionIndex.delete(key);
}

export function get(session: string) {
  const state = sessions.get(session);
  if (state) state.lastAccess = Date.now();
  return state;
}

export function owns(session: string, userId: number) {
  return sessions.get(session)?.userId === userId;
}

// Returns the id of the live session transcoding this media/quality, so a
// duplicate request (page refresh, double mount, seek restart) stops it
// instead of spawning a second ffmpeg that pulls the same file again.
export function activeSessionFor(key: string) {
  const session = sessionIndex.get(key);
  if (!session) return undefined;
  const state = sessions.get(session);
  return state && !state.exited ? session : undefined;
}

// Reads the last segment sequence number ffmpeg has written from the playlist
// (cheaper than scanning the directory on every segment request).
export async function producedSeq(outputDir: string): Promise<number> {
  try {
    const text = await fs.readFile(path.join(outputDir, "index.m3u8"), "utf8");
    let last = -1;
    for (const m of text.matchAll(/segment-(\d+)\.ts/g)) last = Math.max(last, Number(m[1]));
    return last;
  } catch {
    return -1;
  }
}

function cleanupState(state: SessionState) {
  try { state.child.kill("SIGKILL"); } catch {}
  state.inputAbort?.abort();
  try { state.closeProxy?.(); } catch {}
  // NOTE: the output directory (transcode cache) is deliberately NOT removed
  // here — cached segments are reused on the next playback of the same
  // position. The cache LRU sweeper reclaims disk space.
}

export function destroy(session: string) {
  const state = sessions.get(session);
  if (!state) return false;
  sessions.delete(session);
  dropIndex(state, session);
  cleanupState(state);
  return true;
}

// Mark a session as possibly idle due to client disconnect; reclaimed after grace
// unless a new request refreshes lastAccess in the meantime.
export function noteDisconnect(session: string) {
  const state = sessions.get(session);
  if (!state) return;
  state.lastAccess = Date.now() - (IDLE_TTL - DISCONNECT_GRACE);
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [session, state] of sessions) {
    if (now - state.lastAccess > IDLE_TTL) {
      sessions.delete(session);
      dropIndex(state, session);
      cleanupState(state);
    }
  }
}, 60 * 1000);
reaper.unref();

// Per-key serialized lock: guarantees a single "start or restart the encoder"
// decision per media/quality at a time, so concurrent segment requests (a seek
// burst, multiple tabs) can never each spawn their own ffmpeg against the same
// cache — the main source of drive rate limiting.
const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Keep the chain alive so the next caller waits for this one, but drop the
  // reference once settled to avoid unbounded growth.
  locks.set(key, run.finally(() => {
    if (locks.get(key) === run) locks.delete(key);
  }));
  return run;
}
