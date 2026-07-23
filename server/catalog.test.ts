import assert from "node:assert/strict";
import test from "node:test";
import { identify } from "./catalog.js";

test("identifies numeric episode under show folder as season one", () => {
  assert.deepEqual(identify("剧集/漫长的季节/1.mkv"), {
    title: "漫长的季节",
    kind: "show",
    season: 1,
    episode: 1,
    year: null,
    key: "show:漫长的季节",
  });
});

test("uses numeric parent folder as season", () => {
  assert.deepEqual(identify("剧集/权力的游戏/2/3.mp4"), {
    title: "权力的游戏",
    kind: "show",
    season: 2,
    episode: 3,
    year: null,
    key: "show:权力的游戏",
  });
});

test("decodes URL path and identifies quality-suffixed episode", () => {
  assert.deepEqual(identify("http://10.8.8.14:5255/%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E5%BD%B1%E8%A7%86%E5%89%A7/%E5%87%A1%E4%BA%BA%E4%BF%AE%E4%BB%99%E4%BC%A0/182%204K.mp4"), {
    title: "凡人修仙传",
    kind: "show",
    season: 1,
    episode: 182,
    year: null,
    key: "show:凡人修仙传",
  });
});

test("handles episode version suffix and archive folder", () => {
  const result = identify("影视剧/凡人修仙传/往期/122 4K高码.mp4");
  assert.equal(result.title, "凡人修仙传");
  assert.equal(result.kind, "show");
  assert.equal(result.season, 1);
  assert.equal(result.episode, 122);
});

test("uses a parent series folder for explicit EP filenames", () => {
  const result = identify("影视剧/凡人修仙传/Fr修仙传.EP171.2160p.WEB-DL.mp4");
  assert.equal(result.title, "凡人修仙传");
  assert.equal(result.kind, "show");
  assert.equal(result.season, 1);
  assert.equal(result.episode, 171);
});

test("recognizes a title followed by an episode number", () => {
  const result = identify("影视剧/凡人修仙传/凡人修仙传101.mp4");
  assert.equal(result.title, "凡人修仙传");
  assert.equal(result.kind, "show");
  assert.equal(result.season, 1);
  assert.equal(result.episode, 101);
});

test("does not treat a movie release year as an episode", () => {
  const result = identify("http://10.8.8.14:5255/%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E5%BD%B1%E8%A7%86%E5%89%A7/%E6%B1%9F%E6%B9%96%E8%AE%BA%E5%89%91%E5%AE%9E%E5%BD%95.A.Stupid.Journey.2014.2160p.WEB-DL.AVC.AAC-NukeHD.mp4");
  assert.equal(result.kind, "movie");
  assert.equal(result.season, null);
  assert.equal(result.episode, null);
  assert.equal(result.year, 2014);
});
