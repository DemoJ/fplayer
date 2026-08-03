import type { Media } from "./api";

// 播放器调试日志：只在开启 debug 时输出，避免生产环境刷控制台。
// 开启方式：localStorage.setItem("fplayer-debug", "1") 后刷新页面。
const DEBUG_KEY = "fplayer-debug";
const debugEnabled = () => typeof localStorage !== "undefined" && localStorage.getItem(DEBUG_KEY) === "1";
export function playerLog(tag: string, ...args: unknown[]) {
  if (!debugEnabled()) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`%c[${ts}] [${tag}]`, "color:#e8a33d", ...args);
}

// Sorts a work's episodes across seasons, keeping the largest file when an
// episode number has multiple versions.
export function sortEpisodes(media: Media[]): Media[] {
  const byKey = new Map<string, Media>();
  for (const item of media) {
    if (item.season == null || item.episode == null) continue;
    const key = `${item.season}-${item.episode}`;
    const existing = byKey.get(key);
    if (!existing || (item.size || 0) > (existing.size || 0)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => (a.season! - b.season!) || (a.episode! - b.episode!));
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// Playback strategy decision, mirroring how Jellyfin/Emby avoid needless
// transcoding:
//   direct    – codec AND container are natively playable in the browser
//               (e.g. h264 in mp4/mov/webm): stream the original file, zero cost.
//   remux     – codec is playable but the container is not (e.g. h264 in MKV):
//               ffmpeg -c copy only rewraps the container; runs near-instantly,
//               no re-encode, negligible encoder/CPU cost.
//   transcode – codec itself is not decodable in the browser (HEVC/AV1...):
//               full re-encode (NVENC) with cached output.
// Unknown codec/container (never probed) falls back to transcode-safe behavior.
export type PlayStrategy = "direct" | "remux" | "transcode";

export function playbackStrategy(codec?: string, container?: string): PlayStrategy {
  const c = (codec || "").toLowerCase();
  const box = (container || "").toLowerCase();
  // Codecs the browser can decode natively over HLS/file streams.
  const playableCodec = /^(h264|avc1|vp8|vp9|av01|av1|theora|mp4v|hev1|hvc1|hevc|h265)/.test(c) || !c;
  if (!playableCodec) return "transcode";
  // HEVC is borderline: modern Chrome on many GPUs decodes it, but older
  // setups and Safari-on-iOS variants do not. The server remux path would
  // produce a stream the browser cannot decode, so re-encode HEVC for safety.
  if (/hev1|hvc1|hevc|h265/i.test(c)) return "transcode";
  // Containers the browser plays directly as a file stream.
  const playableContainer = /^(mp4|m4v|mov|webm|ogv|ogg)$/.test(box) || !box;
  return playableContainer ? "direct" : "remux";
}

// Legacy helper kept for the quality-switch back-to-direct check: a stream may
// only return to direct playback when the file is direct-playable at all.
export function needsTranscode(codec?: string, container?: string) {
  return playbackStrategy(codec, container) !== "direct";
}

export type Quality = "original" | "1080" | "720";
export const QUALITY_LABEL: Record<Quality, string> = { original: "原画", "1080": "1080P", "720": "720P" };

const playerIcon = (d: string) => <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d={d} /></svg>;
export const PLAY_ICON = playerIcon("M8 5v14l11-7z");
export const PAUSE_ICON = playerIcon("M6 5h4v14H6zM14 5h4v14h-4z");
export const SKIP_PREV_ICON = playerIcon("M6 6h2v12H6zm3.5 6l8.5 6V6z");
export const SKIP_NEXT_ICON = playerIcon("M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z");
export const VOLUME_ICON = playerIcon("M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z");
export const MUTED_ICON = playerIcon("M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z");
export const QUALITY_ICON = playerIcon("M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm2-6h4.5c.83 0 1.5.67 1.5 1.5v3c0 .83-.67 1.5-1.5 1.5H13v-6zm1.5 4.5h2v-3h-2v3z");
export const FULLSCREEN_ICON = playerIcon("M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z");
export const FULLSCREEN_EXIT_ICON = playerIcon("M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z");
