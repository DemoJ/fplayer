import { db } from "./db.js";

const noise = /\b(?:2160p|1080[pi]|720p|480p|4k|8k|uhd|web[- .]?dl|webrip|bdrip|hdrip|dvdrip|hdtv|bluray|blu[- .]?ray|remux|hdr10?|dv|dolby|atmos|ddp?\d?(?:\.\d)?|h[. ]?26[45]|x26[45]|av1|avc|aac|ac3|nf|imax|proper|repack|v\d|hevc|xvid|dts|truehd|pgs|chs|cht|eng|60fps|10bit)\b.*$/i;
const cnNoise = /(?:高清|超清|蓝光|高码|原盘|国语|粤语|韩语|日语|国英|中字|双字|双语|已完结|全集|未删减|无删减|修复版|重[制置]版).*$/;
const skipRoot = /^(?:dav|media|movies|shows|tv|影视|影视剧|电影|剧集|动画|动漫|综艺|纪录片|网盘|夸克网盘|阿里云盘|天翼云盘|115|baidu|下载)$/i;
const junkDir = /^(?:4k|8k|480|720|1080|2160|hdr|dv|web-?dl|bluray|原轨|内嵌|内封|特效|字幕|简中|简英|简繁|全集|纯享|去头尾广告|杜比|全景声|视界|往期|合集|花絮|预告|正片)/i;
const qualitySuffix = /(?:4k|8k|2160p|1080p|720p|hdr10?|dv|高码|原盘|remux|web[- .]?dl|webrip|bluray|蓝光|重制版|重置版|修复版|合集|正片|中字|内嵌|内封|字幕)/i;
const mediaExt = /\.(?:mp4|mkv|webm|mov|avi|m4v|ts|m2ts|wmv|flv|rmvb|mpg|mpeg|iso)$/i;
const brackets = /[【\[（(].*?[】\]）)]/g;
const yearToken = /(?<!\d)(?:19|20)\d{2}(?![\dpPxX])/;
const resolutions = new Set([480, 540, 720, 1080, 1440, 2160, 4320]);
const cnDigits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnToNumber(raw: string) {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.includes("十")) {
    const [left, right = ""] = raw.split("十");
    return (left ? cnDigits[left] || 0 : 1) * 10 + (right ? cnDigits[right] || 0 : 0);
  }
  return cnDigits[raw] ?? null;
}

// "S02", "Season 2", "第二季". A range such as "S01-S03" is a collection, not a season.
function parseSeason(text: string) {
  const arabic = text.match(/(?:(?:^|[\s._])S(\d{1,2})(?=$|[\s._])|Season\s*(\d{1,2})|第\s*(\d{1,2})\s*季)/i);
  if (arabic) return Number(arabic[1] || arabic[2] || arabic[3]);
  const chinese = text.match(/第\s*([零〇一二两三四五六七八九十]+)\s*季/);
  return chinese ? cnToNumber(chinese[1]) : null;
}

const isYearOrResolution = (value: number) => (value >= 1900 && value <= 2099) || resolutions.has(value);

// "182 4K.mp4", "01.mkv", "03【修复】.mp4": a bare number that is the episode.
function leadingEpisode(stem: string) {
  const match = stem.match(/^(\d{1,4})(.*)$/s);
  if (!match) return null;
  const episode = Number(match[1]);
  const rest = match[2];
  if (isYearOrResolution(episode)) return null;
  if (rest.trim() && !qualitySuffix.test(rest) && !/[()（）【】\[\]]/.test(rest)) return null;
  return episode;
}

// "凡人修仙传101.mp4", "三国演义 01 第一部.mp4": a title followed by a number.
function implicitEpisode(stem: string) {
  // "Toy.Story.3.2010" is a sequel with its release year, not episode 3.
  if (yearToken.test(stem)) return null;
  const text = stem.replace(brackets, " ").replace(/[._]+/g, " ").replace(noise, " ").trim();
  const match = text.match(/^(.*?(?:[^\dA-Za-z\s]|[A-Za-z]{2}\s))\s*(\d{1,4})(?:\s.*)?$/u);
  if (!match || match[1].trim().length < 2) return null;
  const episode = Number(match[2]);
  return isYearOrResolution(episode) ? null : episode;
}

