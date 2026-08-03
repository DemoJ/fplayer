import { spawn } from "node:child_process";
import { config } from "./config.js";

export type TranscodeAcceleration = "cpu" | "nvidia";
export type TranscodeQuality = "original" | "1080" | "720";
// remux = stream copy (container change only, no re-encode) for codecs the
// browser can decode but whose container it cannot play (e.g. h264 in MKV).
// transcode = full re-encode (e.g. HEVC).
export type TranscodeMode = "transcode" | "remux";

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

export function isTranscodeMode(value: string): value is TranscodeMode {
  return value === "transcode" || value === "remux";
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

// Builds ffmpeg args for a persistent, absolutely-addressed segment cache.
//
// Every segment is named after the absolute source second it begins at
// (segment-{absSeq}.ts), and the encoder is pinned to a fixed GOP so segment
// boundaries fall exactly on segSec multiples. Combined with temp_file
// (segments are written to a .tmp then renamed), the cache can list which
// segments are complete just by looking at the directory — no partial files.
// Seeking back into cached territory then serves those segments straight off
// disk, and the aggregate playlist is rebuilt from the file listing.
export function transcodeArgs(
  acceleration: TranscodeAcceleration,
  segmentFile: string,
  playlistFile: string,
  input?: string,
  start = 0,
  quality: TranscodeQuality = "1080",
  subtitleCodec?: string | null,
  mode: TranscodeMode = "transcode",
  startNumber = 0,
  segSec = mode === "remux" ? 10 : 6,
): string[] {
  const seekArgs = start > 0 ? ["-ss", String(start)] : [];
  const inputArgs = input
    ? [...seekArgs, "-i", input]
    : acceleration === "nvidia"
      ? [...seekArgs, "-hwaccel", "auto", "-i", "pipe:0"]
      : [...seekArgs, "-i", "pipe:0"];
  const scale = SCALES[quality];
  // HLS only carries text subtitles (WebVTT). PGS/DVD bitmap subs can't be
  // converted by ffmpeg and would fail the whole transcode, so only map the
  // track when we know it is text-based (from the cached probe result).
  const textSubtitle = subtitleCodec ? /^(?:srt|subrip|ass|ssa|webvtt|text|mov_text)$/i.test(subtitleCodec) : false;
  const subtitle = textSubtitle ? ["-map", "0:s:0?", "-c:s", "webvtt"] : [];
  const video = mode === "remux"
    ? ["-c:v", "copy"]
    : acceleration === "nvidia"
      ? [...(scale ? ["-vf", scale] : []), "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-pix_fmt", "yuv420p"]
      : [...(scale ? ["-vf", scale] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21"];
  // Fixed GOP aligned to the segment target: every segSec seconds a keyframe,
  // so segment boundaries land exactly on segSec multiples and the segment
  // number is a reliable map of source time. Force it for transcodes; remux
  // (stream copy) keeps the source GOP, which is already keyframe-based.
  const gop = mode === "remux" ? [] : ["-g", String(segSec * 25), "-force_key_frames", `expr:gte(t,n_forced*${segSec})`];
  return [
    ...inputArgs,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...subtitle,
    ...video,
    ...gop,
    "-c:a", "aac", "-b:a", "192k",
    "-f", "hls", "-hls_time", String(segSec),
    // Persistent cache: keep every segment on disk and never trim the playlist
    // — replaying the same window replays these files without touching the
    // drive. start_number continues the absolute sequence when appending.
    "-start_number", String(startNumber),
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments+omit_endlist+append_list+temp_file",
    "-hls_segment_filename", segmentFile, playlistFile,
  ];
}
