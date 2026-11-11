import assert from "node:assert/strict";
import test from "node:test";
import { pickDoubanMatch, splitSeason, type MatchQuery } from "./douban-match.js";
import type { DoubanSearchItem } from "./douban-parse.js";

// Rows copied from real Douban searches, in the order Douban returned them.
// The one exception is sid 990011: the American first season sits on a later
// result page, so it is added by hand.
const item = (sid: string, category: string, name: string, originalName: string, year: number, votes = 0): DoubanSearchItem =>
  ({ sid, category, name, originalName, year, votes, rating: 0, img: "", intro: "" });

const joker = [
  item("27119724", "电影", "小丑", "Joker", 2019, 1143277),
  item("34909341", "电影", "小丑2：双重妄想", "Joker: Folie à Deux", 2024, 105019),
  item("4861542", "电视剧", "不被原谅的搜查官", "ジョーカー 許されざる捜査官", 2010, 12425),
  item("25812325", "电影", "Joker", "Joker", 2014, 190),
  item("10355337", "电影", "印度王牌", "Joker", 2012),
];
const knivesOut = [
  item("30318116", "电影", "利刃出鞘", "Knives Out", 2019, 902296),
  item("34939037", "电影", "利刃出鞘2", "Glass Onion: A Knives Out Mystery", 2022, 172372),
  item("37200213", "电影", "Knives Out", "Knives Out", 2016),
];
const shameless = [
  item("1474087", "电视剧", "无耻之徒 第一季", "Shameless", 2004, 20628),
  item("34948243", "电视剧", "无耻之徒(美版) 第十一季", "Shameless", 2020, 70632),
  item("25831924", "电视剧", "无耻之徒(美版) 第五季", "Shameless", 2015, 85287),
  item("990011", "电视剧", "无耻之徒(美版) 第一季", "Shameless", 2011, 150000),
];
const blackMirror = [
  item("7054120", "电视剧", "黑镜 第一季", "Black Mirror", 2011, 460160),
  item("36653963", "电视剧", "黑镜 第七季", "Black Mirror", 2025, 130946),
  item("25964630", "电影", "黑镜：圣诞特别篇", "Black Mirror: White Christmas", 2014, 139979),
  item("26984403", "电影", "黑镜", "Black Mirror", 2014),
];
const secretForest = [
  item("26934346", "电视剧", "秘密森林", "비밀의 숲", 2017, 214566),
  item("34815544", "电视剧", "秘密森林2", "비밀의숲2", 2020, 92184),
  item("36680644", "电视剧", "好或坏的东载", "좋거나 나쁜 동재", 2024, 12690),
];

const pick = (items: DoubanSearchItem[], query: MatchQuery) => pickDoubanMatch(items, query)?.item.sid;

test("matches an English file name against the original name and year", () => {
  assert.equal(pick(joker, { title: "Joker", kind: "movie", year: 2019 }), "27119724");
  assert.equal(pick(knivesOut, { title: "Knives Out", kind: "movie", year: 2019 }), "30318116");
  assert.equal(pick(joker, { title: "joker folie a deux", kind: "movie", year: 2024 }), "34909341");
});

test("prefers the well-known title when the year is unknown", () => {
  assert.equal(pick(joker, { title: "Joker", kind: "movie" }), "27119724");
});

test("rejects results that do not resemble the title", () => {
  assert.equal(pick(secretForest, { title: "111最新4～6集", kind: "show", year: 2024, season: 2 }), undefined);
  assert.equal(pick(joker, { title: "自压奈飞", kind: "show" }), undefined);
  assert.equal(pick([], { title: "Joker", kind: "movie" }), undefined);
});

test("rejects a same-named work from a different year", () => {
  assert.equal(pick([joker[3]], { title: "Joker", kind: "movie", year: 2019 }), undefined);
});

test("picks the wanted season of a show", () => {
  assert.equal(pick(blackMirror, { title: "黑镜", kind: "show", year: 2011, season: 1 }), "7054120");
  assert.equal(pick(blackMirror, { title: "黑镜", kind: "show", season: 7 }), "36653963");
  assert.equal(pick(secretForest, { title: "秘密森林", kind: "show", year: 2017, season: 1 }), "26934346");
});

test("tells the American remake from the British original by year", () => {
  assert.equal(pick(shameless, { title: "无耻之徒", kind: "show", year: 2011, season: 1 }), "990011");
  // Without the right season on the page, a wrong season of the right show
  // still beats the right season of the wrong show.
  const fallback = pick(shameless.slice(0, 3), { title: "无耻之徒", kind: "show", year: 2011, season: 1 });
  assert.ok(fallback === "34948243" || fallback === "25831924", `got ${fallback}`);
});

test("lets the folder name outvote an ambiguous file name", () => {
  const byFile = pickDoubanMatch(blackMirror, { title: "Black Mirror", kind: "movie", year: 2014 });
  const byFolder = pickDoubanMatch(blackMirror, { title: "黑镜：圣诞特别篇", kind: "movie", year: 2014 });
  assert.equal(byFolder?.item.sid, "25964630");
  assert.ok(byFolder && byFile && byFolder.score > byFile.score);
});

test("splits season markers off Douban names", () => {
  assert.deepEqual(splitSeason("无耻之徒(美版) 第十一季"), { base: "无耻之徒(美版)", season: 11 });
  assert.deepEqual(splitSeason("Arcane Season 2"), { base: "Arcane", season: 2 });
  assert.deepEqual(splitSeason("秘密森林2"), { base: "秘密森林", season: 2 });
  assert.deepEqual(splitSeason("天道"), { base: "天道", season: 1 });
});
