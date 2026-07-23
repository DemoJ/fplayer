import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: path.resolve(process.env.DATA_DIR || "data"),
  appSecret: process.env.APP_SECRET || "development-only-change-me",
  secureCookies: process.env.SECURE_COOKIES === "true",
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH || "ffprobe",
};
