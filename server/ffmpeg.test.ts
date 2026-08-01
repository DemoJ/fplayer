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

test("keeps all segments so the player never loses its position", () => {
  const args = transcodeArgs("nvidia", "segment.ts", "index.m3u8");
  const flags = args.join(" ");
  assert.ok(flags.includes("-hls_list_size"));
  assert.ok(!flags.includes("delete_segments"));
  assert.ok(!flags.includes("hls_list_size 6"));
});

test("HTTP input with CPU acceleration also reads URL directly", () => {
  const url = "http://example.com/video.mkv";
  const args = transcodeArgs("cpu", "segment.ts", "index.m3u8", url);
  assert.ok(args.includes(url));
  assert.ok(!args.includes("pipe:0"));
  assert.ok(args.includes("libx264"));
});