function parseEpisode(stem: string, leading: number | null) {
  const se = stem.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (se) return { season: Number(se[1]) as number | null, episode: Number(se[2]) };
  const explicit = stem.match(/(?<![A-Za-z])(?:EP\s*|E)(\d{1,3})(?!\d)/i)
    || stem.match(/第\s*(\d{1,3})\s*[集话]/)
    || stem.match(/[\[【](\d{1,3})(?:v\d)?[\]】]/i);
  const episode = explicit ? Number(explicit[1]) : leading ?? implicitEpisode(stem);
  return episode == null ? null : { season: null, episode };
}

// Season for a bare-number file name: a numeric parent folder ("权力的游戏/2/3.mp4"),
// otherwise season one as soon as a real title folder is found.
function inferSeason(dirs: string[]) {
  for (const parent of [...dirs].reverse()) {
    if (/^\d{1,2}$/.test(parent)) {
      if (Number(parent) > 0) return Number(parent);
      continue;
    }
    if (dirTitle(parent)) return 1;
  }
  return null;
}

function clean(value: string) {
  const text = value
    .replace(mediaExt, "")
    .replace(/^[A-Z]\s+(?=[一-鿿])/u, "")
    .replace(/[._]+/g, " ")
    .replace(brackets, " ")
    .replace(noise, " ")
    .replace(/\bS\d{1,2}E\d{1,3}\b/gi, " ")
    .replace(/S\d{1,2}\s*[-~到至]\s*S?\d{1,2}(?:全集)?/gi, " ")
    .replace(/\bE\d{1,3}\s*[-~]\s*E?\d{1,3}\b/gi, " ")
    .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
    .replace(/(?<![A-Za-z])S\d{1,2}(?![A-Za-z\d])/g, " ")
    .replace(/第\s*[零〇一二两三四五六七八九十\d]+\s*[-~到至]\s*[零〇一二两三四五六七八九十\d]+\s*季/g, " ")
    .replace(/第\s*[零〇一二两三四五六七八九十\d]+\s*季/g, " ")
    .replace(/第\s*\d{1,4}\s*[集话]/g, " ")
    .replace(/全\d+集/g, " ")
    .replace(/(?:内嵌|内封|特效)?(?:简中|简英|简繁|中英|双语)?字幕/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s[-–~])+\s*$/, "")
    .trim();
  const cut = text.replace(cnNoise, "").trim();
  return cut.length >= 2 ? cut : text;
}

// "Shameless US 2011" -> "Shameless US". A leading year ("2001太空漫游") is part of the name.
function stripYear(title: string) {
  return title.replace(/^(.*\S)\s+(?:19|20)\d{2}(?:\s.*)?$/, "$1").trim();
}

const usable = (title: string) => title.length > 1 && !/^\d+$/.test(title) && !junkDir.test(title);

function dirTitle(name: string) {
  if (/^\d+$/.test(name) || junkDir.test(name)) return "";
  const title = stripYear(clean(name));
  return usable(title) ? title : "";
}

function fileTitle(stem: string) {
  const title = stripYear(clean(stem.split(/[Ss]\d{1,2}[Ee]\d{1,3}/)[0] || stem));
  return usable(title) ? title : "";
}

// The folder that names a show. Normally the nearest titled folder, but
// anything below a season folder ("第二季/自压4K 60帧/01.mkv") is only a
// release variant, so the search starts at the outermost season folder.
function showRoot(dirs: string[]) {
  const seasonIndex = dirs.findIndex((dir) => parseSeason(dir) != null);
  for (let i = seasonIndex >= 0 ? seasonIndex : dirs.length - 1; i >= 0; i--) {
    const title = dirTitle(dirs[i]);
    if (title) return title;
  }
  return "";
}

