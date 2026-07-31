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
  assert.ok(args.includes("-headers"));
  assert.ok(args.includes(url));
  assert.ok(args.includes("-i"));
  assert.ok(!args.includes("pipe:0"));
  assert.ok(args.includes("h264_nvenc"));
});

test("HTTP input with CPU acceleration also reads URL directly", () => {
  const url = "http://example.com/video.mkv";
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8", url);
  assert.ok(args.includes(url));
  assert.ok(!args.includes("pipe:0"));
  assert.ok(args.includes("libx264"));
});
