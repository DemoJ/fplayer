import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";

const DEFAULT_SECRET = "development-only-change-me";
let encryptionKey: Buffer | null = null;
let signingKey: Buffer | null = null;

function loadKeys() {
  if (encryptionKey && signingKey) return;
  if (config.appSecret && config.appSecret !== DEFAULT_SECRET) {
    const material = createHash("sha256").update(config.appSecret).digest();
    encryptionKey = material;
    signingKey = createHash("sha256").update("sign:" + config.appSecret).digest();
    return;
  }
  // No explicit APP_SECRET: persist a per-instance random secret so credentials
  // are not decryptable with the public default value. Lazily read/created in DB.
  const row = db.prepare("SELECT value FROM app_settings WHERE key=?").get("instance_secret") as { value: string } | undefined;
  let secret = row?.value;
  if (!secret) {
    secret = randomBytes(48).toString("base64url");
    db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('instance_secret',?)").run(secret);
  }
  encryptionKey = createHash("sha256").update(secret).digest();
  signingKey = createHash("sha256").update("sign:" + secret).digest();
  if (!config.appSecret || config.appSecret === DEFAULT_SECRET) {
    console.warn("[FPlayer] 未设置 APP_SECRET，已自动生成并持久化实例密钥。生产环境建议设置 APP_SECRET 环境变量以便密钥不依赖数据库。");
  }
}

function keyForEncrypt() { loadKeys(); return encryptionKey!; }
function keyForSign() { loadKeys(); return signingKey!; }

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyForEncrypt(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string | null) {
  if (!value) return "";
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", keyForEncrypt(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Short-lived HMAC-signed token for HLS segment URLs so the main session token
// is never placed in the playlist/segment URL or access logs.
const SIGN_TTL = 4 * 60 * 60 * 1000; // 4 hours
export function signTranscode(session: string, file: string) {
  const exp = Date.now() + SIGN_TTL;
  const payload = `${session}|${file}|${exp}`;
  const sig = createHmac("sha256", keyForSign()).update(payload).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifyTranscodeSig(session: string, file: string, token: string) {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `${session}|${file}|${exp}`;
  const expected = createHmac("sha256", keyForSign()).update(payload).digest("base64url");
  if (sig.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}
