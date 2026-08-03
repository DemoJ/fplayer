// End-to-end smoke test: spawns the real server (dist-server) as a child
// process against a temp data dir with a local source, then exercises the
// transcode pipeline the way the player does:
//   probe -> transcode(start) -> aggregate playlist -> segment requests
//   -> backward seek -> playlist head verification.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const DATA_DIR = process.env.DATA_DIR || "/tmp/fplayer-e2e/data";
const PORT = Number(process.env.PORT || 3100);
const MEDIA = "/tmp/fplayer-e2e/media.mp4";

if (!existsSync(MEDIA)) {
  console.error("missing media file");
  process.exit(1);
}
mkdirSync(DATA_DIR, { recursive: true });

const base = `http://127.0.0.1:${PORT}`;
let token = "";

async function api(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body) headers["Content-Type"] = "application/json";
  const url = path.startsWith("http") ? path : path.startsWith("/api/") ? `${base}${path}` : `${base}/api${path}`;
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: res.status, body };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/api/setup`);
      if (res.status) return;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("server did not come up");
}

async function main() {
  const child = spawn("node", ["dist-server/index.js"], {
    env: { ...process.env, DATA_DIR, PORT: String(PORT), TRANSCODE_ACCELERATION: "cpu", APP_SECRET: "e2e-test-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  const exit = new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));

  try {
    await waitForServer();

    // 1. setup + login
    let r = await api("/setup", { method: "POST", body: JSON.stringify({ username: "admin", password: "password123" }) });
    if (r.status !== 200 && r.status !== 409) throw new Error(`setup: ${r.status} ${JSON.stringify(r.body)}`);
    r = await api("/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "password123" }) });
    token = r.body.token;
    if (!token) throw new Error("login failed");

    // 2. source + scan
    r = await api("/sources", { method: "POST", body: JSON.stringify({ name: "local", type: "local", basePath: "/tmp/fplayer-e2e" }) });
    if (r.status !== 200) throw new Error(`source: ${JSON.stringify(r.body)}`);
    await api(`/sources/${r.body.id}/scan`, { method: "POST" });
    await new Promise((res) => setTimeout(res, 2500));

    // 3. find media
    r = await api("/media?q=media");
    const media = (r.body as any[]).find((m) => m.title.includes("media"));
    if (!media) throw new Error("media not found");
    console.log(`media id=${media.id} title=${media.title}`);

    // 4. probe
    r = await api(`/media/${media.id}/probe`, { method: "POST" });
    if (r.status !== 200) throw new Error(`probe: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`probed codec=${r.body.media.video_codec} container=${r.body.media.container} duration=${r.body.media.duration}`);

    // 5. transcode at 60s (1:00)
    r = await api(`/media/${media.id}/transcode`, { method: "POST", body: JSON.stringify({ start: 60, quality: "1080", mode: "transcode" }) });
    if (r.status !== 200) throw new Error(`transcode: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`transcode start=${r.body.start} cached=${r.body.cached} session=${r.body.session}`);
    const playlist = r.body.playlist;

    // 6. fetch aggregate playlist
    r = await api(playlist);
    if (r.status !== 200) throw new Error(`playlist fetch: ${r.status}`);
    const plText = String(r.body);
    const segUrls = plText.split("\n").filter((l) => l.includes("segment-"));
    if (!segUrls.length) throw new Error("no segments in playlist");
    console.log(`playlist head seq=${segUrls[0].match(/segment-(\d+)/)?.[1]} segments=${segUrls.length}`);

    // 7. fetch first two segments (may need retries as encoder warms)
    const segBase = playlist.split("?")[0].replace("/index.m3u8", ""); // .../api/transcode/1/1080
    for (let i = 0; i < 2 && i < segUrls.length; i++) {
      let s = 0;
      let rseg: any;
      for (; s < 20; s++) {
        rseg = await api(`${segBase}/${segUrls[i]}`);
        if (rseg.status === 200) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      if (s >= 20) throw new Error(`segment[${i}] never became ready: ${rseg.status}`);
      console.log(`segment[${i}] OK bytes=${String(rseg.body).length}`);
    }

    // 8. backward seek to 30s (0:30) — seq 5, block head should be <= 5
    r = await api(`/media/${media.id}/transcode`, { method: "POST", body: JSON.stringify({ start: 30, quality: "1080", mode: "transcode" }) });
    if (r.status !== 200) throw new Error(`backward transcode: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`backward seek start=${r.body.start} cached=${r.body.cached}`);
    const pl2 = await api(r.body.playlist);
    const segs2 = String(pl2.body).split("\n").filter((l) => l.includes("segment-"));
    const headSeq = segs2.length ? Number(segs2[0].match(/segment-(\d+)/)?.[1]) : -1;
    console.log(`backward playlist head seq=${headSeq} (${headSeq * 6}s), requested 30s`);
    if (headSeq < 0 || headSeq * 6 > 30) throw new Error(`playlist head ${headSeq * 6}s should be <= 30s`);

    // 9. transcode at 0s (from start) — head should be 0
    r = await api(`/media/${media.id}/transcode`, { method: "POST", body: JSON.stringify({ start: 0, quality: "1080", mode: "transcode" }) });
    if (r.status !== 200) throw new Error(`start=0 transcode: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`start=0 seek start=${r.body.start} cached=${r.body.cached}`);
    await new Promise((res) => setTimeout(res, 6000)); // let encoder finish (EOF)

    // 10. full-cache backward seek: after encoding 0..120, seeking to 20s
    // should hit the complete cache with zero drive traffic (cached=true).
    r = await api(`/media/${media.id}/transcode`, { method: "POST", body: JSON.stringify({ start: 20, quality: "1080", mode: "transcode" }) });
    if (r.status !== 200) throw new Error(`cache-hit transcode: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`backward to 20s: start=${r.body.start} cached=${r.body.cached}`);
    if (!r.body.cached) throw new Error(`expected cache HIT for 20s after full encode, got cached=${r.body.cached}`);
    const pl3 = await api(r.body.playlist);
    const segs3 = String(pl3.body).split("\n").filter((l) => l.includes("segment-"));
    const headSeq3 = segs3.length ? Number(segs3[0].match(/segment-(\d+)/)?.[1]) : -1;
    console.log(`cache-hit playlist head seq=${headSeq3} (${headSeq3 * 6}s), requested 20s`);
    if (headSeq3 < 0 || headSeq3 * 6 > 20) throw new Error(`cache-hit playlist head ${headSeq3 * 6}s should be <= 20s`);

    console.log("\n✅ E2E transcode smoke test passed");
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}

main().catch((e) => {
  console.error("❌ E2E failed:", e);
  process.exit(1);
});
