import type { Request } from "express";

export type SessionUser = { id: number; username: string; role: string };
export type AuthRequest = Request & { user?: SessionUser };

export type Source = {
  id: number;
  name: string;
  type: "local" | "webdav";
  base_path: string;
  username: string | null;
  secret: string | null;
  enabled: number;
  last_scan_at: string | null;
  last_error: string | null;
};

export type ScanJob = {
  id: number;
  source_id: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  discovered: number;
  processed: number;
  result_count: number | null;
  error: string | null;
  acknowledged: number;
  created_at: string;
  finished_at: string | null;
};
