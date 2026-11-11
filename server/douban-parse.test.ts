import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchHtml, parseSubjectHtml } from "./douban-parse.js";
import { pickDoubanMatch } from "./douban-match.js";

// Markup as served by www.douban.com/search?cat=1002, trimmed to two results.
const result = (sid: string, category: string, name: string, rating: string, cast: string) => `
  <div class="result">
    <div class="pic">
      <a class="nbg" href="https://www.douban.com/link2/?url=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F${sid}%2F&amp;query=Joker" onclick="moreurl(this,{i: '0', query: 'Joker', from: 'dou_search_movie', sid: ${sid}, qcat: '1002'})" title="${name}" ><img src="https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2567198874.jpg"></a>
    </div>
    <div class="content">
      <div class="title">
        <h3>
            <span>[${category}]</span>
            &nbsp;<a href="https://www.douban.com/link2/?url=x" target="_blank" onclick="moreurl(this,{sid: ${sid}})" >${name} </a>
        </h3>
  <div class="rating-info">
        ${rating}
        <span class="subject-cast">${cast}</span>
  </div>
      </div>
        <p>湿冷无望的哥谭市...</p>
    </div>
  </div>`;

const page = `<div class="result-list">${
  result("27119724", "电影", "小丑", '<span class="allstar45"></span>\n        <span class="rating_nums">8.7</span>\n          <span>(1143277人评价)</span>', "原名:Joker / 托德·菲利普斯 / 华金·菲尼克斯 / 2019")
}${
  result("550001", "电视剧", "爱，死亡和机器人 第一季", "<span>(暂无评分)</span>", "原名:Love, Death &amp; Robots / 2019")
}${
  result("990001", "书籍", "小丑", "", "某作者 / 2001")
}</div>`;

test("reads original name, year and vote count from a search result", () => {
  const [movie] = parseSearchHtml(page);
  assert.deepEqual(
    { sid: movie.sid, name: movie.name, originalName: movie.originalName, year: movie.year, rating: movie.rating, votes: movie.votes, category: movie.category },
    { sid: "27119724", name: "小丑", originalName: "Joker", year: 2019, rating: 8.7, votes: 1143277, category: "电影" },
  );
});

test("decodes entities and keeps only movies and shows", () => {
  const items = parseSearchHtml(page);
  assert.equal(items.length, 2);
  assert.deepEqual(
    { originalName: items[1].originalName, year: items[1].year, votes: items[1].votes, category: items[1].category },
    { originalName: "Love, Death & Robots", year: 2019, votes: 0, category: "电视剧" },
  );
});

const subjectSearchPage = (title: string, year?: number | string, labels: Array<{ text: string }> = []) =>
  `<script>window.__DATA__ = ${JSON.stringify({ items: [{ id: 27119724, tpl_name: "search_subject", title, year, labels, rating: { value: 8.7, count: 1143284 } }] })};</script>`;

test("matches both names from the real bilingual subject_search title", () => {
  const items = parseSearchHtml(subjectSearchPage("小丑 Joker‎ (2019)"));
  assert.deepEqual(
    { name: items[0].name, originalName: items[0].originalName, year: items[0].year },
    { name: "小丑", originalName: "Joker", year: 2019 },
  );
  for (const title of ["小丑", "Joker"]) {
    assert.equal(pickDoubanMatch(items, { title, kind: "movie", year: 2019 })?.item.sid, "27119724");
    assert.equal(pickDoubanMatch(items, { title, kind: "movie", year: 2012 }), undefined);
  }
});

test("removes a bare trailing year only when the explicit release year confirms it", () => {
  for (const title of ["小丑2019", "小丑 2019", "小丑 (2019)", "小丑（2019）"]) {
    const items = parseSearchHtml(subjectSearchPage(title, "2019"));
    assert.equal(items[0].name, "小丑", title);
    assert.equal(items[0].year, 2019, title);
    assert.ok(pickDoubanMatch(items, { title: "小丑", kind: "movie", year: 2019 }), title);
  }
});

test("reads full-width parenthesized release years without a separate year field", () => {
  const [item] = parseSearchHtml(subjectSearchPage("小丑 Joker（2019）"));
  assert.deepEqual([item.name, item.originalName, item.year], ["小丑", "Joker", 2019]);
});

test("preserves historical release years and rejects a modern remake year", () => {
  const items = parseSearchHtml(subjectSearchPage("火车进站 Arrival of a Train (1896)"));
  assert.deepEqual([items[0].name, items[0].originalName, items[0].year], ["火车进站", "Arrival of a Train", 1896]);
  assert.ok(pickDoubanMatch(items, { title: "火车进站", kind: "movie", year: 1896 }));
  assert.equal(pickDoubanMatch(items, { title: "Arrival of a Train", kind: "movie", year: 2020 }), undefined);
});

test("keeps years and numbers that belong to a movie title", () => {
  for (const [title, year] of [
    ["1917", 2019], ["2012", 2012], ["2001太空漫游", 1968],
    ["2001: A Space Odyssey", 1968], ["夏日1993", 2017],
    ["Blade Runner 2049", 2017], ["Blade Runner 2049", undefined],
    ["小丑2019", undefined], ["作品12019", 2019],
  ] as const) {
    const items = parseSearchHtml(subjectSearchPage(title, year));
    assert.equal(items[0].name, title);
    assert.ok(pickDoubanMatch(items, { title, kind: "movie", year }), title);
  }
  assert.equal(parseSearchHtml(subjectSearchPage("1917 (2019)"))[0].name, "1917");
});

test("preserves editions, season markers and sequel names when splitting bilingual titles", () => {
  const items = parseSearchHtml(subjectSearchPage("无耻之徒(美版) 第十一季 Shameless Season 11 (2020)", undefined, [{ text: "电视剧" }]));
  assert.deepEqual([items[0].name, items[0].originalName, items[0].year], ["无耻之徒(美版) 第十一季", "Shameless Season 11", 2020]);
  assert.ok(pickDoubanMatch(items, { title: "无耻之徒", kind: "show", season: 11, year: 2020 }));
  assert.ok(pickDoubanMatch(items, { title: "Shameless", kind: "show", season: 11, year: 2020 }));
  const sequel = parseSearchHtml(subjectSearchPage("小丑2：双重妄想 Joker: Folie à Deux (2024)"));
  assert.deepEqual([sequel[0].name, sequel[0].originalName], ["小丑2：双重妄想", "Joker: Folie à Deux"]);
  assert.equal(pickDoubanMatch(sequel, { title: "小丑", kind: "movie", year: 2019 }), undefined);
  assert.equal(parseSearchHtml(subjectSearchPage("阿Q正传 (1981)"))[0].name, "阿Q正传");
});

test("reads the season picker of a subject page", () => {
  const body = `<div id="content"><h1><span property="v:itemreviewed">无耻之徒(美版) 第十一季</span><span class="year">(2020)</span></h1>
    <div id="info"><span class="pl">季数:</span> <select id="season"><option value="4937314">1</option><option value="34948243" selected="selected">11</option></select><br/></div></div>`;
  assert.deepEqual(parseSubjectHtml("34948243", body)?.seasons, [{ season: 1, sid: "4937314" }, { season: 11, sid: "34948243" }]);
  assert.deepEqual(parseSubjectHtml("1", `<div id="content"><h1><span>小丑</span></h1><div id="info"></div></div>`)?.seasons, []);
});
