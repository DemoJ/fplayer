import { createHash } from "node:crypto";
import { db } from "./db.js";

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
};

export type DoubanSearchItem = {
  sid: string;
  name: string;
  originalName: string;
  year: number;
  rating: number;
  img: string;
  category: string;
  intro: string;
};

type DoubanSettings = {
  cookies: string;
  avoidRiskControl: boolean;
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Origin: "https://movie.douban.com",
  Referer: "https://movie.douban.com/",
};

const SETTINGS_KEY = "douban:settings";
const searchCache = new Map<string, { expires: number; value: DoubanSearchItem[] }>();
const subjectCache = new Map<string, { expires: number; value: DoubanSubject }>();
let sessionCookies = "";

let lastRequestAt = 0;
let guestWindowStart = 0;
let guestWindowCount = 0;
let loginWindowStart = 0;
let loginWindowCount = 0;

const regId = /\/(\d+?)\//;
const regSid = /sid:\s*(\d+)/;
const regCat = /\[(.+?)\]/;
const regYear = /([12][890][0-9]{2})/;
const regTitle = /<title>([\w\W]+?)<\/title>/i;
const regKeywordMeta = /<meta\s+name=["']keywords["']\s+content=["'](.+?)["']/i;
const regOriginalName = /原名[:：](.+?)\s*?\//;
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

function getSetting(key: string) {
  return db.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value: string } | undefined;
}

function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
  ).run(key, value);
}

export function getDoubanSettings(): DoubanSettings {
  const raw = getSetting(SETTINGS_KEY)?.value;
  if (!raw) return { cookies: "", avoidRiskControl: true };
  try {
    const parsed = JSON.parse(raw) as Partial<DoubanSettings>;
    return {
      cookies: String(parsed.cookies || ""),
      avoidRiskControl: parsed.avoidRiskControl !== false,
    };
  } catch {
    return { cookies: "", avoidRiskControl: true };
  }
}

