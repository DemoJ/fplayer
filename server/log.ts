// Minimal structured logging helper. Each line carries a stable tag so
// playback/transcode flows can be traced in `docker compose logs`.
//   [transcode] 转码/缓存生命周期
//   [cache]     缓存命中/续传/清理
//   [segment]   段/playlist 请求
//   [player]    前端播放器状态机（见 src/lib.tsx 的同名 helper）
const ts = () => new Date().toISOString().slice(11, 23);

export function log(tag: string, ...args: unknown[]) {
  console.log(`[${ts()}] [${tag}]`, ...args);
}

export function warn(tag: string, ...args: unknown[]) {
  console.warn(`[${ts()}] [${tag}]`, ...args);
}

export function error(tag: string, ...args: unknown[]) {
  console.error(`[${ts()}] [${tag}]`, ...args);
}