function nearestDirTitle(dirs: string[]) {
  for (const dir of [...dirs].reverse()) {
    const title = dirTitle(dir);
    if (title) return title;
  }
  return "";
}

function splitPath(filePath: string) {
  const parts = filePath.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, "").split(/[\\/]/).filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const fileName = parts.at(-1) || filePath;
  const dirs = parts.slice(0, -1).filter((part) => !skipRoot.test(part));
  return { parts, fileName, stem: fileName.replace(mediaExt, ""), dirs };
}

function findYear(stem: string, dirs: string[]) {
  for (const text of [stem, ...[...dirs].reverse()]) {
    const match = text.match(yearToken);
    if (match) return Number(match[0]);
  }
  return null;
}

/** Release year written in the file name itself, not inherited from a folder. */
export function fileYear(filePath: string) {
  return findYear(splitPath(filePath).stem, []);
}

export function identify(filePath: string) {
  const { parts, fileName, stem, dirs } = splitPath(filePath);
  let season: number | null = null;
  for (const part of [...parts].reverse()) {
    season = parseSeason(part);
    if (season != null) break;
  }
  const leading = leadingEpisode(stem);
  if (season == null && leading != null) season = inferSeason(dirs);
  const parsed = parseEpisode(stem, season != null ? leading : null);
  const kind = parsed ? "show" : "movie";
  const episode = parsed ? parsed.episode : null;
  season = parsed ? parsed.season ?? season ?? 1 : null;

  let title = kind === "show"
    ? showRoot(dirs) || fileTitle(stem) || clean(dirs[0] || fileName)
    : fileTitle(stem) || nearestDirTitle(dirs) || clean(fileName);
  // "秘密森林2/秘密森林 - S02E01.mkv": the trailing digit is the season, not the name.
  const numbered = title.match(/^(.*[㐀-鿿])\s*(\d)$/u);
  if (numbered && season != null && season >= 2 && Number(numbered[2]) === season) title = numbered[1].trim();
  const year = findYear(stem, dirs);
  const key = `${kind}:${title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`;
  return { title, kind, season, episode, year: year != null && String(year) === title ? null : year, key };
}

// Every name the path offers for a metadata search, best first. A show is
// named by its folder, with the release name in front of "S01E01" as a
// fallback; a movie by its file, with the enclosing folder as a fallback.
export function searchTitles(filePath: string) {
  const { stem, dirs } = splitPath(filePath);
  const item = identify(filePath);
  const [release, marker] = stem.split(/([Ss]\d{1,2}[Ee]\d{1,3})/);
  const alternate = item.kind === "movie" ? nearestDirTitle(dirs) : marker ? fileTitle(release) : "";
  return [...new Set([item.title, alternate].filter(usable))];
}

export function rebuildCatalog(sourceId?: number) {
  const rows = db.prepare(`SELECT id,source_id,path FROM media WHERE available=1 ${sourceId ? "AND source_id=?" : ""}`).all(...(sourceId ? [sourceId] : [])) as Array<{ id: number; source_id: number; path: string }>;
  // A scraped work keeps the title the scraper gave it; only unmatched works
  // follow the title parsed from the path.
  const upsert = db.prepare("INSERT INTO works(source_id,work_key,title,kind,year) VALUES(?,?,?,?,?) ON CONFLICT(source_id,work_key) DO UPDATE SET title=CASE WHEN works.tmdb_id IS NULL THEN excluded.title ELSE works.title END,kind=excluded.kind,year=COALESCE(works.year,excluded.year) RETURNING id");
  const update = db.prepare("UPDATE media SET work_id=?,title=?,kind=?,season=?,episode=? WHERE id=?");
  db.transaction(() => {
    for (const row of rows) {
      const item = identify(row.path);
      const work = upsert.get(row.source_id, item.key, item.title, item.kind, item.year) as { id: number };
      update.run(work.id, item.title, item.kind, item.season, item.episode, row.id);
    }
    db.prepare("DELETE FROM works WHERE NOT EXISTS(SELECT 1 FROM media WHERE media.work_id=works.id AND media.available=1)").run();
  })();
}
