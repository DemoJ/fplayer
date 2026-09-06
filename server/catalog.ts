import { db } from "./db.js";

const noise = /\b(?:2160p|1080p|720p|4k|8k|web[- .]?dl|webrip|bluray|blu[- .]?ray|remux|hdr10?|dv|dolby|atmos|ddp?\d?(?:\.\d)?|h\.?26[45]|x26[45]|av1|aac|nf|imax|proper|repack|v\d|hevc|xvid|dts|truehd|pgs|chs|cht|eng)\b.*$/i;
const skipRoot = /^(?:dav|media|movies|shows|tv|影视|影视剧|电影|剧集|动画|动漫|综艺|纪录片|网盘|夸克网盘|阿里云盘|天翼云盘|115|baidu|下载)$/i;
const junkDir = /^(?:4k|1080p|720p|2160p|hdr|dv|web-?dl|bluray|原轨|内嵌|内封|特效|字幕|简中|简英|简繁|全集|纯享|去头尾广告|杜比|全景声|视界|往期|合集|花絮|预告|正片)/i;
const qualitySuffix = /(?:4k|8k|2160p|1080p|720p|hdr10?|dv|高码|原盘|remux|web[- .]?dl|webrip|bluray|蓝光|重制版|重置版|修复版|合集|正片|中字|内嵌|内封|字幕)/i;
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

function parseSeason(text: string) {
  const arabic = text.match(/(?:^S(\d{1,2})\b|Season\s*(\d{1,2})|第\s*(\d{1,2})\s*季)/i);
  if (arabic) return Number(arabic[1] || arabic[2] || arabic[3]);
  const chinese = text.match(/第\s*([零〇一二两三四五六七八九十]+)\s*季/);
  return chinese ? cnToNumber(chinese[1]) : null;
}

function parseEpisode(text: string, season?: number | null) {
  const se = text.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (se) return { season: Number(se[1]), episode: Number(se[2]) };
  const ep = text.match(/(?:E|EP|第)\s*(\d{1,3})\s*[集话]?/i);
  if (ep) return { season: season ?? null, episode: Number(ep[1]) };
  const numeric = text.match(/^(\d{1,4})(?:\s*[._-]?\s*.*)?$/);
  if (season && numeric && (!numeric[2] || qualitySuffix.test(numeric[2]) || /[()（）【】\[\]]/.test(numeric[2]))) {
    return { season, episode: Number(numeric[1]) };
  }
  return { season: season ?? null, episode: null as number | null };
}

function parseImplicitEpisode(text: string) {
  const stem = text.replace(/\.[^.]+$/, "").trim();
  const match = stem.match(/^(.{2,}?)[ ._-]?(\d{1,4})(?:[ ._-].*)?$/u);
  if (!match || /^\d+$/.test(match[1].trim())) return null;
  const episode = Number(match[2]);
  if (episode >= 1900 && episode <= 2099) return null;
  return { episode, prefix: match[1].trim() };
}

function inferSeasonForNumericEpisode(parts: string[], fileName: string) {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  const numeric = stem.match(/^(\d{1,4})(?:\s*[._-]?\s*.*)?$/);
  if (!numeric || (numeric[2] && !qualitySuffix.test(numeric[2]) && !/[()（）【】\[\]]/.test(numeric[2]))) return null;
  for (const parent of parts.slice(0, -1).reverse()) {
    if (/^\d{1,2}$/.test(parent)) {
      const season = Number(parent);
      if (season > 0) return season;
    }
    const title = clean(parent);
    if (title && !skipRoot.test(title) && !junkDir.test(title) && !/^\d+$/.test(title)) return 1;
  }
  return null;
}

function clean(value: string) {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/^[A-Z]\s+(?=[\u4e00-\u9fff])/u, "")
    .replace(/[._]+/g, " ")
    .replace(/[【\[（(].*?[】\]）)]/g, " ")
    .replace(noise, " ")
    .replace(/\bS\d{1,2}E\d{1,3}\b/gi, " ")
    .replace(/S\d{1,2}\s*[-~到至]\s*S?\d{1,2}(?:全集)?/gi, " ")
    .replace(/第\s*[零〇一二两三四五六七八九十\d]+\s*[-~到至]\s*[零〇一二两三四五六七八九十\d]+\s*季/g, " ")
    .replace(/第\s*[零〇一二两三四五六七八九十\d]+\s*季/g, " ")
    .replace(/全\d+集/g, " ")
    .replace(/(?:内嵌|内封|特效)?(?:简中|简英|简繁|中英|双语)?字幕/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSeasonDir(name: string) {
  return Boolean(parseSeason(name)) || junkDir.test(name) || /^(?:S\d{2}|Season\s*\d+)/i.test(name);
}

function showRoot(parts: string[], fileName: string) {
  const meaningful = parts.filter((part) => !skipRoot.test(part));
  for (let i = meaningful.length - 2; i >= 0; i--) {
    const part = meaningful[i];
    if (isSeasonDir(part) || /^\d+$/.test(part)) continue;
    const title = clean(part);
    if (title && !/^\d+$/.test(title) && title.length > 1) return title;
  }
  const fromFile = clean(fileName.split(/[Ss]\d{1,2}[Ee]\d{1,3}/)[0] || fileName);
  if (fromFile && !/^\d+$/.test(fromFile)) return fromFile;
  return clean(meaningful[0] || fileName);
}

export function identify(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const fileName = parts.at(-1) || filePath;
  let season: number | null = null;
  for (const part of [...parts].reverse()) {
    const found = parseSeason(part);
    if (found != null) {
      season = found;
      break;
    }
  }
  if (season == null) season = inferSeasonForNumericEpisode(parts, fileName);
  let parsed = parseEpisode(fileName, season);
  if (parsed.episode == null) {
    const explicit = fileName.match(/(?:E|EP|第)\s*(\d{1,3})\s*[集话]?/i);
    const implicit = parseImplicitEpisode(fileName);
    if (explicit || implicit) {
      parsed = { season: season ?? 1, episode: Number(explicit?.[1] || implicit?.episode) };
    }
  }
  if (parsed.episode != null && parsed.season == null) parsed.season = 1;
  season = parsed.season;
  const episode = parsed.episode;
  const kind = season && episode ? "show" : "movie";
  const rawTitle = kind === "show" ? showRoot(parts, fileName) : clean(fileName);
  const yearMatch = `${fileName} ${parts.join(" ")}`.match(/(?:19|20)\d{2}/);
  const title = rawTitle.replace(/(?:19|20)\d{2}/g, " ").replace(/\s+/g, " ").trim() || rawTitle;
  const key = `${kind}:${title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`;
  return { title, kind, season, episode, year: yearMatch ? Number(yearMatch[0]) : null, key };
}

export function rebuildCatalog(sourceId?: number) {
  const rows = db.prepare(`SELECT id,source_id,path FROM media WHERE available=1 ${sourceId ? "AND source_id=?" : ""}`).all(...(sourceId ? [sourceId] : [])) as Array<{ id: number; source_id: number; path: string }>;
  const upsert = db.prepare("INSERT INTO works(source_id,work_key,title,kind,year) VALUES(?,?,?,?,?) ON CONFLICT(source_id,work_key) DO UPDATE SET title=excluded.title,kind=excluded.kind,year=COALESCE(works.year,excluded.year) RETURNING id");
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
