import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchHtml, parseSubjectHtml } from "./douban-parse.js";

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

test("reads the season picker of a subject page", () => {
  const body = `<div id="content"><h1><span property="v:itemreviewed">无耻之徒(美版) 第十一季</span><span class="year">(2020)</span></h1>
    <div id="info"><span class="pl">季数:</span> <select id="season"><option value="4937314">1</option><option value="34948243" selected="selected">11</option></select><br/></div></div>`;
  assert.deepEqual(parseSubjectHtml("34948243", body)?.seasons, [{ season: 1, sid: "4937314" }, { season: 11, sid: "34948243" }]);
  assert.deepEqual(parseSubjectHtml("1", `<div id="content"><h1><span>小丑</span></h1><div id="info"></div></div>`)?.seasons, []);
});
