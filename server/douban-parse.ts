// Pure HTML parsers for Douban pages. Kept free of network/database access so
// they can be unit-tested against captured markup.

export type DoubanSubject = {
  sid: string;
  name: string;
  originalName: string;
  year: number;
  rating: number;
  img: string;
  intro: string;
  category: string;
  genre: string;
  country: string;
  language: string;
  director: string;
  actor: string;
  writer: string;
  subname: string;
  imdb: string;
  screen: string;
  duration: string;
  /** Every season of the show, from the page's season picker; empty for movies and single-season shows. */
  seasons: Array<{ season: number; sid: string }>;
};

export type DoubanSearchItem = {
  sid: string;
  name: string;
  originalName: string;
  year: number;
  rating: number;
  /** Number of ratings; 0 when Douban shows none. Used as a popularity hint. */
  votes: number;
  img: string;
  category: string;
  intro: string;
};

const regSid = /sid:\s*(\d+)/;
const regCat = /\[(.+?)\]/;
const regYear = /([12][890][0-9]{2})/;
const regTitle = /<title>([\w\W]+?)<\/title>/i;
const regKeywordMeta = /<meta\s+name=["']keywords["']\s+content=["'](.+?)["']/i;
const regOriginalName = /原名[:：]\s*(.+?)\s*(?:\/|$)/;
const regDirector = /导演:\s*(.+)/;
const regWriter = /编剧:\s*(.+)/;
const regActor = /主演:\s*(.+)/;
const regGenre = /类型:\s*(.+)/;
const regCountry = /制片国家\/地区:\s*(.+)/;
const regLanguage = /语言:\s*(.+)/;
const regDuration = /片长:\s*(.+)/;
const regScreen = /(?:上映日期|首播):\s*(.+)/;
const regSubname = /又名:\s*(.+)/;
const regImdb = /IMDb:\s*(tt\d+)/i;
const regOverviewSpace = /\n[^\S\n]+/g;

export function matchGroup(text: string, reg: RegExp, group = 1) {
  const m = text.match(reg);
  return m?.[group]?.trim() || "";
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string) {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => entities[name.toLowerCase()] ?? m)
    // Douban sprinkles invisible direction marks into names.
    .replace(/[‎‏]/g, "");
}

