export type User = { id: number; username: string; role: string };
export type Media = { id: number; title: string; kind: "movie" | "show"; season?: number; episode?: number; duration?: number; size?: number; container?: string; video_codec?: string; audio_codec?: string; position?: number; progress_duration?: number; completed?: number; source_name?: string; path: string; last_watched_at?: string; work_poster?: string; name?: string; work_id?: number };
export type Work = { id: number; title: string; original_title?: string; kind: "movie" | "show"; year?: number; overview?: string; poster_path?: string; backdrop_path?: string; file_count: number; season_count: number; };
export type Source = { id: number; name: string; type: "local" | "webdav"; base_path: string; username?: string; last_scan_at?: string; last_error?: string; file_count?: number };
export type ScanJob = { id: number; source_id: number; source_name?: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; phase: string; discovered: number; processed: number; result_count: number | null; error: string | null };
export type BrowseFolder = { name: string; path: string; file_count: number };
export type BrowseResult = { level: "sources" | "folder"; path: string; crumbs: Array<{ name: string; path: string }>; source?: Source; sources: Source[]; folders: BrowseFolder[]; files: Media[] };

const tokenKey = "fplayer-token";
export const getToken = () => localStorage.getItem(tokenKey);
export const setToken = (token: string) => localStorage.setItem(tokenKey, token);
export const clearToken = () => localStorage.removeItem(tokenKey);

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}