export function saveDoubanSettings(input: Partial<DoubanSettings>) {
  const current = getDoubanSettings();
  const next: DoubanSettings = {
    cookies: input.cookies !== undefined ? String(input.cookies).trim() : current.cookies,
    avoidRiskControl: input.avoidRiskControl !== undefined ? Boolean(input.avoidRiskControl) : current.avoidRiskControl,
  };
  setSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function matchGroup(text: string, reg: RegExp, group = 1) {
  const m = text.match(reg);
  return m?.[group]?.trim() || "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function limitRequest() {
  const settings = getDoubanSettings();
  const now = Date.now();
  const hasCookie = Boolean(settings.cookies);

  if (!settings.avoidRiskControl) {
    const wait = Math.max(0, 200 - (now - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    return;
  }

  if (hasCookie) {
    if (now - loginWindowStart > 60_000) {
      loginWindowStart = now;
      loginWindowCount = 0;
    }
    if (loginWindowCount >= 20) {
      await sleep(loginWindowStart + 60_000 - now + 50);
      loginWindowStart = Date.now();
      loginWindowCount = 0;
    }
    const wait = Math.max(0, 3000 - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    loginWindowCount++;
  } else {
    if (now - guestWindowStart > 60_000) {
      guestWindowStart = now;
      guestWindowCount = 0;
    }
    if (guestWindowCount >= 10) {
      await sleep(guestWindowStart + 60_000 - now + 50);
      guestWindowStart = Date.now();
      guestWindowCount = 0;
    }
    const wait = Math.max(0, 5000 - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    guestWindowCount++;
  }
  lastRequestAt = Date.now();
}

function buildCookieHeader() {
  const settings = getDoubanSettings();
  return mergeCookie(settings.cookies, sessionCookies ? sessionCookies.split("; ").map((p) => p) : []);
}

function extractSetCookies(headers: Headers) {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeCookie(existing: string, setCookies: string[]) {
  const map = new Map<string, string>();
  for (const part of existing.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) map.set(key, value);
  }
  for (const raw of setCookies) {
    const first = raw.includes("=") && !raw.includes("; ") && raw.split("=").length === 2 && !raw.startsWith(" ")
      ? raw
      : raw.split(";")[0];
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const key = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (key) map.set(key, value);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function sha512Hex(input: string) {
  return createHash("sha512").update(input, "utf8").digest("hex");
}

async function solveNonce(data: string, difficulty: number, signal?: AbortSignal) {
  const prefix = "0".repeat(Math.max(0, difficulty));
  let nonce = 0;
  while (true) {
    if (signal?.aborted) throw new Error("aborted");
    nonce++;
    const hash = sha512Hex(data + String(nonce));
    if (hash.startsWith(prefix)) return nonce;
    if ((nonce & 0xfff) === 0) await sleep(0);
  }
}

function parseChallenge(html: string) {
  const tok = matchGroup(html, /(?:id|name)=["']tok["'][^>]*value=["']([^"']+)["']/i)
    || matchGroup(html, /value=["']([^"']+)["'][^>]*(?:id|name)=["']tok["']/i);
  const cha = matchGroup(html, /(?:id|name)=["']cha["'][^>]*value=["']([^"']+)["']/i)
    || matchGroup(html, /value=["']([^"']+)["'][^>]*(?:id|name)=["']cha["']/i);
  const difficultyRaw = matchGroup(html, /(?:id|name)=["']difficulty["'][^>]*value=["']([^"']+)["']/i)
    || matchGroup(html, /value=["']([^"']+)["'][^>]*(?:id|name)=["']difficulty["']/i);
  const difficulty = Number(difficultyRaw || 4) || 4;
  const action = matchGroup(html, /<form[^>]*action=["']([^"']+)["']/i) || "/c";
  return { tok, cha, difficulty, action };
}

async function fetchDouban(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
  await limitRequest();
  const headers = new Headers({ ...DEFAULT_HEADERS, ...(init.headers as Record<string, string> | undefined) });
  const cookie = buildCookieHeader();
  if (cookie) headers.set("Cookie", cookie);

  const response = await fetch(url, { ...init, headers, redirect: "follow" });
  const finalUrl = response.url || url;
  const body = await response.text();

  // Attach body text for callers without re-fetch
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(wrapped, "url", { value: finalUrl });
  (wrapped as Response & { textBody: string }).textBody = body;

  if (!finalUrl.includes("sec.douban.com") || retried) {
    return wrapped;
  }

  if (!body.includes('name="cha"') && !body.includes('id="cha"') && !body.includes('name="tok"')) {
    return wrapped;
  }

  const challenge = parseChallenge(body);
  if (!challenge.cha) return wrapped;

  const sol = await solveNonce(challenge.cha, challenge.difficulty);
  const postUri = challenge.action.startsWith("http")
    ? challenge.action
    : `https://sec.douban.com${challenge.action.startsWith("/") ? "" : "/"}${challenge.action}`;

  const form = new URLSearchParams({
    tok: challenge.tok,
    cha: challenge.cha,
    sol: String(sol),
  });

  const postHeaders = new Headers(DEFAULT_HEADERS);
  postHeaders.set("Content-Type", "application/x-www-form-urlencoded");
  postHeaders.set("Referer", url);
  if (cookie) postHeaders.set("Cookie", cookie);

  const postResp = await fetch(postUri, { method: "POST", headers: postHeaders, body: form, redirect: "manual" });
  const setCookies = extractSetCookies(postResp.headers);
  if (setCookies.length) {
    sessionCookies = mergeCookie(sessionCookies, setCookies);
  }

  return fetchDouban(url, init, true);
}

async function readBody(response: Response) {
  const withBody = response as Response & { textBody?: string };
  if (withBody.textBody !== undefined) return withBody.textBody;
  return response.text();
}

function formatOverview(intro: string) {
  return intro.replace("©豆瓣", "").replace(regOverviewSpace, "\n").trim();
}

function getTitleFromHtml(body: string) {
  const keyword = matchGroup(body, regKeywordMeta);
  if (keyword) {
    const first = keyword.split(",")[0]?.trim();
    if (first) return first;
  }
  return matchGroup(body, regTitle).replace("(豆瓣)", "").trim();
}

function parseSearchHtml(html: string): DoubanSearchItem[] {
  const list: DoubanSearchItem[] = [];
  // MetaShark classic search page
  const blocks = html.split(/class="result"/i).slice(1);
  if (blocks.length) {
    for (const block of blocks) {
      const ratingInfo = matchGroup(block, /class="rating-info"[^>]*>([\s\S]*?)<\/div>/i);
      if (ratingInfo.includes("尚未播出")) continue;
      const rating = Number(matchGroup(block, /class="rating_nums"[^>]*>([^<]*)</i) || 0);
      const img = matchGroup(block, /<img[^>]+src=["']([^"']+)["']/i);
      const onclick = matchGroup(block, /onclick=(?:"[^"]*"|'[^']*')/i);
      const sid = matchGroup(block, regSid) || matchGroup(onclick, regSid) || matchGroup(block, /subject\/(\d+)\//i);
      const name = matchGroup(block, /<div class="title">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i).replace(/<[^>]+>/g, "").trim();
      const titleSpan = matchGroup(block, /<h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
      const cat = matchGroup(titleSpan, regCat);
      const subjectStr = matchGroup(block, /class="rating-info"[\s\S]*?<span[^>]*>([^<]*)<\/span>\s*$/im)
        || matchGroup(block, /rating-info[\s\S]*?<\/span>\s*<span[^>]*>([^<]+)</i);
      const year = Number(matchGroup(subjectStr || block, regYear) || 0);
      const originalName = matchGroup(subjectStr || "", regOriginalName);
      const desc = matchGroup(block, /<p>([\s\S]*?)<\/p>/i).replace(/<[^>]+>/g, "").trim();
      if (!sid || !name) continue;
      if (cat && cat !== "电影" && cat !== "电视剧") continue;
      list.push({
        sid,
        name,
        originalName: originalName || name,
        year,
        rating,
        img,
        category: cat || "电影",
        intro: desc,
      });
    }
    return list;
  }

  // search.douban.com subject_search __DATA__ fallback
  const dataMatch = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!dataMatch) return list;
  try {
    const data = JSON.parse(dataMatch[1]) as {
      error_info?: string;
      items?: Array<{
        id?: number | string;
        title?: string;
        year?: number | string;
        cover_url?: string;
        abstract?: string;
        abstract_2?: string;
        labels?: Array<{ text: string }>;
        rating?: { value?: number };
        tpl_name?: string;
      }>;
    };
    if (data.error_info) throw new Error(data.error_info);
    for (const item of data.items || []) {
      if (!item.title && item.tpl_name !== "search_subject") continue;
      const sid = String(item.id || "");
      if (!sid) continue;
      const labels = (item.labels || []).map((x) => x.text).join(" ");
      const isShow = labels.includes("剧集") || labels.includes("电视剧");
      list.push({
        sid,
        name: String(item.title || "").replace(/‎/g, "").replace(/\(.*?\)/g, " ").replace(/(19|20)\d{2}/g, " ").replace(/\s+/g, " ").trim() || String(item.title),
        originalName: String(item.title || ""),
        year: Number(item.year || matchGroup(String(item.title || ""), regYear) || 0),
        rating: Number(item.rating?.value || 0),
        img: item.cover_url || "",
        category: isShow ? "电视剧" : "电影",
        intro: [item.abstract, item.abstract_2].filter(Boolean).join(" / "),
      });
    }
  } catch {
    // ignore parse errors
  }
  return list;
}

function parseSubjectHtml(sid: string, body: string): DoubanSubject | null {
  if (!body.includes('id="content"') && !body.includes("id=content")) {
    if (body.includes("sec.douban.com") || body.includes("检测到有异常请求")) return null;
  }

  const contentMatch = body.match(/id="content"[\s\S]*$/i) || [body];
  const content = contentMatch[0];
  const nameStr = matchGroup(content, /<h1>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i).replace(/<[^>]+>/g, "").trim();
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
  intro = formatOverview(intro.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));

  const info = matchGroup(content, /id="info"[^>]*>([\s\S]*?)<\/div>/i).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "\n");
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
  };
}

export async function searchDouban(keyword: string, kind?: "movie" | "show"): Promise<DoubanSearchItem[]> {
  if (!keyword.trim()) return [];
  const cacheKey = `search:${kind || "all"}:${keyword.toLocaleLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  // Prefer MetaShark path: www.douban.com/search
  const url = `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(keyword)}`;
  let response = await fetchDouban(url);
  let html = await readBody(response);
  let items = parseSearchHtml(html);

  if (!items.length && (html.includes("sec.douban.com") || html.includes("搜索访问太频繁") || !response.ok)) {
    // Fallback subject_search page
    const alt = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(keyword)}&cat=1002`;
    response = await fetchDouban(alt);
    html = await readBody(response);
    items = parseSearchHtml(html);
  }

  if (!items.length) {
    if (html.includes("sec.douban.com") || html.includes("搜索访问太频繁") || html.includes("检测到有异常请求")) {
      throw new Error("豆瓣触发风控/限流，请在设置中填写 Cookie 并开启防封禁");
    }
  }

  if (kind === "movie") items = items.filter((x) => x.category === "电影");
  if (kind === "show") items = items.filter((x) => x.category === "电视剧");

  if (items.length) {
    searchCache.set(cacheKey, { expires: Date.now() + 5 * 60_000, value: items });
  }
  return items;
}

export async function getDoubanSubject(sid: string): Promise<DoubanSubject | null> {
  if (!sid) return null;
  const cached = subjectCache.get(sid);
  if (cached && cached.expires > Date.now()) return cached.value;

  const url = `https://movie.douban.com/subject/${sid}/`;
  const response = await fetchDouban(url);
  const html = await readBody(response);
  if (!response.ok && response.status !== 200) {
    throw new Error(`豆瓣详情请求失败 (${response.status})`);
  }
  const subject = parseSubjectHtml(sid, html);
  if (!subject) {
    if (html.includes("sec.douban.com") || html.includes("检测到有异常请求")) {
      throw new Error("豆瓣触发风控，可能 IP 被封，请开启防封禁并配置 Cookie");
    }
    throw new Error("无法解析豆瓣详情页（页面结构可能已变更）");
  }
  subjectCache.set(sid, { expires: Date.now() + 30 * 60_000, value: subject });
  return subject;
}

export function pickDoubanMatch(items: DoubanSearchItem[], title: string, kind: string, year?: number | null) {
  const normalized = title.toLocaleLowerCase().replace(/\s+/g, "");
  const scored = items.map((item) => {
    const candidate = item.name.toLocaleLowerCase().replace(/\s+/g, "");
    const original = item.originalName.toLocaleLowerCase().replace(/\s+/g, "");
    let score = 0;
    if (candidate === normalized || original === normalized) score += 80;
    if (candidate.includes(normalized) || normalized.includes(candidate)) score += 50;
    if (original.includes(normalized) || normalized.includes(original)) score += 40;
    if (title && (item.name.includes(title) || title.includes(item.name.split(" ")[0] || ""))) score += 30;
    if (kind === "show" && item.category === "电视剧") score += 20;
    if (kind === "movie" && item.category === "电影") score += 15;
    if (year && item.year === year) score += 25;
    score += Math.min(10, item.rating || 0);
    return { item, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 30 ? scored[0].item : undefined;
}

export async function checkDoubanLogin() {
  try {
    const response = await fetchDouban("https://www.douban.com/mine/");
    const url = (response as Response & { url?: string }).url || "";
    const body = await readBody(response);
    const name = matchGroup(body, /db-usr-profile[\s\S]*?<h1>([^<]+)</i);
    const redirected = /accounts\.douban\.com|sec\.douban\.com|\/login/i.test(url);
    return { isLogined: !redirected && Boolean(name), name: name || "" };
  } catch {
    return { isLogined: false, name: "" };
  }
}
