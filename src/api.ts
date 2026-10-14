export type User = { id: number; username: string; role: string };
export type Media = { id: number; title: string; kind: "movie" | "show"; season?: number; episode?: number; duration?: number; size?: number; container?: string; video_codec?: string; audio_codec?: string; position?: number; progress_duration?: number; completed?: number; source_name?: string; source_type?: "local" | "webdav"; path: string; last_watched_at?: string; work_poster?: string; name?: string; work_id?: number };
export type Work = { id: number; title: string; original_title?: string; kind: "movie" | "show"; year?: number; overview?: string; poster_path?: string; backdrop_path?: string; file_count: number; season_count: number };
export type UpNext = { id: number; title: string; kind: "show"; season: number; episode: number; duration?: number; size?: number; container?: string; work_id: number; work_title: string; work_poster?: string; source_name?: string; from_season: number; from_episode: number };
export type Source = { id: number; name: string; type: "local" | "webdav"; base_path: string; username?: string; last_scan_at?: string; last_error?: string; file_count?: number };
export type ScanJob = { id: number; source_id: number; source_name?: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; phase: string; discovered: number; processed: number; result_count: number | null; error: string | null; origin?: "manual" | "auto" };
export type BrowseFolder = { name: string; path: string; file_count: number };
export type BrowseResult = { level: "sources" | "folder"; path: string; crumbs: Array<{ name: string; path: string }>; source?: Source; sources: Source[]; folders: BrowseFolder[]; files: Media[] };

export const tokenKey = "fplayer-token";
export const getToken = () => localStorage.getItem(tokenKey);
export const setToken = (token: string) => localStorage.setItem(tokenKey, token);
export const clearToken = () => localStorage.removeItem(tokenKey);

export class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) { super(message); }
}

let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(handler: (() => void) | null) { onUnauthorized = handler; }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  try {
    response = await fetch(`/api${path}`, { ...options, headers });
  } catch {
    options.signal?.throwIfAborted();
    throw new ApiError("网络连接失败，请检查服务是否运行");
  }
  options.signal?.throwIfAborted();
  if (response.status === 204) return undefined as T;
  let body: any;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    options.signal?.throwIfAborted();
    if (response.ok) throw new ApiError("服务响应异常，请稍后重试", response.status);
  }
  options.signal?.throwIfAborted();
  const route = path.split("?")[0];
  const code = typeof body?.code === "string" ? body.code : undefined;
  const sessionInvalid = response.status === 401 && route !== "/login" && route !== "/setup"
    && (route === "/me" || code === "SESSION_REQUIRED" || code === "SESSION_INVALID");
  if (sessionInvalid) {
    // A late response from an old session must not sign out a newer login.
    if (token && getToken() === token) {
      clearToken();
      onUnauthorized?.();
    }
    throw new ApiError("登录已过期，请重新登录", 401, code || "SESSION_INVALID");
  }
  if (!response.ok) throw new ApiError(typeof body?.error === "string" ? body.error : `请求失败 (${response.status})`, response.status, code);
  return body as T;
}

// Fetch a protected binary resource (poster/artwork) as a blob URL so the token
// stays in the Authorization header instead of leaking into URL history/logs.
const blobCache = new Map<string, string>();
const BLOB_CACHE_MAX = 200;
export async function authUrl(path: string): Promise<string | undefined> {
  const token = getToken();
  if (!token) return undefined;
  const cached = blobCache.get(path);
  if (cached) return cached;
  // poster_path is stored as "/api/posters/..." (already API-qualified), so only
  // prepend /api when the path is a bare API route like "/posters/...".
  const url = path.startsWith("/api/") ? path : `/api${path}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return undefined;
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  // Bounded FIFO cache: revoke the oldest entry so a long-lived session does
  // not leak an unbounded number of object URLs.
  if (blobCache.size >= BLOB_CACHE_MAX) {
    const oldest = blobCache.keys().next().value;
    if (oldest !== undefined) {
      const oldUrl = blobCache.get(oldest);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      blobCache.delete(oldest);
    }
  }
  blobCache.set(path, objectUrl);
  return objectUrl;
}
