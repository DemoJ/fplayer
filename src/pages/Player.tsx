import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { useNavigate, useParams } from "react-router-dom";
import { api, getToken, type Media, type Work } from "../api";
import { formatTime, FULLSCREEN_EXIT_ICON, FULLSCREEN_ICON, MUTED_ICON, PAUSE_ICON, PLAY_ICON, playbackStrategy, playerLog, QUALITY_ICON, QUALITY_LABEL, SKIP_NEXT_ICON, SKIP_PREV_ICON, sortEpisodes, VOLUME_ICON, type Quality } from "../lib";

export function PlayerRoute() {
  const { id } = useParams();
  // Remount the player when switching episodes so playback state resets cleanly.
  return <Player key={id} />;
}

function Player() {
  const { id } = useParams(); const navigate = useNavigate();
  const [item, setItem] = useState<Media>(); const [error, setError] = useState("");
  const [buffering, setBuffering] = useState(false);
  const [status, setStatus] = useState("");
  const [needsTap, setNeedsTap] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [episodes, setEpisodes] = useState<Media[]>([]);
  const [playback, setPlayback] = useState({ currentTime: 0, duration: 0, buffered: 0, volume: 1, muted: false, playing: false });
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [playMode, setPlayMode] = useState<"direct" | "hls" | null>(null);
  // Whether the HLS stream is a full re-encode (transcode) or a container-only
  // remux (h264 in MKV). Both are served as HLS; only transcode honors quality.
  const [mode, setMode] = useState<"transcode" | "remux">("transcode");
  const [quality, setQuality] = useState<Quality>("original");
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [rate, setRate] = useState(1);
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [subtitles, setSubtitles] = useState<{ enabled: boolean; available: boolean }>({ enabled: false, available: false });
  const [subtitleText, setSubtitleText] = useState("");
  const hlsRef = useRef<Hls | null>(null);
  const lastSavedRef = useRef(0);
  const lastPositionRef = useRef(0);
  const userSeekRef = useRef(false);
  const lastUserSeekRef = useRef(0);
  const chromeTimerRef = useRef<number | undefined>(undefined);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  // Keeps the control bar visible while the pointer rests on it: the auto-hide
  // timer only fires when the cursor is outside the controls.
  const controlsHoverRef = useRef(false);
  // Guards onEnded from firing the auto-advance twice for the same episode.
  const autoNextFiredRef = useRef(false);
  // Subtitle rendering: hls.js parses WebVTT tracks but does not paint them,
  // so we render the active cue onto an overlay ourselves.
  const subtitleEnabledRef = useRef(false);
  const cuesRef = useRef<Array<{ startTime: number; endTime: number; text: string }>>([]);
  const subtitleTextRef = useRef("");
  // Set right before an episode switch so the unmount cleanup below knows the
  // remount is intentional and must not exit fullscreen.
  const keepFullscreenRef = useRef(false);
  // Resume offset of the transcode stream: the HLS starts at this position of
  // the source file, so playback times are offset by it.
  const offsetRef = useRef(0);
  // Absolute source position where the current playlist begins (server-reported
  // `start`). This is what currentTime is offset against — for a cache hit or
  // partial-cache resume the playlist may begin before the requested start.
  const windowStartRef = useRef(0);
  // Server-reported covered-until of the current cache window; seeks below it
  // are served from disk and must not restart the encoder.
  const cachedUntilRef = useRef<number | null>(null);
  // 限流自动重试定时器（仅一次，防叠加）。
  const rateLimitTimerRef = useRef<number | undefined>(undefined);
  // 限流退避计数器与禁用标记：限流窗口内任何新的 seek/transcode 都被拦截，
  // 只有重试定时器能发下一次请求，避免用户反复点击时间轴继续喂限流。
  const rateLimitRetryCountRef = useRef(0);
  const rateLimitedRef = useRef(false);
  // 转码重启去重：拖动结束只应触发一次重启；重启进行中的新 seek 合并到
  // 最新目标，待当前重启完成后用最终位置再发一次。
  const restartingRef = useRef(false);
  const latestSeekTargetRef = useRef(0);
  // 初始播放位置：cache hit 时聚合 playlist 起点可能早于恢复位置，需在
  // manifest 就绪后把播放器定位到真正的恢复点。
  const initialSeekRef = useRef(0);
  // Position to restore when switching back to direct playback.
  const pendingSeekRef = useRef(0);
  // Verifies a seek landed where the user asked; hls.js live streams snap
  // out-of-window seeks to the live edge instead of seeking precisely.
  const pendingSeekTimerRef = useRef<number | undefined>(undefined);
  // Current transcode session id so quality switches can stop it early.
  const transcodeSessionRef = useRef("");
  // 暂停超过该时长后销毁转码会话：暂停时 ffmpeg 仍全速从网盘拉流转码，
  // 长时间暂停会白白消耗网盘流量，触发夸克限流后所有转码都会失败。
  const PAUSE_DESTROY_MS = 60 * 1000;
  const pauseTimerRef = useRef<number | undefined>(undefined);
  // 转码会话已被回收，恢复播放时需从当前位置重启转码。
  const sessionDeadRef = useRef(false);
  // 缓冲超过该时长没有进展时自动重启转码：暂停恢复时 hls.js 会无限重试
  // 滑动窗口外已删除的片段（30 次 × 1.5s ≈ 45 秒）并永远卡在"缓冲中"。
  const STALL_LIMIT_MS = 15 * 1000;
  const waitingSinceRef = useRef<number | null>(null);
  // 只允许自动重启一次：重启后仍失败就交给用户手动重试，避免死循环。
  const autoRestartRef = useRef(false);
  useEffect(() => {
    let active = true;
    api<Media>(`/media/${id}`).then((m) => { if (active) setItem(m); }).catch((e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [id]);

  // Decide how to play: natively, or directly through transcoding. When the
  // codec is unknown (never probed), probe it once and cache it in the media
  // row. This avoids ever streaming the original file to a browser that can't
  // decode it — the main cause of full-file downloads and drive rate limits.
  useEffect(() => {
    if (!item || playMode) return;
    if (item.video_codec) {
      // Remote HTTP/WebDAV sources are always direct-played: transcoding them
      // means ffmpeg opening the remote URL, which for MP4-with-trailing-moov
      // triggers thousands of tiny Range probes and trips the drive rate limit.
      // Only local files may go through the transcode/remux path.
      const strategy = item.source_type && item.source_type !== "local" ? "direct" : playbackStrategy(item.video_codec, item.container);
      playerLog("player", `strategy media=${id} codec=${item.video_codec} container=${item.container} source=${item.source_type || "?"} → ${strategy}`);
      if (strategy === "transcode") setQuality("1080");
      setMode(strategy === "remux" ? "remux" : "transcode");
      setPlayMode(strategy === "direct" ? "direct" : "hls");
      return;
    }
    let active = true;
    setStatus("正在探测媒体信息...");
    setBuffering(true);
    playerLog("player", `probe media=${id} (codec unknown)`);
    api<{ media: Media }>(`/media/${id}/probe`, { method: "POST" })
      .then(({ media }) => {
        if (!active) return;
        setItem(media);
        const strategy = media.source_type && media.source_type !== "local" ? "direct" : playbackStrategy(media.video_codec, media.container);
        playerLog("player", `probed media=${id} codec=${media.video_codec} container=${media.container} source=${media.source_type || "?"} → ${strategy}`);
        if (strategy === "transcode") setQuality("1080");
        setMode(strategy === "remux" ? "remux" : "transcode");
        setPlayMode(strategy === "direct" ? "direct" : "hls");
      })
      .catch((e) => { if (active) { playerLog("player", `probe FAILED media=${id}: ${(e as Error).message} — fallback direct`); setPlayMode("direct"); } })
      .finally(() => { if (active) { setBuffering(false); setStatus(""); } });
    return () => { active = false; };
  }, [item, id, playMode]);

  // Start (or restart, after a quality switch) transcoding as soon as the
  // video element exists.
  useEffect(() => {
    if (playMode !== "hls" || !video) return;
    if (transcodeSessionRef.current) {
      api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
      transcodeSessionRef.current = "";
    }
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    const resume = Math.max(0, playback.currentTime + offsetRef.current);
    void startTranscode(video, resume > 5 ? resume : (item?.position && item.position > 5 ? item.position : 0), quality, mode);
  }, [playMode, video, quality, mode]);

  // Load the episode list of the parent work so we can navigate prev/next.
  useEffect(() => {
    if (!item?.work_id) { setEpisodes([]); return; }
    let active = true;
    api<{ work: Work; media: Media[] }>(`/works/${item.work_id}`).then((d) => { if (active) setEpisodes(d.media); }).catch(() => {});
    return () => { active = false; };
  }, [item?.work_id]);

  // Keep the transcode session alive while the player is mounted. HLS stops
  // requesting segments while paused, which would otherwise leave lastAccess
  // stale and let the idle reaper kill the ffmpeg process mid-episode.
  useEffect(() => {
    if (playMode !== "hls") return;
    const timer = window.setInterval(() => {
      if (transcodeSessionRef.current) api(`/transcode/${transcodeSessionRef.current}/keepalive`).catch(() => {});
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, [playMode]);
  useEffect(() => {
    if (playMode !== "hls") return;
    const timer = window.setInterval(() => {
      const since = waitingSinceRef.current;
      if (!since || Date.now() - since < STALL_LIMIT_MS) return;
      waitingSinceRef.current = null;
      if (rateLimitedRef.current) return;
      if (autoRestartRef.current) { playerLog("buffer", `stalled ${STALL_LIMIT_MS / 1000}s, already restarted — giving up media=${id}`); setError("转码播放失败，请重试"); setBuffering(false); setStatus(""); return; }
      autoRestartRef.current = true;
      playerLog("buffer", `stalled ${STALL_LIMIT_MS / 1000}s at ${video?.currentTime?.toFixed(1)}s — auto-restart once media=${id}`);
      void restartTranscode(video ? video.currentTime + offsetRef.current : 0);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [playMode]);
  const sortedEpisodes = useMemo(() => sortEpisodes(episodes), [episodes]);
  const currentIndex = sortedEpisodes.findIndex((m) => String(m.id) === id);
  const prevEpisode = currentIndex > 0 ? sortedEpisodes[currentIndex - 1] : undefined;
  const nextEpisode = currentIndex >= 0 && currentIndex < sortedEpisodes.length - 1 ? sortedEpisodes[currentIndex + 1] : undefined;
  const episodeLabel = (m: Media) => `S${String(m.season).padStart(2, "0")}E${String(m.episode || 0).padStart(2, "0")}`;

  async function startTranscode(target: HTMLVideoElement, start = 0, q: Quality = "1080", m: "transcode" | "remux" = "transcode", statusText = "正在启动转码...") {
    if (target.dataset.transcoding) return;
    target.dataset.transcoding = "true";
    setError("");
    setStatus(statusText);
    setBuffering(true);
    // Never keep the direct /file stream while ffmpeg reads the same file.
    // Two concurrent downloads of a large file double upstream traffic and
    // easily trip the drive's rate limit.
    target.removeAttribute("src");
    target.load();
    try {
      const result = await api<{ playlist: string; session: string; cached?: boolean; start?: number; coveredUntil?: number }>(`/media/${id}/transcode`, { method: "POST", body: JSON.stringify({ start, quality: q, mode: m }) });
      // session is the live ffmpeg session (may be empty/absent when the cache
      // hit served the playlist without starting an encoder); playlist is the
      // signed cache-window URL that hls.js actually loads.
      transcodeSessionRef.current = result.session || "";
      // The aggregate playlist may begin BEFORE the requested position (cache
      // hit). Its absolute start is the source position at playlist offset 0 —
      // the timeline offset for currentTime.
      const playlistStart = result.start ?? start;
      offsetRef.current = playlistStart;
      windowStartRef.current = playlistStart;
      cachedUntilRef.current = result.coveredUntil ?? null;
      // Playlist may start before the resume point (cache head is earlier);
      // seek to the real resume position once the manifest is ready.
      initialSeekRef.current = Math.max(0, start - playlistStart);
      const source = result.playlist;
      playerLog("transcode", `start media=${id} reqStart=${start} playlistStart=${playlistStart} cached=${result.cached ?? false} coveredUntil=${cachedUntilRef.current} initialSeek=${initialSeekRef.current}`);
      if (Hls.isSupported()) {
        hlsRef.current?.destroy();
        // 服务端转码是"按实时节奏产段"的直播源，但播放需求是点播：能接受
        // 稍长的启动延迟以换取稳定不卡。关闭低延迟模式（默认开启会让
        // hls.js 贴着 live edge 走、不主动攒缓冲），并放宽向前缓冲上限，
        // 让 hls.js 在启动期就把已有段全部拉下来攒成超前缓冲，而不是只追逐
        // 最新段。这是消除"前 20 秒无超前缓冲、卡一下之后才流畅"的关键。
        // 注意：不要设置 liveSyncDurationCount / liveMaxLatencyDurationCount。
        // 它们是直播追流用的，hls.js 的 synchronizeToLiveEdge 会在
        // currentTime < edge - maxLatency 时强制把 currentTime 跳到
        // liveSyncPosition；转码点播源里 ffmpeg 产出快于实时，会周期性触发
        // 这个跳转，造成"每隔十几秒卡一下、跳过几十秒"的严重 bug。保持
        // liveMaxLatencyDurationCount 默认 Infinity 可让该跳转永不触发。
        const hls = new Hls({
          xhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${getToken()}`),
          // 重试参数要克制：30 次 × 1.5s 的重试在网盘限流时会变成 45 秒的
          // 疯狂重试，每个 503/错误段都刷一次请求，反而把限流越拖越重。
          fragLoadingMaxRetry: 3,
          fragLoadingRetryDelay: 1500,
          fragLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 2,
          lowLatencyMode: false,
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          startPosition: initialSeekRef.current > 1 ? initialSeekRef.current : -1,
        });
        hlsRef.current = hls;
        hls.loadSource(source); hls.attachMedia(target);
        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          // Cache hit with a head earlier than the resume point: jump to the
          // requested position once the playlist is parsed.
          const seekTo = initialSeekRef.current;
          if (seekTo > 1 && data.levels?.[0]?.details) {
            playerLog("transcode", `manifest parsed — seeking to ${seekTo}s (playlist head at ${playlistStart})`);
            target.currentTime = seekTo;
          }
          initialSeekRef.current = 0;
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          playerLog("hls", `fatal error media=${id} type=${data.type} details=${data.details} fatal=${data.fatal} resp=${(data as any).response?.status}`);
          // 限流/源读取失败（ffmpeg 读源 416/429 导致段产出中断）时绝不自动
          // 重启：重启 = 重新拉流 = 把网盘限流越拖越重。直接报错让用户稍后
          // 手动重试，给限流窗口喘息时间。
          const detail = String(data.details || "");
          const response = (data as any).response;
          const status = response?.status;
          if (status === 429 || status === 416 || detail.includes("429") || detail.includes("416")) {
            playerLog("hls", `rate-limited (${status}) media=${id} — stopping, no auto-restart`);
            rateLimitedRef.current = true;
            setError("网盘请求过于频繁，请稍后重试"); setBuffering(false); setStatus("");
            return;
          }
          // 首次致命错误自动重启一次转码（暂停恢复、窗口滑过、瞬时故障都靠
          // 它恢复），重启后仍失败才显示错误让用户手动重试。
          if (autoRestartRef.current) { setError("转码播放失败，请重试"); setBuffering(false); setStatus(""); return; }
          autoRestartRef.current = true;
          waitingSinceRef.current = null;
          playerLog("hls", `auto-restart once media=${id} at ${target.currentTime + offsetRef.current}s`);
          void restartTranscode(target.currentTime + offsetRef.current);
        });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, data) => {
          const hasTracks = (data.subtitleTracks || []).length > 0;
          setSubtitles((s) => ({ ...s, available: hasTracks }));
          // Re-apply the user's subtitle choice when a new HLS instance is built
          // (quality switch / restart), since hls.js resets to track -1.
          if (hasTracks && subtitleEnabledRef.current) hls.subtitleTrack = 0;
        });
        hls.on(Hls.Events.CUES_PARSED, (_e, data) => {
          const cues = (data.cues || []) as Array<{ startTime: number; endTime: number; text: string }>;
          cuesRef.current = cues.map((cue) => ({ startTime: cue.startTime, endTime: cue.endTime, text: cue.text }));
        });
      } else {
        // Native HLS (e.g. iOS): no custom headers possible, rely on the signed
        // segment URLs rewritten by the server into the playlist.
        target.src = source;
      }
      setError("");
      setStatus("");
    } catch (e) {
      // Mark as failed and leave the src empty: restore it only through "重试"
      // so a failed transcode doesn't loop back into the direct stream.
      const message = (e as Error).message;
      playerLog("transcode", `FAILED media=${id} start=${start}: ${message}`);
      target.dataset.transcoding = "failed";
      setError(message);
      setStatus("");
      // 网盘限流是时间窗口性的：收到限流错误后自动等待并重试，避免用户
      // 反复手动点"重试"（每次手动重试都可能撞上仍在限流的窗口）。
      if (/网盘请求过于频繁|Too Many Requests|429/.test(message)) {
        scheduleRateLimitRetry(start);
      }
    } finally { setBuffering(false); }
  }

  // 限流自动重试：指数退避（30s → 60s → 120s，封顶 2 分钟），最多自动
  // 重试 3 次。重试成功时重置计数；多次仍失败就交给用户手动处理。限流
  // 窗口内（rateLimitedRef）所有新的 seek/transcode 都被 seekVideo 拦截，
  // 防止反复点击时间轴继续喂网盘限流。
  function scheduleRateLimitRetry(start: number) {
    if (rateLimitTimerRef.current) return;
    rateLimitedRef.current = true;
    const attempt = rateLimitRetryCountRef.current;
    rateLimitRetryCountRef.current++;
    const delay = Math.min(30_000 * 2 ** attempt, 120_000);
    setStatus(`网盘限流中，${Math.round(delay / 1000)} 秒后自动重试...`);
    rateLimitTimerRef.current = window.setTimeout(() => {
      rateLimitTimerRef.current = undefined;
      if (!video) return;
      video.dataset.transcoding = "";
      setError("");
      void startTranscode(video, start, quality, mode);
    }, delay);
  }

  function resetRateLimitState() {
    rateLimitedRef.current = false;
    rateLimitRetryCountRef.current = 0;
    if (rateLimitTimerRef.current) { window.clearTimeout(rateLimitTimerRef.current); rateLimitTimerRef.current = undefined; }
  }

  function transcode() {
    if (!video || video.dataset.transcoding) return;
    // Only fall back to transcoding for format/decode issues, not transient
    // network errors, and only try it once — after a failure the "重试" button
    // restores the direct stream for a manual retry.
    const code = video.error?.code;
    if (code === MediaError.MEDIA_ERR_NETWORK) { setError("网络错误，请检查连接后重试"); setBuffering(false); return; }
    // Remote sources are direct-played only: transcoding them means ffmpeg
    // opening the WebDAV URL, which for MP4-with-trailing-moov triggers
    // thousands of tiny Range probes and trips the drive rate limit. Fall
    // back to transcoding solely for LOCAL files.
    if (item?.source_type && item.source_type !== "local") {
      playerLog("video", `direct playback failed on remote source media=${id} — not auto-transcoding`);
      setError(`不支持该视频编码（${item.video_codec?.toUpperCase() || "未知"}）。请使用支持 HEVC 解码的浏览器（桌面 Chrome 硬解 / Safari）播放。`);
      setBuffering(false);
      setStatus("");
      return;
    }
    void startTranscode(video, item?.position && item.position > 5 ? item.position : 0, quality, mode);
  }

  async function switchQuality(q: Quality) {
    if (q === quality || !video) return;
    playerLog("player", `switchQuality ${quality} → ${q} media=${id} at ${playback.currentTime.toFixed(1)}s`);
    setQualityMenuOpen(false);
    setQuality(q);
    // Remote sources are always direct-played; switching quality cannot start
    // a transcode (that would re-open the WebDAV URL in ffmpeg and re-trigger
    // the moov-probe rate-limit storm). The original stream is untouched.
    if (item?.source_type && item.source_type !== "local") {
      playerLog("player", `switchQuality ignored on remote source media=${id} — staying direct`);
      return;
    }
    const resume = Math.max(0, playback.currentTime + offsetRef.current);
    // remux has no quality ladder (stream copy preserves the source); only
    // transcode can scale. Returning to direct playback is only possible for
    // direct-playable files.
    const strategy = playbackStrategy(item?.video_codec, item?.container);
    if (q === "original" && strategy === "direct") {
      // Back to the direct stream: stop the transcode and seek to the resume point.
      if (transcodeSessionRef.current) {
        api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
        transcodeSessionRef.current = "";
      }
      hlsRef.current?.destroy(); hlsRef.current = null;
      video.dataset.transcoding = "";
      offsetRef.current = 0;
      pendingSeekRef.current = resume;
      setPlayMode("direct");
    } else {
      // A quality change restarts the transcode from the current position.
      setMode(strategy === "remux" ? "remux" : "transcode");
      setPlayMode("hls");
    }
  }

  function save(element: HTMLVideoElement, force = false) {
    // Trust the probed source duration over the transcode stream's duration:
    // the HLS window starts at the resume offset and its duration is unstable.
    const probedDuration = item?.duration && item.duration > 0 ? item.duration : undefined;
    const duration = probedDuration ?? (Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0);
    // While a seek is still being verified the element may report the live-edge
    // snap instead of the user's drag target; persist the requested position.
    const rawPosition = element.currentTime + offsetRef.current;
    const position = pendingSeekTimerRef.current !== undefined && pendingSeekRef.current > 0 ? pendingSeekRef.current : rawPosition;
    if (duration <= 0 || position <= 0) return;
    // A failed/stalled playback reports currentTime 0 — never let it erase a
    // meaningful saved position.
    if (position < 5 && (item?.position ?? 0) > 30) return;
    // Guard against HLS live-edge jumps: seeking past the transcoded window
    // makes hls.js snap to the newest segment, which would fake a huge
    // position (and a false "completed"). User drags are marked via userSeek.
    const prev = lastPositionRef.current;
    lastPositionRef.current = position;
    if (prev > 30 && position - prev > 120 && !userSeekRef.current) return;
    const now = Date.now();
    // Throttle with wall-clock time so a backwards seek still persists on pause.
    if (!force && now - lastSavedRef.current < 5000) return;
    lastSavedRef.current = now;
    // A live transcode stream reports a duration that tracks the downloaded
    // window, so completion can only be judged against a trusted duration.
    const reliable = probedDuration !== undefined || Math.abs(element.duration - position) < 60;
    const remaining = duration - position;
    // Dragging the timeline into the final stretch is not the same as watching
    // it through: only playback that actually reaches the very end, or natural
    // playback persisting well past a user seek, may mark the media completed.
    // A pending seek check also blocks completion: the position may still be
    // the live-edge snap rather than where the user actually dragged.
    // Completion line: the last 5% — a 45-min episode counts as watched once
    // under ~2m15s remain.
    const watchedThrough = remaining < 2 || Date.now() - lastUserSeekRef.current > 30000;
    const completed = reliable && remaining <= duration * 0.05 && watchedThrough && pendingSeekTimerRef.current === undefined;
    api(`/media/${id}/progress`, { method: "PUT", body: JSON.stringify({ position: Math.min(position, duration), duration, completed }) }).catch(() => {});
  }

  // Hold the latest save() in a ref so the unmount cleanup below always calls
  // the current render's closure (which captures the loaded item) instead of
  // the one from when the video element was first bound.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Persist progress when leaving the player (navigating away or switching episodes).
  useEffect(() => () => { if (video) saveRef.current(video, true); }, [video]);

  const seekStateRef = useRef({ longPressActive: false, longPressTimer: 0 as number | undefined, previousRate: 1, pressedKey: "" as "" | "ArrowRight" | "ArrowLeft" });
  // 快进/快退/倍速的短暂视觉提示（顶部覆盖层，约 1 秒后淡出）。
  const [seekHint, setSeekHint] = useState<{ dir: "fwd" | "back" | "fast" | "slow"; ts: number } | null>(null);
  const seekHintTimerRef = useRef<number | undefined>(undefined);
  const hintActiveRef = useRef(false);
  const HINT_DURATION_MS = 900;
  function showSeekHint(dir: "fwd" | "back" | "fast" | "slow") {
    setSeekHint({ dir, ts: Date.now() });
    if (seekHintTimerRef.current) window.clearTimeout(seekHintTimerRef.current);
    seekHintTimerRef.current = window.setTimeout(() => {
      hintActiveRef.current = false;
      setSeekHint(null);
    }, HINT_DURATION_MS);
    // 提示显示期间标记，showChrome() 会忽略该窗口内的唤醒请求——否则快进 seek
    // 触发的 playing 事件、pointerdown 等会让控制栏在提示结束后"闪"一下。
    hintActiveRef.current = true;
    setChromeVisible(false);
    if (chromeTimerRef.current) { window.clearTimeout(chromeTimerRef.current); chromeTimerRef.current = undefined; }
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
  useEffect(() => {
    if (!video) return;
    const LONG_PRESS_DELAY = 400;
    const SEEK_SECONDS = 5;
    function clearLongPressTimer() { const state = seekStateRef.current; if (state.longPressTimer !== undefined) { window.clearTimeout(state.longPressTimer); state.longPressTimer = undefined; } }
    function resetSeekState() { const state = seekStateRef.current; clearLongPressTimer(); if (state.longPressActive && video) video.playbackRate = state.previousRate; state.longPressActive = false; state.pressedKey = ""; }
    function onKeyDown(event: KeyboardEvent) {
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      if (!video) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        nudgeVolume(event.key === "ArrowUp" ? 0.1 : -0.1);
        return;
      }
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      const state = seekStateRef.current;
      if (state.pressedKey === event.key) return;
      state.pressedKey = event.key as "ArrowRight" | "ArrowLeft";
      state.longPressActive = false;
      state.previousRate = video.playbackRate;
      clearLongPressTimer();
      state.longPressTimer = window.setTimeout(() => {
        state.longPressActive = true;
        video!.playbackRate = event.key === "ArrowRight" ? 2 : 0.5;
        showSeekHint(event.key === "ArrowRight" ? "fast" : "slow");
      }, LONG_PRESS_DELAY);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      if (!video) return;
      const state = seekStateRef.current;
      if (state.pressedKey !== event.key) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearLongPressTimer();
      if (state.longPressActive) {
        video.playbackRate = state.previousRate;
        state.longPressActive = false;
      } else {
        video.currentTime += event.key === "ArrowRight" ? SEEK_SECONDS : -SEEK_SECONDS;
        lastUserSeekRef.current = Date.now();
        verifySeek(video.currentTime + offsetRef.current);
        showSeekHint(event.key === "ArrowRight" ? "fwd" : "back");
      }
      state.pressedKey = "";
    }
    const onBlur = () => resetSeekState();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => { window.removeEventListener("keydown", onKeyDown, true); window.removeEventListener("keyup", onKeyUp, true); window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onBlur); clearLongPressTimer(); };
  }, [video]);

  // Clean up HLS instance on unmount or when switching media. Leaving fullscreen
  // is a browser-level state that survives routing, so exit it unless the
  // unmount is an intentional episode switch (which keeps fullscreen on).
  // The transcode session is also released here: on a normal route change the
  // ffmpeg process would otherwise keep pulling the source for up to the idle
  // TTL. A hard refresh cannot run this cleanup at all — pagehide below covers
  // that case, and the server dedups per user+media as a final backstop.
  useEffect(() => () => {
    hlsRef.current?.destroy(); hlsRef.current = null;
    if (transcodeSessionRef.current) {
      api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
      transcodeSessionRef.current = "";
    }
    if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current);
    if (pendingSeekTimerRef.current) { window.clearTimeout(pendingSeekTimerRef.current); pendingSeekTimerRef.current = undefined; }
    if (pauseTimerRef.current) { window.clearTimeout(pauseTimerRef.current); pauseTimerRef.current = undefined; }
    if (rateLimitTimerRef.current) { window.clearTimeout(rateLimitTimerRef.current); rateLimitTimerRef.current = undefined; }
    if (seekHintTimerRef.current) { window.clearTimeout(seekHintTimerRef.current); seekHintTimerRef.current = undefined; }
    if (document.fullscreenElement && !keepFullscreenRef.current) document.exitFullscreen().catch(() => {});
  }, []);

  // Hard refresh / tab close destroys the JS context without running the unmount
  // cleanup above. fetch with keepalive survives page teardown, so the session
  // is stopped immediately instead of the ffmpeg pulling the source until the
  // server's idle reaper reclaims it.
  useEffect(() => {
    const onHide = () => {
      const session = transcodeSessionRef.current;
      if (session) {
        api(`/transcode/${session}`, { method: "DELETE", keepalive: true }).catch(() => {});
        transcodeSessionRef.current = "";
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // When entering fullscreen, blur the video so keyboard focus leaves the
  // shadow DOM. This lets arrow keys reach our window seek handler and prevents
  // a focus ring on the fullscreen button.
  useEffect(() => {
    if (!video) return;
    const onFsChange = () => { if (document.fullscreenElement) { (document.activeElement as HTMLElement | null)?.blur(); window.focus(); } };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [video]);
  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  function showChrome() {
    // 提示显示期间忽略任何控制栏唤醒请求，保证提示与标题/控制栏彻底解耦。
    if (hintActiveRef.current) return;
    setChromeVisible(true);
    if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = window.setTimeout(() => {
      chromeTimerRef.current = undefined;
      // Keep the bar up while the cursor sits on it; hide only otherwise.
      if (video && !video.paused && !controlsHoverRef.current) setChromeVisible(false);
    }, 2600);
  }

  function goBack() {
    // Leave fullscreen before navigating, or the destination page would stay
    // in the browser's fullscreen mode.
    const exit = document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : Promise.resolve();
    void exit.then(() => {
      // 从哪来回哪去：播放页可能从首页/片库/浏览/详情进入，返回上一页即可；
      // 直接打开无历史时才回退到固定页面。
      if (window.history.length > 1) { navigate(-1); return; }
      if (item?.work_id) navigate(`/work/${item.work_id}`, { replace: true });
      else navigate(item?.kind === "show" ? "/shows" : "/movies", { replace: true });
    });
  }

  function switchEpisode(target: Media) {
    if (video) save(video, true);
    // Replacing keeps the back stack flat; mark the upcoming remount so the
    // fullscreen cleanup below does not drop out of fullscreen mid-episode.
    keepFullscreenRef.current = true;
    navigate(`/watch/${target.id}`, { replace: true });
  }

  // Restarts the transcode session from a new source position (used when the
  // user seeks ahead of the transcoded window — hls.js would otherwise snap to
  // the live edge and play the wrong part of the episode).
  // Deduplicated: while a restart is in flight, new seeks only update the
  // latest target and are applied once the current restart finishes, so a
  // burst of seeks still triggers exactly one encoder spawn.
  function restartTranscode(at: number) {
    if (!video || playMode !== "hls") return;
    if (rateLimitedRef.current) return;
    if (restartingRef.current) {
      latestSeekTargetRef.current = Math.max(latestSeekTargetRef.current, at);
      playerLog("seek", `restartTranscode media=${id} at=${at} — coalesced while restarting`);
      return;
    }
    restartingRef.current = true;
    playerLog("seek", `restartTranscode media=${id} at=${at}`);
    if (transcodeSessionRef.current) {
      api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
      transcodeSessionRef.current = "";
    }
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    offsetRef.current = at;
    void startTranscode(video, at, quality, mode, "正在重新定位...").finally(() => {
      restartingRef.current = false;
      const next = latestSeekTargetRef.current;
      if (next > 0) {
        latestSeekTargetRef.current = 0;
        if (Math.abs(next - at) > 1) restartTranscode(next);
      }
    });
  }

  // 当前可播放的绝对时间范围（相对源文件）。起点是 playlist 的绝对起点
  // （windowStartRef，服务端返回），不是播放起点 offsetRef —— 缓存命中或
  // 部分续传时 playlist 可能从请求位置之前开始。窗口内 hls.js 能自己加载
  // 任意段（段文件在磁盘缓存中），窗口外（还没产出）才需要重启转码。
  // 取不到时返回 null。
  function transcodeWindow(): { start: number; end: number } | null {
    const details = hlsRef.current?.levels?.[0]?.details;
    if (!details || !Number.isFinite(details.edge)) return null;
    const start = Number.isFinite(details.fragmentStart) ? details.fragmentStart : 0;
    return { start: windowStartRef.current + start, end: windowStartRef.current + details.edge };
  }

  // hls.js treats the transcode stream as live (no ENDLIST until ffmpeg
  // finishes), and a seek outside its sliding window snaps to the live edge —
  // which, when the transcode has nearly caught up with the source, is the
  // very end of the file. That fakes a huge position (and a false
  // "completed"). Verify shortly after the seek where the player actually
  // landed, and restart the transcode at the real target if it snapped.
  // Only out-of-window seeks may restart: in-window seeks let hls.js load the
  // segment itself, and restarting there would re-pull the source file and
  // trip the drive's rate limit.
  function verifySeek(target: number) {
    if (playMode !== "hls") return;
    if (pendingSeekTimerRef.current) window.clearTimeout(pendingSeekTimerRef.current);
    pendingSeekRef.current = target;
    pendingSeekTimerRef.current = window.setTimeout(() => {
      pendingSeekTimerRef.current = undefined;
      pendingSeekRef.current = 0;
      if (!video) return;
      const actual = video.currentTime + windowStartRef.current;
      const window = transcodeWindow();
      // Target still inside the transcode window: hls.js is loading it, give it time.
      if (window && target >= window.start - 5 && target <= window.end + 5) {
        playerLog("seek", `verify media=${id} target=${target} actual=${actual} — in-window, OK`);
        return;
      }
      if (Math.abs(actual - target) > 30) {
        playerLog("seek", `verify media=${id} target=${target} actual=${actual} — MISMATCH (>30s), restarting`);
        restartTranscode(target);
      } else {
        playerLog("seek", `verify media=${id} target=${target} actual=${actual} — OK`);
      }
    }, 2000);
  }

  function seekVideo(absTarget: number) {
    if (!video) return;
    // 限流窗口内禁止任何新的 seek：重启转码 = 重新拉流 = 继续喂限流。
    if (rateLimitedRef.current) return;
    // 会话已被回收时任意 seek 都会落到已删除的片段上，直接重启转码。
    if (playMode === "hls" && sessionDeadRef.current) {
      sessionDeadRef.current = false;
      playerLog("seek", `media=${id} target=${absTarget} — session dead, restart`);
      void restartTranscode(absTarget);
      return;
    }
    if (playMode === "hls") {
      const window = transcodeWindow();
      // In-window seek (including cached-but-unplayed territory below the
      // resume point): hand it to hls.js directly. The aggregate playlist
      // covers every cached segment, so a backward seek into previously
      // transcoded territory is served off disk with no encoder restart.
      const cached = cachedUntilRef.current;
      const inCache = cached !== null && absTarget <= cached + 5;
      if ((window && absTarget >= window.start - 5 && absTarget <= window.end + 5) || inCache) {
        playerLog("seek", `media=${id} target=${absTarget} — in-window (${window?.start.toFixed(0)}-${window?.end.toFixed(0)})${inCache ? ` cachedTo=${cached}` : ""}, native seek`);
        video.currentTime = absTarget - windowStartRef.current;
        verifySeek(absTarget);
        return;
      }
      playerLog("seek", `media=${id} target=${absTarget} — out-of-window${window ? ` (${window.start.toFixed(0)}-${window.end.toFixed(0)})` : " (no window)"}, restart transcode`);
      void restartTranscode(absTarget);
      return;
    }
    video.currentTime = absTarget - windowStartRef.current;
    verifySeek(absTarget);
  }

  function retry() {
    if (!video) return;
    playerLog("player", `retry media=${id} mode=${playMode}`);
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    offsetRef.current = 0;
    autoRestartRef.current = false;
    sessionDeadRef.current = false;
    waitingSinceRef.current = null;
    restartingRef.current = false;
    latestSeekTargetRef.current = 0;
    if (pauseTimerRef.current) { window.clearTimeout(pauseTimerRef.current); pauseTimerRef.current = undefined; }
    resetRateLimitState();
    setError(""); setStatus(""); setNeedsTap(false); setBuffering(true);
    if (playMode === "hls") {
      // HEVC: restart the transcode directly, never the direct stream.
      void startTranscode(video, item?.position && item.position > 5 ? item.position : 0, quality, mode);
    } else {
      video.src = `/api/media/${id}/file?token=${getToken()}`;
      video.load();
      video.play().catch(() => setNeedsTap(true));
    }
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) {
      // 转码会话已因长时间暂停被回收：先从当前位置重启转码（预热后自动播放），
      // 否则 hls.js 会无限重试已删除的片段。
      if (playMode === "hls" && sessionDeadRef.current) {
        if (rateLimitedRef.current) return;
        sessionDeadRef.current = false;
        void restartTranscode(video.currentTime + offsetRef.current);
        return;
      }
      if (pauseTimerRef.current) { window.clearTimeout(pauseTimerRef.current); pauseTimerRef.current = undefined; }
      const p = video.play(); if (p && typeof p.then === "function") p.catch(() => {});
    }
    else video.pause();
  }
  function setVolume(value: number) {
    if (!video) return;
    const v = Math.min(1, Math.max(0, value));
    video.volume = v;
    video.muted = v === 0;
    setPlayback((p) => ({ ...p, volume: v, muted: video.muted }));
  }
  function nudgeVolume(delta: number) {
    if (!video) return;
    showChrome();
    // Unmuting raises from the previous level (or a sensible default), not from 0.
    if (video.muted && delta > 0) setVolume(video.volume > 0 ? video.volume : 0.5);
    else if (!video.muted) setVolume(video.volume + delta);
  }
  function toggleMute() {
    if (!video) return;
    if (video.muted) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else {
      video.muted = true;
    }
    setPlayback((p) => ({ ...p, volume: video.volume, muted: video.muted }));
  }
  function setPlaybackRate(next: number) {
    if (!video) return;
    video.playbackRate = next;
    setRate(next);
    setRateMenuOpen(false);
    showChrome();
  }
  function toggleSubtitles() {
    const next = !subtitles.enabled;
    subtitleEnabledRef.current = next;
    if (hlsRef.current) hlsRef.current.subtitleTrack = next ? 0 : -1;
    if (!next) {
      cuesRef.current = [];
      subtitleTextRef.current = "";
      setSubtitleText("");
    }
    setSubtitles((s) => ({ ...s, enabled: next }));
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }
  function timeFromPointer(event: { clientX: number }) {
    const el = timelineRef.current;
    const duration = item?.duration && item.duration > 0 ? item.duration : playback.duration;
    // A live transcode stream can report Infinity as its duration (or 0 before
    // metadata loads) — never turn that into a seek target.
    if (!el || !video || !Number.isFinite(duration) || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  const ratioOf = (t: number) => (playback.duration > 0 ? Math.min(100, Math.max(0, (t / playback.duration) * 100)) : 0);
  const playRatio = ratioOf(playback.currentTime + offsetRef.current);
  const bufferedRatio = ratioOf(playback.buffered + offsetRef.current);
  const hoverRatio = hoverTime !== null ? ratioOf(hoverTime) : null;
  const clampedHoverRatio = hoverRatio === null ? null : Math.min(96, Math.max(4, hoverRatio));

  return <main className={`player-page ${chromeVisible ? "chrome-visible" : ""} ${seekHint ? "hint-active" : ""}`} onMouseMove={showChrome} onPointerDown={showChrome}>
    <div className="player-chrome"><button className="player-back" onClick={goBack} aria-label="返回详情"><span>‹</span></button><div className="player-heading"><small>正在播放{item?.kind === "show" && item?.season ? ` · ${episodeLabel(item)}` : ""}</small><strong>{item?.title}</strong></div></div>
    <video ref={setVideo} autoPlay playsInline
      src={playMode === "direct" ? `/api/media/${id}/file?token=${getToken()}` : undefined}
      onClick={togglePlay}
      onLoadedMetadata={(e) => {
        // Grab the element synchronously: React state updaters run later, when
        // the synthetic event's currentTarget has already been reset to null.
        const v = e.currentTarget;
        setPlayback((p) => ({ ...p, duration: item?.duration && item.duration > 0 ? item.duration : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0) }));
        // The transcode stream already starts at the resume position; the
        // direct stream restores either the quality-switch point or the saved position.
        if (playMode === "direct") {
          const seek = pendingSeekRef.current || item?.position;
          if (seek) { v.currentTime = seek; pendingSeekRef.current = 0; }
        }
        const p = v.play(); if (p && typeof p.then === "function") p.catch(() => setNeedsTap(true));
      }}
      onDurationChange={(e) => {
        const v = e.currentTarget;
        setPlayback((p) => ({ ...p, duration: item?.duration && item.duration > 0 ? item.duration : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0) }));
      }}
      onWaiting={() => { waitingSinceRef.current ??= Date.now(); playerLog("buffer", `waiting media=${id} at ${video?.currentTime?.toFixed(1) ?? "?"}s buffered=${video?.buffered?.length ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 0}s`); setBuffering(true); }}
      onPlaying={() => {
        playerLog("buffer", `playing media=${id} at ${video?.currentTime?.toFixed(1) ?? "?"}s (waited ${waitingSinceRef.current ? `${((Date.now() - waitingSinceRef.current) / 1000).toFixed(1)}s` : "0s"})`);
        setBuffering(false); setStatus(""); showChrome();
        waitingSinceRef.current = null;
        autoRestartRef.current = false;
        resetRateLimitState();
        if (pauseTimerRef.current) { window.clearTimeout(pauseTimerRef.current); pauseTimerRef.current = undefined; }
        setPlayback((p) => ({ ...p, playing: true }));
      }}
      onPause={() => {
        playerLog("buffer", `pause media=${id} at ${video?.currentTime?.toFixed(1) ?? "?"}s`);
        if (video) save(video);
        setChromeVisible(true);
        setPlayback((p) => ({ ...p, playing: false }));
        // 长时间暂停时销毁转码会话，避免 ffmpeg 继续全速拉流烧网盘流量。
        if (playMode === "hls" && transcodeSessionRef.current) {
          if (pauseTimerRef.current) window.clearTimeout(pauseTimerRef.current);
          pauseTimerRef.current = window.setTimeout(() => {
            if (!video?.paused) return;
            playerLog("session", `pause ${PAUSE_DESTROY_MS / 1000}s — destroying transcode session media=${id}`);
            sessionDeadRef.current = true;
            autoRestartRef.current = false;
            api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
            transcodeSessionRef.current = "";
          }, PAUSE_DESTROY_MS);
        }
      }}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        waitingSinceRef.current = null;
        save(v);
        // Paint the active subtitle cue (hls.js parses but does not render).
        let cueText = "";
        if (subtitles.enabled && cuesRef.current.length) {
          const cue = cuesRef.current.find((c) => v.currentTime >= c.startTime && v.currentTime <= c.endTime);
          cueText = cue?.text || "";
        }
        if (cueText !== subtitleTextRef.current) { subtitleTextRef.current = cueText; setSubtitleText(cueText); }
        const buf = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        setPlayback((p) => {
          if (Math.abs(v.currentTime - p.currentTime) < 0.25 && Math.abs(buf - p.buffered) < 1) return p;
          return { ...p, currentTime: v.currentTime, buffered: buf };
        });
      }}
      onEnded={(e) => {
        save(e.currentTarget, true);
        setPlayback((p) => ({ ...p, playing: false }));
        // Auto-advance to the next episode (Netflix-style), once per episode.
        if (nextEpisode && !autoNextFiredRef.current) {
          autoNextFiredRef.current = true;
          setStatus(`即将播放 ${episodeLabel(nextEpisode)}...`);
          window.setTimeout(() => switchEpisode(nextEpisode), 1500);
        }
      }}
      onError={() => {
        playerLog("video", `error media=${id} code=${video?.error?.code} msg=${video?.error?.message} mode=${playMode} transcoding=${video?.dataset.transcoding}`);
        // Only auto-transcode once: after a failed attempt the "重试" button
        // is the way back in, so repeated error events don't spin up endless
        // new transcode sessions against the upstream drive.
        if (video?.dataset.transcoding === "failed") return;
        // Direct-stream (remote WebDAV) 失败：清空 src 阻止浏览器立即自动重试
        // （浏览器 <video> 失败后会在毫秒级重打 src，十几次/秒，把网盘限流越
        // 拖越重）。不主动发起任何重试，只显示错误，等用户手动点击"重试"或刷
        // 新页面后再请求，给网盘限流窗口自然冷却的时间。
        if (playMode === "direct") {
          if (video) { video.removeAttribute("src"); video.load(); }
          setError("播放失败，请稍后点击重试"); setBuffering(false); setStatus("");
          return;
        }
        transcode();
      }}
    />
    {seekHint && (
      <div className="player-hint" key={seekHint.ts} role="status">
        {seekHint.dir === "fwd" ? "+5秒" : seekHint.dir === "back" ? "-5秒" : seekHint.dir === "fast" ? "快进 2倍速" : "快退 0.5倍速"}
      </div>
    )}
    {subtitles.enabled && subtitleText && <div className="player-subtitle">{subtitleText}</div>}
    <div className={`player-controls ${chromeVisible ? "visible" : ""}`}
      onMouseEnter={() => { controlsHoverRef.current = true; if (chromeTimerRef.current) { window.clearTimeout(chromeTimerRef.current); chromeTimerRef.current = undefined; } }}
      onMouseLeave={() => { controlsHoverRef.current = false; showChrome(); }}
    >
      {item?.kind === "show" && sortedEpisodes.length > 0 && <button className="player-btn ep-skip-btn" type="button" aria-label="上一集" disabled={!prevEpisode} title={prevEpisode ? `上一集 ${episodeLabel(prevEpisode)}` : "已经是第一集"} onClick={() => prevEpisode && switchEpisode(prevEpisode)}>{SKIP_PREV_ICON}</button>}
      <button className="player-btn" type="button" aria-label={playback.playing ? "暂停" : "播放"} onClick={(e) => { e.currentTarget.blur(); togglePlay(); }}>{playback.playing ? PAUSE_ICON : PLAY_ICON}</button>
      {item?.kind === "show" && sortedEpisodes.length > 0 && <button className="player-btn ep-skip-btn" type="button" aria-label="下一集" disabled={!nextEpisode} title={nextEpisode ? `下一集 ${episodeLabel(nextEpisode)}` : "已经是最后一集"} onClick={() => nextEpisode && switchEpisode(nextEpisode)}>{SKIP_NEXT_ICON}</button>}
      <div className="player-volume-wrap">
        <button className="player-btn" type="button" aria-label={playback.muted ? "取消静音" : "静音"} onClick={(e) => { e.currentTarget.blur(); toggleMute(); }}>{playback.muted || playback.volume === 0 ? MUTED_ICON : VOLUME_ICON}</button>
        <div className="player-volume-slider">
          <input type="range" min="0" max="1" step="0.05" value={playback.muted ? 0 : playback.volume} aria-label="音量"
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      <div className="player-timeline" ref={timelineRef}
        onPointerDown={(e) => { if (!video) return; e.currentTarget.setPointerCapture(e.pointerId); dragRef.current = true; userSeekRef.current = true; window.setTimeout(() => { userSeekRef.current = false; }, 3000); const t = timeFromPointer(e); setHoverTime(t); }}
        onPointerMove={(e) => { const t = timeFromPointer(e); setHoverTime(t); }}
        onPointerUp={(e) => { if (!dragRef.current) return; dragRef.current = false; const t = timeFromPointer(e); if (t > 0) seekVideo(t); }}
        onPointerCancel={(e) => { if (!dragRef.current) return; dragRef.current = false; const t = timeFromPointer(e); if (t > 0) seekVideo(t); }}
        onPointerLeave={() => { if (!dragRef.current) setHoverTime(null); }}
      >
        <div className="player-timeline-track">
          <i className="player-timeline-buffered" style={{ width: `${bufferedRatio}%` }} />
          <i className="player-timeline-fill" style={{ width: `${playRatio}%` }} />
          <i className="player-timeline-thumb" style={{ left: `${playRatio}%` }} />
          {hoverRatio !== null && <i className="player-timeline-preview" style={{ left: `${hoverRatio}%` }} />}
        </div>
        {hoverRatio !== null && clampedHoverRatio !== null && <span className="player-timeline-time" style={{ left: `${clampedHoverRatio}%` }}>{formatTime(hoverTime ?? 0)}</span>}
      </div>
      <span className="player-time">{formatTime(playback.currentTime + offsetRef.current)} / {formatTime(playback.duration)}</span>
      {mode === "transcode" && !(item?.source_type && item.source_type !== "local") && <div className="player-quality-wrap">
        <button className="player-btn quality-btn" type="button" onClick={(e) => { e.currentTarget.blur(); setQualityMenuOpen((open) => !open); }}>{QUALITY_ICON}<span>{QUALITY_LABEL[quality]}</span></button>
        {qualityMenuOpen && <div className="player-quality-menu">{(Object.keys(QUALITY_LABEL) as Quality[]).map((q) => <button key={q} className={q === quality ? "active" : ""} type="button" onClick={() => void switchQuality(q)}>{QUALITY_LABEL[q]}{q === "original" ? " · 原分辨率" : ""}</button>)}</div>}
      </div>}
      <div className="player-quality-wrap">
        <button className="player-btn quality-btn" type="button" aria-label="播放速度" onClick={(e) => { e.currentTarget.blur(); setRateMenuOpen((open) => !open); }}><span>{rate === 1 ? "1x" : `${rate}x`}</span></button>
        {rateMenuOpen && <div className="player-quality-menu">{[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => <button key={r} className={r === rate ? "active" : ""} type="button" onClick={() => setPlaybackRate(r)}>{r === 1 ? "1x 正常" : `${r}x`}</button>)}</div>}
      </div>
      {subtitles.available && <button className={`player-btn ${subtitles.enabled ? "on" : ""}`} type="button" aria-pressed={subtitles.enabled} title={subtitles.enabled ? "关闭字幕" : "开启字幕"} onClick={(e) => { e.currentTarget.blur(); toggleSubtitles(); }}>CC</button>}
      <button className="player-btn" type="button" aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={(e) => { e.currentTarget.blur(); toggleFullscreen(); }}>{fullscreen ? FULLSCREEN_EXIT_ICON : FULLSCREEN_ICON}</button>
    </div>
    {buffering && !error && <div className="player-status" role="status"><i className="player-spinner" /><strong>{status || "正在缓冲"}</strong></div>}
    {needsTap && <button className="player-tap" type="button" onClick={() => { video?.play().then(() => setNeedsTap(false)).catch(() => {}); }}>▶ 点击播放</button>}
    {error && <div className="player-error" role="alert"><span>播放遇到问题</span><strong>{error}</strong><div><button type="button" className="primary" onClick={retry}>重试</button><button type="button" className="secondary" onClick={goBack}>返回详情</button></div></div>}
  </main>;
}
