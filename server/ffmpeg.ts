import { spawn } from "node:child_process";
import { config } from "./config.js";

export type TranscodeAcceleration = "cpu" | "nvidia";

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

export function transcodeArgs(acceleration: TranscodeAcceleration, segmentFile: string, playlistFile: string, input?: string): string[] {
  // When input is an HTTP URL, let ffmpeg read it directly so it can seek and
  // manage the connection efficiently. Otherwise pipe raw bytes via stdin.
  const inputArgs = input
    ? ["-headers", input, "-i", input]
    : acceleration === "nvidia"
      ? ["-hwaccel", "auto", "-i", "pipe:0"]
      : ["-i", "pipe:0"];
  const video = acceleration === "nvidia"
    ? ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"];
  return [
    ...inputArgs,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...video,
    "-c:a", "aac", "-b:a", "192k",
    "-f", "hls", "-hls_time", "4", "-hls_list_size", "6",
    "-hls_flags", "delete_segments+independent_segments+omit_endlist",
    "-hls_segment_filename", segmentFile, playlistFile,
  ];
}
