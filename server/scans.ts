import { db } from "./db.js";
import { scanSource } from "./media.js";
import { rebuildCatalog } from "./catalog.js";
import { startMetadataRefresh } from "./metadata.js";

const controllers = new Map<number, AbortController>();

async function run(jobId: number, sourceId: number) {
  const controller = new AbortController();
  controllers.set(jobId, controller);
  db.prepare("UPDATE scan_jobs SET status='running',phase='starting',started_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").run(jobId);
  try {
    const count = await scanSource(sourceId, controller.signal, (phase, discovered, processed) => {
      db.prepare("UPDATE scan_jobs SET phase=?,discovered=?,processed=? WHERE id=? AND status='running'").run(phase, discovered, processed, jobId);
    });
    rebuildCatalog(sourceId);
    db.prepare("UPDATE scan_jobs SET status='completed',phase='completed',discovered=?,processed=?,result_count=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(count, count, count, jobId);
    // After scan, continue unmatched works in background; already matched titles are skipped.
    startMetadataRefresh();
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
    const message = cancelled ? "扫描已由用户停止" : error instanceof Error ? error.message : "扫描失败";
    db.prepare("UPDATE scan_jobs SET status=?,phase=?,error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : "failed", message, jobId);
    if (!cancelled) db.prepare("UPDATE sources SET last_error=? WHERE id=?").run(message, sourceId);
  } finally {
    controllers.delete(jobId);
  }
}

export function startScan(sourceId: number) {
  const active = db.prepare("SELECT id FROM scan_jobs WHERE source_id=? AND status IN ('queued','running')").get(sourceId) as { id: number } | undefined;
  if (active) return { id: active.id, existing: true };
  const result = db.prepare("INSERT INTO scan_jobs(source_id,status) VALUES(?,'queued')").run(sourceId);
  const id = Number(result.lastInsertRowid);
  setImmediate(() => void run(id, sourceId));
  return { id, existing: false };
}

export function stopScan(jobId: number) {
  const job = db.prepare("SELECT status FROM scan_jobs WHERE id=?").get(jobId) as { status: string } | undefined;
  if (!job || !["queued", "running"].includes(job.status)) return false;
  if (job.status === "queued") db.prepare("UPDATE scan_jobs SET status='cancelled',phase='cancelled',error='扫描已由用户停止',finished_at=CURRENT_TIMESTAMP WHERE id=?").run(jobId);
  controllers.get(jobId)?.abort();
  return true;
}
