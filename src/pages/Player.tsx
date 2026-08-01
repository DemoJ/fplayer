import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { useNavigate, useParams } from "react-router-dom";
import { api, getToken, type Media, type Work } from "../api";
import { formatTime, FULLSCREEN_EXIT_ICON, FULLSCREEN_ICON, MUTED_ICON, needsTranscode, PAUSE_ICON, PLAY_ICON, QUALITY_ICON, QUALITY_LABEL, SKIP_NEXT_ICON, SKIP_PREV_ICON, sortEpisodes, VOLUME_ICON, type Quality } from "../lib";

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
  const [playMode, setPlayMode] = useState<"direct" | "transcode" | null>(null);
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
  // Position to restore when switching back to direct playback.
  const pendingSeekRef = useRef(0);
  // Verifies a seek landed where the user asked; hls.js live streams snap
  // out-of-window seeks to the live edge instead of seeking precisely.
  const pendingSeekTimerRef = useRef<number | undefined>(undefined);
  // Current transcode session id so quality switches can stop it early.
  const transcodeSessionRef = useRef("");
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
      const trans = needsTranscode(item.video_codec);
      if (trans) setQuality("1080");
      setPlayMode(trans ? "transcode" : "direct");
      return;
    }
    let active = true;
    setStatus("正在探测媒体信息...");
    setBuffering(true);
    api<{ media: Media }>(`/media/${id}/probe`, { method: "POST" })
      .then(({ media }) => {
        if (!active) return;
        setItem(media);
        const trans = needsTranscode(media.video_codec);
        if (trans) setQuality("1080");
        setPlayMode(trans ? "transcode" : "direct");
      })
      .catch(() => { if (active) setPlayMode("direct"); })
      .finally(() => { if (active) { setBuffering(false); setStatus(""); } });
    return () => { active = false; };
  }, [item, id, playMode]);

  // Start (or restart, after a quality switch) transcoding as soon as the
  // video element exists.
  useEffect(() => {
    if (playMode !== "transcode" || !video) return;
    if (transcodeSessionRef.current) {
      api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
      transcodeSessionRef.current = "";
    }
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    const resume = Math.max(0, playback.currentTime + offsetRef.current);
    void startTranscode(video, resume > 5 ? resume : (item?.position && item.position > 5 ? item.position : 0), quality);
  }, [playMode, video, quality]);

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
    if (playMode !== "transcode") return;
    const timer = window.setInterval(() => {
      if (transcodeSessionRef.current) api(`/transcode/${transcodeSessionRef.current}/keepalive`).catch(() => {});
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, [playMode]);
  const sortedEpisodes = useMemo(() => sortEpisodes(episodes), [episodes]);
  const currentIndex = sortedEpisodes.findIndex((m) => String(m.id) === id);
  const prevEpisode = currentIndex > 0 ? sortedEpisodes[currentIndex - 1] : undefined;
  const nextEpisode = currentIndex >= 0 && currentIndex < sortedEpisodes.length - 1 ? sortedEpisodes[currentIndex + 1] : undefined;
  const episodeLabel = (m: Media) => `S${String(m.season).padStart(2, "0")}E${String(m.episode || 0).padStart(2, "0")}`;

  async function startTranscode(target: HTMLVideoElement, start = 0, q: Quality = "1080", statusText = "正在启动转码...") {
    if (target.dataset.transcoding) return;
    target.dataset.transcoding = "true";
    offsetRef.current = start;
    setError("");
    setStatus(statusText);
    setBuffering(true);
    // Never keep the direct /file stream while ffmpeg reads the same file.
    // Two concurrent downloads of a large file double upstream traffic and
    // easily trip the drive's rate limit.
    target.removeAttribute("src");
    target.load();
    try {
      const result = await api<{ playlist: string }>(`/media/${id}/transcode`, { method: "POST", body: JSON.stringify({ start, quality: q }) });
      transcodeSessionRef.current = result.playlist.split("/")[3];
      // The playlist URL uses the session only; segments are authorized via a
      // short-lived signature embedded by the server, so the main token never
      // appears in the playlist/segment URLs.
      const source = result.playlist;
      if (Hls.isSupported()) {
        hlsRef.current?.destroy();
        const hls = new Hls({ xhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${getToken()}`), fragLoadingMaxRetry: 30, fragLoadingRetryDelay: 1500, fragLoadingTimeOut: 30000, manifestLoadingMaxRetry: 4 });
        hlsRef.current = hls;
        hls.loadSource(source); hls.attachMedia(target);
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) { setError("转码播放失败，请重试"); setBuffering(false); setStatus(""); } });
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
      target.dataset.transcoding = "failed";
      setError((e as Error).message);
      setStatus("");
    } finally { setBuffering(false); }
  }

  function transcode() {
    if (!video || video.dataset.transcoding) return;
    // Only fall back to transcoding for format/decode issues, not transient
    // network errors, and only try it once — after a failure the "重试" button
    // restores the direct stream for a manual retry.
    const code = video.error?.code;
    if (code === MediaError.MEDIA_ERR_NETWORK) { setError("网络错误，请检查连接后重试"); setBuffering(false); return; }
    void startTranscode(video, item?.position && item.position > 5 ? item.position : 0, quality);
  }

  async function switchQuality(q: Quality) {
    if (q === quality || !video) return;
    setQualityMenuOpen(false);
    const resume = Math.max(0, playback.currentTime + offsetRef.current);
    setQuality(q);
    if (q === "original" && !needsTranscode(item?.video_codec)) {
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
      setPlayMode("transcode");
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
    // Completion line: the last 2% (Netflix-style) — a 45-min episode counts
    // as watched once under ~54s remain.
    const watchedThrough = remaining < 2 || Date.now() - lastUserSeekRef.current > 30000;
    const completed = reliable && remaining <= duration * 0.02 && watchedThrough && pendingSeekTimerRef.current === undefined;
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
  useEffect(() => () => {
    hlsRef.current?.destroy(); hlsRef.current = null;
    if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current);
    if (pendingSeekTimerRef.current) { window.clearTimeout(pendingSeekTimerRef.current); pendingSeekTimerRef.current = undefined; }
    if (document.fullscreenElement && !keepFullscreenRef.current) document.exitFullscreen().catch(() => {});
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
  function restartTranscode(at: number) {
    if (!video || playMode !== "transcode") return;
    if (transcodeSessionRef.current) {
      api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
      transcodeSessionRef.current = "";
    }
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    offsetRef.current = at;
    void startTranscode(video, at, quality, "正在重新定位...");
  }

  // hls.js treats the transcode stream as live (no ENDLIST until ffmpeg
  // finishes), and a seek outside its sliding window snaps to the live edge —
  // which, when the transcode has nearly caught up with the source, is the
  // very end of the file. That fakes a huge position (and a false
  // "completed"). Verify shortly after the seek where the player actually
  // landed, and restart the transcode at the real target if it snapped.
  function verifySeek(target: number) {
    if (playMode !== "transcode") return;
    if (pendingSeekTimerRef.current) window.clearTimeout(pendingSeekTimerRef.current);
    pendingSeekRef.current = target;
    pendingSeekTimerRef.current = window.setTimeout(() => {
      pendingSeekTimerRef.current = undefined;
      pendingSeekRef.current = 0;
      if (!video) return;
      const actual = video.currentTime + offsetRef.current;
      if (Math.abs(actual - target) > 30) restartTranscode(target);
    }, 500);
  }

  function seekVideo(absTarget: number) {
    if (!video) return;
    if (playMode === "transcode" && absTarget > playback.currentTime + offsetRef.current + 60) {
      const bufferedEnd = video.buffered.length ? video.buffered.end(video.buffered.length - 1) + offsetRef.current : 0;
      if (absTarget > bufferedEnd + 30) {
        restartTranscode(absTarget);
        return;
      }
    }
    video.currentTime = absTarget - offsetRef.current;
    verifySeek(absTarget);
  }

  function retry() {
    if (!video) return;
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    offsetRef.current = 0;
    setError(""); setStatus(""); setNeedsTap(false); setBuffering(true);
    if (playMode === "transcode") {
      // HEVC: restart the transcode directly, never the direct stream.
      void startTranscode(video, item?.position && item.position > 5 ? item.position : 0, quality);
    } else {
      video.src = `/api/media/${id}/file?token=${getToken()}`;
      video.load();
      video.play().catch(() => setNeedsTap(true));
    }
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) { const p = video.play(); if (p && typeof p.then === "function") p.catch(() => {}); }
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

  return <main className={`player-page ${chromeVisible ? "chrome-visible" : ""}`} onMouseMove={showChrome} onPointerDown={showChrome}>
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
      onWaiting={() => setBuffering(true)}
      onPlaying={() => { setBuffering(false); setStatus(""); showChrome(); setPlayback((p) => ({ ...p, playing: true })); }}
      onPause={() => { if (video) save(video); setChromeVisible(true); setPlayback((p) => ({ ...p, playing: false })); }}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
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
        // Only auto-transcode once: after a failed attempt the "重试" button
        // is the way back in, so repeated error events don't spin up endless
        // new transcode sessions against the upstream drive.
        if (video?.dataset.transcoding === "failed") return;
        transcode();
      }}
    />
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
        onPointerDown={(e) => { if (!video) return; e.currentTarget.setPointerCapture(e.pointerId); dragRef.current = true; userSeekRef.current = true; window.setTimeout(() => { userSeekRef.current = false; }, 3000); const t = timeFromPointer(e); setHoverTime(t); if (t > offsetRef.current) seekVideo(t); }}
        onPointerMove={(e) => { const t = timeFromPointer(e); if (dragRef.current && t > offsetRef.current) seekVideo(t); setHoverTime(t); }}
        onPointerUp={() => { dragRef.current = false; }}
        onPointerCancel={() => { dragRef.current = false; }}
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
      <div className="player-quality-wrap">
        <button className="player-btn quality-btn" type="button" onClick={(e) => { e.currentTarget.blur(); setQualityMenuOpen((open) => !open); }}>{QUALITY_ICON}<span>{QUALITY_LABEL[quality]}</span></button>
        {qualityMenuOpen && <div className="player-quality-menu">{(Object.keys(QUALITY_LABEL) as Quality[]).map((q) => <button key={q} className={q === quality ? "active" : ""} type="button" onClick={() => void switchQuality(q)}>{QUALITY_LABEL[q]}{q === "original" ? " · 原分辨率" : ""}</button>)}</div>}
      </div>
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
