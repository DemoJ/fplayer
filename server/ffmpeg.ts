import { spawn } from "node:child_process";
import { config } from "./config.js";

export type TranscodeAcceleration = "cpu" | "nvidia";
export type TranscodeQuality = "original" | "1080" | "720";

// Per-quality scale filter. 4K HEVC transcodes slower than real time on small
// GPUs, so a capped resolution is the default for transcoded playback; users
// can pick a lower one to spare the GPU or "original" for full resolution.
const SCALES: Record<TranscodeQuality, string | null> = {
  original: null,
  "1080": "scale='min(1920,iw)':-2",
  "720": "scale='min(1280,iw)':-2",
};

export function isTranscodeQuality(value: string): value is TranscodeQuality {
  return value === "original" || value === "1080" || value === "720";
}

let detectedAcceleration: Promise<TranscodeAcceleration> | undefined;

function canUseNvidia(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(config.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=size=128x72:rate=1",
      "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-",
    ], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 10000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

export function getTranscodeAcceleration(): Promise<TranscodeAcceleration> {
  if (!detectedAcceleration) {
    detectedAcceleration = (async () => {
      const preference = config.transcodeAcceleration.toLowerCase();
      if (preference === "cpu" || preference === "none" || preference === "off") return "cpu";
      const available = await canUseNvidia();
      if (!available && preference === "nvidia") console.warn("NVIDIA transcoding requested but unavailable; falling back to CPU");
      const acceleration = available ? "nvidia" : "cpu";
      console.log(`FFmpeg transcoding acceleration: ${acceleration}`);
      return acceleration;
    })();
  }
  return detectedAcceleration;
}

export function transcodeArgs(acceleration: TranscodeAcceleration, segmentFile: string, playlistFile: string, input?: string, start = 0, quality: TranscodeQuality = "1080"): string[] {
  // When input is an HTTP URL, let ffmpeg read it directly so it can seek and
  // manage the connection efficiently. Credentials are already embedded in the
  // URL, so no -headers option is needed. Otherwise pipe raw bytes via stdin.
  // -ss before -i seeks the input quickly so resume positions are transcoded
  // immediately instead of waiting for the whole file to process.
  const seekArgs = start > 0 ? ["-ss", String(start)] : [];
  const inputArgs = input
    ? [...seekArgs, "-i", input]
    : acceleration === "nvidia"
      ? [...seekArgs, "-hwaccel", "auto", "-i", "pipe:0"]
      : [...seekArgs, "-i", "pipe:0"];
  const scale = SCALES[quality];
  const video = acceleration === "nvidia"
    ? [...(scale ? ["-vf", scale] : []), "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-pix_fmt", "yuv420p"]
    : [...(scale ? ["-vf", scale] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21"];
  return [
    ...inputArgs,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...video,
    "-c:a", "aac", "-b:a", "192k",
    "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
    "-hls_flags", "independent_segments+omit_endlist",
    "-hls_segment_filename", segmentFile, playlistFile,
  ];
}
