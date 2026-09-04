import { db } from "./db.js";
import { startScan } from "./scans.js";
import { log } from "./log.js";

const DEFAULT_INTERVAL_MINUTES = 15;

type SyncSettings = {
  enabled: boolean;
  intervalMinutes: number;
};

function readSettings(): SyncSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='auto_sync'").get() as { value: string } | undefined;
  if (!row) return { enabled: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES };
  try {
    const parsed = JSON.parse(row.value) as Partial<SyncSettings>;
    return {
      enabled: parsed.enabled !== false,
      intervalMinutes: Math.max(1, Number(parsed.intervalMinutes) || DEFAULT_INTERVAL_MINUTES),
    };
  } catch {
    return { enabled: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES };
  }
}

export function getAutoSyncSettings(): SyncSettings {
  return readSettings();
}

export function saveAutoSyncSettings(settings: SyncSettings) {
  db.prepare("INSERT INTO app_settings(key,value) VALUES('auto_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(settings));
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const { enabled } = readSettings();
    if (!enabled) return;
    const sources = db.prepare("SELECT id FROM sources WHERE enabled=1").all() as Array<{ id: number }>;
    for (const { id } of sources) {
      const active = db.prepare("SELECT 1 FROM scan_jobs WHERE source_id=? AND status IN ('queued','running')").get(id);
      if (active) continue;
      startScan(id);
      log("sync", `auto-sync started scan for source ${id}`);
    }
  } catch (error) {
    log("sync", `auto-sync tick failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
  }
}

export function startAutoSync() {
  const { intervalMinutes } = readSettings();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), intervalMinutes * 60 * 1000);
  timer.unref?.();
  log("sync", `auto-sync started, interval ${intervalMinutes}m`);
  // Kick off an immediate tick so first-time users don't wait a full interval.
  void tick();
}

export function restartAutoSync() {
  startAutoSync();
}
