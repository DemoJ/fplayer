import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.js";
import { rebuildCatalog } from "./catalog.js";
import { buildSearchTerms, resetOutdatedMatches, siblingSeason } from "./metadata.js";

test("searches the Chinese half of a mixed title first, then the wanted season", () => {
  assert.deepEqual(buildSearchTerms(["无耻之徒 Shameless US", "Shameless US"], "show", 1), [
    { search: "无耻之徒", title: "无耻之徒" },
    { search: "无耻之徒 第一季", title: "无耻之徒" },
    { search: "无耻之徒 Shameless US", title: "无耻之徒 Shameless US" },
    { search: "Shameless US", title: "Shameless US" },
  ]);
});

test("keeps punctuation in an all-Chinese title and adds no season for movies", () => {
  assert.deepEqual(buildSearchTerms(["爱，死亡和机器人"], "show", 2).map((term) => term.search), ["爱，死亡和机器人", "爱，死亡和机器人 第二季"]);
  assert.deepEqual(buildSearchTerms(["Knives Out", "利刃出鞘1"], "movie").map((term) => term.search), ["Knives Out", "利刃出鞘1"]);
});

test("a scraped work keeps its title across rebuilds until matches are reset", () => {
  const source = Number(db.prepare("INSERT INTO sources(name,type,base_path) VALUES('meta-test','local','/meta-test')").run().lastInsertRowid);
  try {
    db.prepare("INSERT INTO media(source_id,path,title) VALUES(?,?,?)").run(source, "/meta-test/利刃出鞘1（2019）/Knives.Out.2019.1080p.mp4", "x");
    rebuildCatalog(source);
    const work = () => db.prepare("SELECT title,year,tmdb_id,overview FROM works WHERE source_id=?").get(source) as { title: string; year: number | null; tmdb_id: number | null; overview: string | null };
    assert.deepEqual(work(), { title: "Knives Out", year: 2019, tmdb_id: null, overview: null });

    db.prepare("UPDATE works SET title='利刃出鞘',tmdb_id=30318116,overview='简介' WHERE source_id=?").run(source);
    rebuildCatalog(source);
    assert.equal(work().title, "利刃出鞘");

    db.prepare("DELETE FROM app_settings WHERE key='metadata:matcher_version'").run();
    assert.ok(resetOutdatedMatches() >= 1);
    assert.equal(resetOutdatedMatches(), 0);
    rebuildCatalog(source);
    assert.deepEqual(work(), { title: "Knives Out", year: 2019, tmdb_id: null, overview: null });
  } finally {
    db.prepare("DELETE FROM sources WHERE id=?").run(source);
  }
});

test("follows the season picker when search returned another season", () => {
  const seasons = [{ season: 1, sid: "4937314" }, { season: 11, sid: "34948243" }];
  assert.equal(siblingSeason({ sid: "34948243", name: "无耻之徒(美版) 第十一季", seasons }, 1), "4937314");
  assert.equal(siblingSeason({ sid: "34948243", name: "无耻之徒(美版) 第十一季", seasons }, 11), undefined);
  assert.equal(siblingSeason({ sid: "34948243", name: "无耻之徒(美版) 第十一季", seasons: [] }, 1), undefined);
});
