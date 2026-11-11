import { createHash } from "node:crypto";
import { getSetting, setSetting } from "./settings.js";
import { matchGroup, parseSearchHtml, parseSubjectHtml, type DoubanSearchItem, type DoubanSubject } from "./douban-parse.js";

export type { DoubanSearchItem, DoubanSubject };

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

export function getDoubanSettings(): DoubanSettings {
  const raw = getSetting(SETTINGS_KEY);
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

// Returns movies and shows alike: the matcher weighs the kind itself, because
// a hard filter here hides the right result whenever the local guess is off.
export async function searchDouban(keyword: string): Promise<DoubanSearchItem[]> {
  if (!keyword.trim()) return [];
  const cacheKey = `search:${keyword.toLocaleLowerCase()}`;
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
