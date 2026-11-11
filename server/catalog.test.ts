import assert from "node:assert/strict";
import test from "node:test";
import { identify, searchTitles } from "./catalog.js";

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

const root = "/dav/夸克网盘/影视剧/";

test("names a show by its season folder, not by a release-variant subfolder", () => {
  for (const file of [
    "英雄联盟：双城之战 第二季（2024）/111最新4～6集/Arcane S2 [04][Webrip_2160p][x265_2E-AC-3_2SRT].mkv",
    "英雄联盟：双城之战 第二季（2024）/[NF][4K][超分][2160p][简繁内封字幕]【单集4G起】【无删减】【推荐】/Arcane S2 [04][Webrip_2160p][x265_2E-AC-3_2SRT].mkv",
    "英雄联盟：双城之战 第二季（2024）/自压奈飞4K 60帧/04.mkv",
    "英雄联盟：双城之战 第二季（2024）/Season 2（4K 杜比视界 国英双语）/S02E04.2024.2160p.WEB-DL.H265.DV.DDP5.1.Atmos.2Audio.mkv",
  ]) {
    const result = identify(root + file);
    assert.deepEqual([result.key, result.season, result.episode], ["show:英雄联盟-双城之战", 2, 4], file);
  }
});

test("merges per-season release folders into one show", () => {
  const first = identify(`${root}无耻之徒/无耻之徒S01.Shameless.US.2011.1080p.Blu-ray.x265.AC3￡cXcY@FRDS/Shameless.US.S01E01.2011.1080p.Blu-ray.x265.10bit.AC3￡cXcY@FRDS.mkv`);
  const tenth = identify(`${root}无耻之徒/无耻之徒S10.Shameless.US.2019.1080p.WEB-DL.x265.AC3￡cXcY@FRDS/Shameless.US.S10E01.2019.1080p.WEB_DL.x265.10bit.AC3￡cXcY@FRDS.mkv`);
  assert.equal(first.title, "无耻之徒 Shameless US");
  assert.equal(first.key, tenth.key);
  assert.deepEqual([first.season, first.year, tenth.season, tenth.year], [1, 2011, 10, 2019]);

  const second = identify(`${root}秘密森林.2017.1080P.韩语.中字[1-2合集]/秘密森林2(2020) 1080P 韩语中字 【16集已完结】/秘密森林 - S02E01 - 第1集.mkv`);
  assert.deepEqual([second.key, second.season, second.episode], ["show:秘密森林", 2, 1]);
});

test("strips size and quality words from a show folder", () => {
  const result = identify(`${root}天道高清21G/天道EP01.mkv`);
  assert.deepEqual([result.title, result.season, result.episode], ["天道", 1, 1]);
});

test("does not read codecs, resolutions or years as episode numbers", () => {
  for (const file of [
    "小丑/S01/Joker (2019) BDRIP.1080P.H264.DTS.特效中英双字.mkv",
    "小丑/S01/Joker.2019.2160p.mp4",
    "小丑/1080内嵌官方中字.mp4",
    "小丑/2024.2160p.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX.mkv",
    "黑镜/黑镜：圣诞特别篇/Black.Mirror.2014.V2.1080p.NF.WEB-DL.H264.DDP-NexusNF.mkv",
  ]) {
    const result = identify(root + file);
    assert.deepEqual([result.kind, result.season, result.episode], ["movie", null, null], file);
  }
  assert.equal(identify(`${root}小丑/S01/Joker (2019) BDRIP.1080P.H264.DTS.特效中英双字.mkv`).title, "Joker");
});

test("falls back to the folder when a movie file name carries no title", () => {
  assert.equal(identify(`${root}小丑/1080内嵌官方中字.mp4`).title, "小丑");
});

test("offers the folder name as a second search title for movies", () => {
  assert.deepEqual(searchTitles(`${root}利刃出鞘1（2019）/Knives.Out.2019.1080p.UHD.BluRay.x265..mp4`), ["Knives Out", "利刃出鞘1"]);
  assert.deepEqual(searchTitles(`${root}黑镜/黑镜：圣诞特别篇/Black.Mirror.2014.V2.1080p.NF.WEB-DL.H264.DDP-NexusNF.mkv`), ["Black Mirror", "黑镜：圣诞特别篇"]);
  assert.deepEqual(searchTitles(`${root}我的团长我的团 (2009) 4K/The.Chief.Show.S01E01.2009.2160p.WEB-DL.H265.AAC-ZerTV.mp4`), ["我的团长我的团", "The Chief Show"]);
  assert.deepEqual(searchTitles(`${root}凡人修仙传/往期/凡人修仙传102.mp4`), ["凡人修仙传"]);
});