function plainText(html: string) {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function formatOverview(intro: string) {
  return intro.replace("©豆瓣", "").replace(regOverviewSpace, "\n").trim();
}

function getTitleFromHtml(body: string) {
  const keyword = matchGroup(body, regKeywordMeta);
  if (keyword) {
    const first = keyword.split(",")[0]?.trim();
    if (first) return decodeEntities(first);
  }
  return decodeEntities(matchGroup(body, regTitle).replace("(豆瓣)", "").trim());
}

// One block of www.douban.com/search. The cast line looks like
// "原名:Joker / 托德·菲利普斯 / 华金·菲尼克斯 / 2019": original name first,
// release year last.
function parseSearchBlock(block: string): DoubanSearchItem | null {
  const ratingInfo = matchGroup(block, /class="rating-info"[^>]*>([\s\S]*?)<\/div>/i);
  if (ratingInfo.includes("尚未播出")) return null;
  const onclick = matchGroup(block, /onclick=(?:"[^"]*"|'[^']*')/i);
  const sid = matchGroup(block, regSid) || matchGroup(onclick, regSid) || matchGroup(block, /subject(?:\/|%2F)(\d+)/i);
  const name = plainText(matchGroup(block, /<div class="title">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i));
  if (!sid || !name) return null;
  const cat = matchGroup(matchGroup(block, /<h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i), regCat);
  if (cat && cat !== "电影" && cat !== "电视剧") return null;
  const cast = plainText(matchGroup(block, /class="subject-cast"[^>]*>([\s\S]*?)<\/span>/i));
  return {
    sid,
    name,
    originalName: matchGroup(cast, regOriginalName) || name,
    year: Number(matchGroup(cast, /(?:^|\/)\s*([12]\d{3})\s*$/) || 0),
    rating: Number(matchGroup(block, /class="rating_nums"[^>]*>([^<]*)</i) || 0),
    votes: Number(matchGroup(ratingInfo, /\((\d+)人评价\)/) || 0),
    img: matchGroup(block, /<img[^>]+src=["']([^"']+)["']/i),
    category: cat || "电影",
    intro: plainText(matchGroup(block, /<p>([\s\S]*?)<\/p>/i)),
  };
}

type SubjectSearchData = {
  error_info?: string;
  items?: Array<{
    id?: number | string;
    title?: string;
    year?: number | string;
    cover_url?: string;
    abstract?: string;
    abstract_2?: string;
    labels?: Array<{ text: string }>;
    rating?: { value?: number; count?: number };
    tpl_name?: string;
  }>;
};

// Unlike classic search, subject_search joins translated/original names and
// the release year into one title: "小丑 Joker (2019)".
function subjectSearchTitle(rawTitle: string, explicitYear: number) {
  let title = rawTitle.trim();
  let year = explicitYear;
  const dated = title.match(/^(.+?)\s*[（(]\s*([12]\d{3})\s*[）)]\s*$/u);
  if (dated) {
    title = dated[1].trim();
    year ||= Number(dated[2]);
  } else {
    // A bare number may be part of the name (1917, Blade Runner 2049).
    // Remove it only when a separate release-year field corroborates it,
    // and never strip a wholly numeric title or a year inside a longer number.
    const bare = title.match(/^(.+?\D)\s*((?:19|20)\d{2})$/u);
    if (bare && Number(bare[2]) === explicitYear) title = bare[1].trim();
  }
  // Split only the unambiguous Han-title + whitespace + Latin-title form.
  // Keep punctuation, edition/season markers and numeric title parts intact;
  // an internally mixed name such as "阿Q正传" must not become two aliases.
  const bilingual = title.match(/^([^A-Za-z]*\p{Script=Han}[^A-Za-z]*)\s+([A-Za-z][^\p{Script=Han}]*)$/u);
  return {
    name: bilingual?.[1].trim() || title,
    originalName: bilingual?.[2].trim() || title,
    year,
  };
}

// search.douban.com subject_search embeds its results as window.__DATA__.
function parseSubjectSearchData(html: string): DoubanSearchItem[] {
  const dataMatch = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!dataMatch) return [];
  const list: DoubanSearchItem[] = [];
  try {
    const data = JSON.parse(dataMatch[1]) as SubjectSearchData;
    if (data.error_info) return [];
    for (const item of data.items || []) {
      if (!item.title && item.tpl_name !== "search_subject") continue;
      const sid = String(item.id || "");
      if (!sid) continue;
      const rawTitle = decodeEntities(String(item.title || ""));
      const labels = (item.labels || []).map((x) => x.text).join(" ");
      list.push({
        sid,
        ...subjectSearchTitle(rawTitle, Number(item.year) || 0),
        rating: Number(item.rating?.value || 0),
        votes: Number(item.rating?.count || 0),
        img: item.cover_url || "",
        category: labels.includes("剧集") || labels.includes("电视剧") ? "电视剧" : "电影",
        intro: [item.abstract, item.abstract_2].filter(Boolean).join(" / "),
      });
    }
  } catch {
    // ignore parse errors
  }
  return list;
}

export function parseSearchHtml(html: string): DoubanSearchItem[] {
  const blocks = html.split(/class="result"/i).slice(1);
  if (!blocks.length) return parseSubjectSearchData(html);
  return blocks.map(parseSearchBlock).filter((item): item is DoubanSearchItem => item !== null);
}

// <select id="season"><option value="3626006">1</option>...</select>
function parseSeasons(content: string) {
  const select = matchGroup(content, /<select[^>]*id=["']season["'][^>]*>([\s\S]*?)<\/select>/i);
  return [...select.matchAll(/<option[^>]*value=["'](\d+)["'][^>]*>\s*(\d+)\s*</gi)]
    .map((option) => ({ season: Number(option[2]), sid: option[1] }));
}

export function parseSubjectHtml(sid: string, body: string): DoubanSubject | null {
  if (!body.includes('id="content"') && !body.includes("id=content")) {
    if (body.includes("sec.douban.com") || body.includes("检测到有异常请求")) return null;
  }

  const contentMatch = body.match(/id="content"[\s\S]*$/i) || [body];
  const content = contentMatch[0];
  const nameStr = plainText(matchGroup(content, /<h1>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i));
  const name = getTitleFromHtml(body) || nameStr;
  const originalName = nameStr.replace(name, "").trim();
  const year = Number(matchGroup(content, /class="year"[^>]*>\(?([12][890]\d{2})\)?</i) || matchGroup(content, regYear) || 0);
  const rating = Number(matchGroup(content, /class="rating_num"[^>]*>([^<]*)</i) || 0);
  const img = matchGroup(content, /class="nbgnbg"[\s\S]*?<img[^>]+src=["']([^"']+)["']/i)
    || matchGroup(content, /<a[^>]*class="[^"]*nbgnbg[^"]*"[\s\S]*?<img[^>]+src=["']([^"']+)["']/i)
    || matchGroup(content, /property="v:image"[^>]+src=["']([^"']+)["']/i);
  const category = /class="episode_list"/i.test(content) ? "电视剧" : "电影";
  let intro = matchGroup(content, /id="link-report-intra"[\s\S]*?<span[^>]*class="[^"]*all[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    || matchGroup(content, /id="link-report-intra"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)
    || matchGroup(content, /property="v:summary"[^>]*>([\s\S]*?)<\/span>/i);
  intro = formatOverview(decodeEntities(intro.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")));

  const info = decodeEntities(matchGroup(content, /id="info"[^>]*>([\s\S]*?)<\/div>/i).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "\n"));
  return {
    sid,
    name: name || nameStr || sid,
    originalName: originalName || name,
    year,
    rating,
    img: img.replace(/^http:/, "https:"),
    intro,
    category,
    genre: matchGroup(info, regGenre),
    country: matchGroup(info, regCountry),
    language: matchGroup(info, regLanguage),
    director: matchGroup(info, regDirector),
    actor: matchGroup(info, regActor),
    writer: matchGroup(info, regWriter),
    subname: matchGroup(info, regSubname),
    imdb: matchGroup(info, regImdb),
    screen: matchGroup(info, regScreen),
    duration: matchGroup(info, regDuration),
    seasons: parseSeasons(content),
  };
}
