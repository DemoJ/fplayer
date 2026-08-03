import assert from "node:assert/strict";
import test from "node:test";
import { absSeq, blockHead, contiguousFrom, buildPlaylist, TRANSCODE_SEGMENT_SECONDS, REMUX_SEGMENT_SECONDS, segSecFor } from "./transcode-cache.js";

test("segSecFor picks the per-mode segment duration", () => {
  assert.equal(segSecFor("transcode"), TRANSCODE_SEGMENT_SECONDS);
  assert.equal(segSecFor("remux"), REMUX_SEGMENT_SECONDS);
});

test("absSeq maps a source second to an absolute segment number", () => {
  assert.equal(absSeq(0, 6), 0);
  assert.equal(absSeq(5.9, 6), 0);
  assert.equal(absSeq(6, 6), 1);
  // 22:00 = 1320s -> 1320/6 = 220
  assert.equal(absSeq(1320, 6), 220);
  assert.equal(absSeq(1560, 6), 260);
  // remux segments are 10s
  assert.equal(absSeq(300, 10), 30);
});

test("contiguousFrom returns the run of consecutive segments from a start", () => {
  const segs = [10, 11, 12, 13, 20, 21];
  assert.deepEqual(contiguousFrom(segs, 10), [10, 11, 12, 13]);
  // Run stops at the first hole.
  assert.deepEqual(contiguousFrom(segs, 12), [12, 13]);
  assert.deepEqual(contiguousFrom(segs, 20), [20, 21]);
  assert.deepEqual(contiguousFrom(segs, 5), []);
  assert.deepEqual(contiguousFrom([], 0), []);
});

test("blockHead walks back to the start of the cached block containing a target", () => {
  const segs = [10, 11, 12, 20, 21];
  assert.equal(blockHead(segs, 12), 10);
  assert.equal(blockHead(segs, 10), 10);
  // Un-cached target is its own block head.
  assert.equal(blockHead(segs, 15), 15);
  assert.equal(blockHead(segs, 22), 22);
  assert.equal(blockHead([], 0), 0);
});

test("buildPlaylist renders signed segment URLs with ENDLIST control", () => {
  const sign = (file: string) => `sig-${file}`;
  const out = buildPlaylist(1, "1080", [220, 221], 6, false, sign);
  assert.ok(out.startsWith("#EXTM3U\n"));
  assert.ok(out.includes("#EXT-X-MEDIA-SEQUENCE:220"));
  assert.ok(out.includes("#EXTINF:6.000,"));
  assert.ok(out.includes("segment-220.ts?sig=sig-segment-220.ts"));
  assert.ok(out.includes("segment-221.ts?sig=sig-segment-221.ts"));
  assert.ok(!out.includes("#EXT-X-ENDLIST"));
});

test("buildPlaylist appends ENDLIST when the cache is complete", () => {
  const sign = (file: string) => `sig-${file}`;
  const out = buildPlaylist(1, "1080", [0, 1, 2], 6, true, sign);
  assert.ok(out.trimEnd().endsWith("#EXT-X-ENDLIST"));
});

// The user-reported scenario: resume at 26:00, seek back to 22:00. Both are
// inside the SAME cache block, so the aggregate playlist head stays at the
// block start and the seek is served from disk with zero drive traffic.
test("backward seek within a cached block keeps the block head as playlist start", () => {
  const segs = [];
  // Cache covers 22:00..27:00 -> seqs 220..270
  for (let s = 220; s <= 270; s++) segs.push(s);
  const resumeAt = absSeq(26 * 60, 6); // 260
  const seekBackTo = absSeq(22 * 60, 6); // 220
  assert.equal(blockHead(segs, resumeAt), 220);
  assert.equal(blockHead(segs, seekBackTo), 220);
  // Aggregate playlist lists the whole contiguous run.
  const listed = contiguousFrom(segs, blockHead(segs, seekBackTo));
  assert.equal(listed.length, 51);
  assert.equal(listed[0], 220);
});

// Forward seek beyond the cached block: the target is un-cached, so it becomes
// its own new block head, and segments before it are excluded from the
// aggregate playlist (no hole hls.js could stall on).
test("forward seek beyond cache starts a fresh block at the target", () => {
  const segs = [220, 221, 222];
  const forward = absSeq(30 * 60, 6); // 300, un-cached
  assert.equal(blockHead(segs, forward), 300);
  assert.deepEqual(contiguousFrom(segs, 300), []);
});

// Forward seek lands on a cached segment inside the block: block head is the
// block start, so hls.js can load that segment directly.
test("seek into the middle of a cached block resolves to the block head", () => {
  const segs = [];
  for (let s = 220; s <= 270; s++) segs.push(s);
  const target = 250;
  assert.equal(blockHead(segs, target), 220);
});
