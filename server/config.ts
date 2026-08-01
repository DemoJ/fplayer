import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: path.resolve(process.env.DATA_DIR || "data"),
  appSecret: process.env.APP_SECRET || "",
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  transcodeAcceleration: process.env.TRANSCODE_ACCELERATION || "auto",
  // Window after server start during which the admin account may be created.
  // If a public-facing instance is left uninitialized, an attacker could
  // otherwise claim the admin account first.
  setupWindowMs: Number(process.env.SETUP_WINDOW_MS || 30 * 60 * 1000),
};
