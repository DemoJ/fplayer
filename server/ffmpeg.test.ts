import assert from "node:assert/strict";
import test from "node:test";
import { transcodeArgs } from "./ffmpeg.js";

test("NVIDIA transcoding enables automatic hardware decoding and NVENC", () => {
  const args = transcodeArgs("nvidia", "segment.ts", "index.m3u8");
  assert.deepEqual(args.slice(0, 4), ["-hwaccel", "auto", "-i", "pipe:0"]);
  assert.ok(args.includes("h264_nvenc"));
  assert.ok(!args.includes("libx264"));
});

test("CPU transcoding retains the libx264 fallback", () => {
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8");
  assert.deepEqual(args.slice(0, 2), ["-i", "pipe:0"]);
  assert.ok(args.includes("libx264"));
  assert.ok(!args.includes("h264_nvenc"));
});

test("HTTP input passes URL to ffmpeg directly instead of stdin", () => {
  const url = "http://example.com/video.mkv";
  const args = transcodeArgs("nvidia", "segment.ts", "index.m3u8", url);
  assert.deepEqual(args.slice(0, 2), ["-i", url]);
  assert.ok(!args.includes("-headers"));
  assert.ok(args.includes(url));
  assert.ok(!args.includes("pipe:0"));
  assert.ok(args.includes("h264_nvenc"));
});

test("resume offset seeks the input before opening it", () => {
  const url = "http://example.com/video.mkv";
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8", url, 893);
  assert.deepEqual(args.slice(0, 4), ["-ss", "893", "-i", url]);
  const stdin = transcodeArgs("cpu", "segment.ts", "index.m3u8", undefined, 893);
  assert.deepEqual(stdin.slice(0, 4), ["-ss", "893", "-i", "pipe:0"]);
  const noOffset = transcodeArgs("nvidia", "segment.ts", "index.m3u8");
  assert.ok(!noOffset.includes("-ss"));
});

test("quality selects the scale filter", () => {
  const url = "http://example.com/video.mkv";
  const args1080 = transcodeArgs("nvidia", "segment.ts", "index.m3u8", url, 0, "1080");
  const i = args1080.indexOf("-vf");
  assert.ok(i > -1);
  assert.match(args1080[i + 1], /1920/);
  const args720 = transcodeArgs("cpu", "segment.ts", "index.m3u8", url, 0, "720");
  assert.match(args720[args720.indexOf("-vf") + 1], /1280/);
  const original = transcodeArgs("cpu", "segment.ts", "index.m3u8", url, 0, "original");
  assert.ok(!original.includes("-vf"));
});

test("persistent cache keeps all segments and never trims the playlist", () => {
  const args = transcodeArgs("nvidia", "segment.ts", "index.m3u8");
  const flags = args.join(" ");
  // Cache mode: -hls_list_size 0 keeps every segment and the full playlist on
  // disk so a replayed window is served without touching the source drive.
  assert.ok(flags.includes("-hls_list_size 0"));
  // Segments must survive the session (persistent cache), so delete_segments
  // is intentionally absent.
  assert.ok(!flags.includes("delete_segments"));
  // Continuation support: appends to the existing playlist and resumes the
  // segment sequence from start_number.
  assert.ok(flags.includes("append_list"));
});

test("remux mode stream-copies the video instead of re-encoding", () => {
  const args = transcodeArgs("nvidia", "segment.ts", "index.m3u8", undefined, 0, "1080", undefined, "remux");
  assert.ok(args.includes("-c:v"));
  assert.ok(args.includes("copy"));
  assert.ok(!args.includes("h264_nvenc"));
  assert.ok(!args.includes("libx264"));
  // Remux keeps a larger segment target; no scale filter is applied.
  assert.ok(!args.includes("-vf"));
  assert.ok(args.includes("-hls_time"));
});

test("remux continues the segment sequence from start_number", () => {
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8", undefined, 300, "original", undefined, "remux", 17);
  assert.deepEqual(args.slice(0, 4), ["-ss", "300", "-i", "pipe:0"]);
  assert.ok(args.includes("-start_number"));
  assert.ok(args.includes("17"));
});

test("text subtitles are mapped into the HLS stream as WebVTT", () => {
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8", undefined, 0, "1080", "srt");
  assert.ok(args.includes("0:s:0?"));
  assert.ok(args.includes("webvtt"));
  assert.ok(args.includes("-c:s"));
});

test("bitmap subtitles (PGS/DVD) are skipped rather than failing the transcode", () => {
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8", undefined, 0, "1080", "hdmv_pgs_subtitle");
  assert.ok(!args.includes("0:s:0?"));
  assert.ok(!args.includes("webvtt"));
  const unknown = transcodeArgs("cpu", "segment.ts", "index.m3u8", undefined, 0, "1080", undefined);
  assert.ok(!unknown.includes("0:s:0?"));
});

test("HTTP input with CPU acceleration also reads URL directly", () => {
  const url = "http://example.com/video.mkv";
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8", url);
  assert.ok(args.includes(url));
  assert.ok(!args.includes("pipe:0"));
  assert.ok(args.includes("libx264"));
});
