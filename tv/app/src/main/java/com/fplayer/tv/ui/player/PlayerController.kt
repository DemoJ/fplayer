package com.fplayer.tv.ui.player

import android.content.Context
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.Tracks
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.fplayer.tv.data.ApiService
import com.fplayer.tv.data.Media
import com.fplayer.tv.data.ProgressRequest
import com.fplayer.tv.data.TranscodeRequest
import com.fplayer.tv.data.friendlyMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.min

data class PlayerUiState(
    val loading: Boolean = false,
    val error: String = "",
    val status: String = "",
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,    val volume: Float = 1f,
    val rate: Float = 1f,
    val playMode: PlayMode = PlayMode.DIRECT,
    val quality: String = "1080",
    val subtitlesAvailable: Boolean = false,
    val subtitlesEnabled: Boolean = false,
    val title: String = "",
    val episodeLabel: String? = null,
    val prevId: Long? = null,
    val nextId: Long? = null,
)

/**
 * ExoPlayer 播放协调器：直接播放 / 服务端转码 HLS（offset 换算、越窗 seek 重启、
 * 会话保活与暂停销毁、限流退避重试）、进度上报。
 */
class PlayerController(
    context: Context,
    private val api: ApiService,
    private val tokenProvider: () -> String?,
    private val baseUrlProvider: () -> String?,
) : Player.Listener {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _state = MutableStateFlow(PlayerUiState())
    val state: StateFlow<PlayerUiState> = _state.asStateFlow()

    /** 供 PlayerView 绑定；生命周期由本控制器管理。 */
    val player: ExoPlayer = run {
        val headers = tokenProvider()?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap()
        val dataSource = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(headers)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
            .build()
            .apply { addListener(this@PlayerController) }
    }

    private var mediaId = 0L
    private var media: Media? = null
    private var playMode = PlayMode.DIRECT
    private var quality = "1080"
    // 转码流：playlist 相对 0 对应的源文件绝对秒数；UI 时间 = player 时间 + offsetStart。
    private var offsetStart = 0.0
    private var coveredUntil: Double? = null
    private var sessionId = ""
    private var sessionDead = false
    private var initialSeekMs = 0L
    private var autoRestarted = false
    private var lastUserSeekMs = 0L
    private var lastSavedMs = 0L
    private var retryCount = 0
    private var retryJob: Job? = null
    private var pauseDestroyJob: Job? = null
    private var keepaliveJob: Job? = null
    private var loaded = false
    private var uiLoopStarted = false
    private var saveLoopStarted = false

    private val ui = { _state.value }
    private fun update(transform: (PlayerUiState) -> PlayerUiState) { _state.update(transform) }

    fun load(id: Long) {
        if (loaded && mediaId == id) return
        loaded = true
        mediaId = id
        update { it.copy(loading = true, error = "", status = "") }
        startUiLoop()
        startSaveLoop()
        scope.launch {
            runCatching { api.media(id) }
                .onSuccess { item ->
                    media = item
                    update {
                        it.copy(
                            title = item.title,
                            episodeLabel = if (item.kind == "show" && item.season != null) {
                                "S${item.season.toString().padStart(2, '0')}E${(item.episode ?: 0).toString().padStart(2, '0')}"
                            } else null,
                        )
                    }
                    loadEpisodes(item)
                    launchPlayback(item)
                }
                .onFailure { e ->
                    update { it.copy(loading = false, error = "加载媒体失败：${e.friendlyMessage()}") }
                }
        }
    }

    /** 播放中每 5 秒上报一次进度（与 UI 循环独立，避免 500ms 高频请求）。 */
    private fun startSaveLoop() {
        if (saveLoopStarted) return
        saveLoopStarted = true
        scope.launch {
            while (isActive) {
                delay(5000)
                save()
            }
        }
    }

    /** 周期刷新 UI 状态（播放位置/时长/音量/倍速/缓冲）。 */
    private fun startUiLoop() {
        if (uiLoopStarted) return
        uiLoopStarted = true
        scope.launch {
            while (isActive) {
                update {
                    it.copy(
                        playing = player.isPlaying,
                        positionMs = player.currentPosition + (offsetStart * 1000).toLong(),
                        durationMs = media?.duration?.let { d -> (d * 1000).toLong() }
                            ?: player.duration?.takeIf { d -> d > 0 } ?: 0,
                        buffering = player.playbackState == Player.STATE_BUFFERING,
                        volume = player.volume,
                        rate = player.playbackParameters.speed,
                    )
                }
                delay(500)
            }
        }
    }

    private suspend fun loadEpisodes(item: Media) {
        val workId = item.workId ?: return
        runCatching { api.workDetail(workId) }
            .onSuccess { resp ->
                val sorted = sortEpisodes(resp.media)
                val index = sorted.indexOfFirst { it.id == item.id }
                if (index >= 0) {
                    update {
                        it.copy(
                            prevId = sorted.getOrNull(index - 1)?.id,
                            nextId = sorted.getOrNull(index + 1)?.id,
                        )
                    }
                }
            }
    }

    private suspend fun launchPlayback(item: Media) {
        // 未知 codec 的本地源：先探测再决策；探测失败保守转码。
        if (PlaybackStrategy.needsProbe(item)) {
            update { it.copy(status = "正在探测媒体信息...", buffering = true) }
            val probed = runCatching { api.probe(item.id).media }.getOrNull() ?: item
            media = probed
            launchPlayback(probed)
            return
        }
        playMode = PlaybackStrategy.decide(item)
        update { it.copy(playMode = playMode, loading = false) }
        if (playMode == PlayMode.TRANSCODE) {
            quality = "1080"
            update { it.copy(quality = quality) }
            val resume = if ((item.position ?: 0.0) > 5.0) item.position!! else 0.0
            startTranscode(resume)
        } else {
            playDirect()
        }
    }

    private fun playDirect() {
        update { it.copy(status = "") }
        val base = baseUrlProvider()?.trimEnd('/')
        if (base == null) {
            update { it.copy(loading = false, error = "服务器地址缺失，请重新登录") }
            return
        }
        val url = "$base/api/media/$mediaId/file"
        Log.d(TAG, "playDirect url=$url")
        setMediaItem(url, live = false)
        player.playWhenReady = true
        player.play()
        // 恢复进度
        val resume = media?.position?.takeIf { it > 5 } ?: 0.0
        if (resume > 0) player.seekTo((resume * 1000).toLong())
    }

    private fun startTranscode(start: Double) {
        update { it.copy(loading = true, error = "", status = "正在启动转码...", buffering = true) }
        scope.launch {
            runCatching { api.transcode(mediaId, TranscodeRequest(start = start, quality = quality, mode = "transcode")) }
                .onSuccess { resp ->
                    sessionId = resp.session ?: ""
                    offsetStart = resp.start ?: start
                    coveredUntil = resp.coveredUntil
                    initialSeekMs = ((start - offsetStart).coerceAtLeast(0.0) * 1000).toLong()
                    sessionDead = false
                    retryCount = 0
                    retryJob?.cancel()
                    startKeepalive()
                    setMediaItem(playlistUrl(resp.playlist), live = true)
                    player.playWhenReady = true
                    player.play()
                    update { it.copy(loading = false, status = "", buffering = true) }
                }
                .onFailure { e -> handleTranscodeFailure(e, start) }
        }
    }

    private fun setMediaItem(url: String, live: Boolean) {
        val builder = MediaItem.Builder().setUri(url)
        if (live) {
            // 伪 live（无 ENDLIST）：默认从窗口最早处开始，避免贴 live edge。
            builder.setLiveConfiguration(MediaItem.LiveConfiguration.Builder().setTargetOffsetMs(300_000).build())
        }
        Log.d(TAG, "setMediaItem url=$url live=$live")
        player.setMediaItem(builder.build())
        player.prepare()
        Log.d(TAG, "prepare called, state=${player.playbackState}")
    }

    private fun playlistUrl(path: String): String {
        if (path.startsWith("http")) return path
        return baseUrlProvider()?.trimEnd('/') + "/" + path.trimStart('/')
    }

    private fun handleTranscodeFailure(e: Throwable, start: Double) {
        val message = e.message ?: ""
        val throttled = message.contains("429") || message.contains("Too Many Requests") || message.contains("网盘请求过于频繁")
        if (throttled) {
            scheduleRateLimitRetry(start)
            return
        }
        update { it.copy(loading = false, buffering = false, status = "", error = "转码启动失败：${e.friendlyMessage()}") }
    }

    // ---- 限流退避：30s → 60s → 120s，最多 3 次 ----
    private fun scheduleRateLimitRetry(start: Double) {
        if (retryJob?.isActive == true || retryCount >= 3) return
        val delayMs = min(30_000L * (1L shl retryCount), 120_000L)
        retryCount++
        update { it.copy(loading = false, buffering = false, status = "网盘限流中，${delayMs / 1000} 秒后自动重试...") }
        retryJob = scope.launch {
            delay(delayMs)
            startTranscode(start)
        }
    }

    // ---- 播放控制 ----
    fun togglePlay() {
        if (player.isPlaying) {
            player.pause()
        } else {
            if (playMode == PlayMode.TRANSCODE && sessionDead) {
                sessionDead = false
                restartTranscode(positionSec())
            } else {
                player.play()
            }
        }
    }

    fun seekBy(seconds: Int) {
        if (playMode == PlayMode.TRANSCODE && sessionDead) return
        seekTo(positionSec() + seconds)
    }

    fun seekTo(absSec: Double) {
        lastUserSeekMs = System.currentTimeMillis()
        if (playMode == PlayMode.DIRECT) {
            player.seekTo((absSec.coerceAtLeast(0.0) * 1000).toLong())
            return
        }
        val windowEnd = offsetStart + (player.duration.takeIf { it > 0 } ?: 0L) / 1000.0
        val cached = coveredUntil ?: 0.0
        val inWindow = absSec >= offsetStart - 5 && absSec <= windowEnd + 5
        if (inWindow || absSec <= cached + 5) {
            player.seekTo(((absSec - offsetStart).coerceAtLeast(0.0) * 1000).toLong())
            verifySeek(absSec)
        } else {
            restartTranscode(absSec)
        }
    }

    private fun verifySeek(target: Double) {
        scope.launch {
            delay(2000)
            if (playMode != PlayMode.TRANSCODE) return@launch
            val actual = positionSec()
            if (abs(actual - target) > 30) restartTranscode(target)
        }
    }

    fun restartTranscode(at: Double) {
        if (playMode != PlayMode.TRANSCODE) return
        if (retryJob?.isActive == true) return
        stopSession()
        startTranscode(at)
    }

    private fun stopSession() {
        val session = sessionId
        sessionId = ""
        keepaliveJob?.cancel()
        if (session.isNotBlank()) {
            scope.launch { runCatching { api.stopTranscode(session) } }
        }
    }

    /** 转码会话保活：暂停时 HLS 不再请求段，防止服务端空闲回收 ffmpeg。 */
    private fun startKeepalive() {
        keepaliveJob?.cancel()
        keepaliveJob = scope.launch {
            while (isActive) {
                delay(60_000)
                val session = sessionId
                if (session.isNotBlank()) runCatching { api.keepalive(session) }
            }
        }
    }

    fun switchQuality(next: String) {
        if (next == quality || playMode != PlayMode.TRANSCODE) return
        quality = next
        update { it.copy(quality = next) }
        restartTranscode(positionSec())
    }

    fun setRate(rate: Float) {
        player.setPlaybackSpeed(rate)
        update { it.copy(rate = rate) }
    }

    fun setVolume(volume: Float) {
        player.volume = volume.coerceIn(0f, 1f)
        update { it.copy(volume = player.volume) }
    }

    fun nudgeVolume(delta: Float) {
        setVolume(player.volume + delta)
    }

    fun toggleSubtitles() {
        val enabled = !_state.value.subtitlesEnabled
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !enabled)
            .build()
        update { it.copy(subtitlesEnabled = enabled) }
    }

    private fun positionSec(): Double = player.currentPosition / 1000.0 + offsetStart

    // ---- 进度上报（节流 5s，completed 判定对齐网页端） ----
    fun save(force: Boolean = false) {
        val item = media ?: return
        val absPos = positionSec()
        val duration = item.duration
            ?: item.progressDuration
            ?: (player.duration / 1000.0).takeIf { it > 0 }
            ?: 0.0
        if (duration <= 0 || absPos <= 0) return
        // 失败/卡住的位置 0 不允许覆盖已保存的进度
        if (absPos < 5 && (item.position ?: 0.0) > 30) return
        val now = System.currentTimeMillis()
        if (!force && now - lastSavedMs < 5000) return
        lastSavedMs = now
        val remaining = duration - absPos
        // 拖动到结尾不算看完：用户 seek 后 30s 内不判定 completed
        val watchedThrough = remaining < 2 || now - lastUserSeekMs > 30_000
        val completed = remaining <= duration * 0.05 && watchedThrough && absPos <= duration + 2
        val position = min(absPos, duration)
        scope.launch {
            runCatching { api.progress(item.id, ProgressRequest(position = position, duration = duration, completed = completed)) }
        }
    }

    fun release() {
        stopSession()
        retryJob?.cancel()
        pauseDestroyJob?.cancel()
        save(force = true)
        player.release()
        scope.cancel()
    }
    /** 播放失败后的手动重试：按当前媒体与位置重新发起播放。 */
    fun retry() {
        val item = media ?: return
        update { it.copy(error = "", status = "", buffering = false) }
        if (playMode == PlayMode.TRANSCODE) {
            startTranscode(positionSec())
        } else {
            playDirect()
        }
    }

    // ---- Player.Listener ----
    override fun onIsPlayingChanged(isPlaying: Boolean) {
        update { it.copy(playing = isPlaying) }
        pauseDestroyJob?.cancel()
        if (!isPlaying) {
            save()
            if (playMode == PlayMode.TRANSCODE && sessionId.isNotBlank()) {
                // 暂停超过 1 分钟销毁转码会话，避免 ffmpeg 持续拉流。
                pauseDestroyJob = scope.launch {
                    delay(60_000)
                    if (!player.isPlaying && sessionId.isNotBlank()) {
                        val session = sessionId
                        sessionId = ""
                        sessionDead = true
                        runCatching { api.stopTranscode(session) }
                    }
                }
            }
        } else {
            update { it.copy(status = "") }
            retryCount = 0
            retryJob?.cancel()
        }
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        update {
            it.copy(
                buffering = playbackState == Player.STATE_BUFFERING,
                loading = false,
            )
        }
    }

    override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        if (initialSeekMs > 1000) {
            val seek = initialSeekMs
            initialSeekMs = 0
            player.seekTo(seek)
        }
    }

    override fun onTracksChanged(tracks: Tracks) {
        val hasText = tracks.groups.any { group ->
            group.type == C.TRACK_TYPE_TEXT &&
                (0 until group.length).any { group.isTrackSupported(it) }
        }
        update { it.copy(subtitlesAvailable = hasText) }
    }

    override fun onPlayerError(error: PlaybackException) {
        val message = error.message ?: ""
        val throttled = message.contains("429") || message.contains("416") ||
            message.contains("Too Many Requests") || message.contains("网盘请求过于频繁")
        if (throttled) {
            scheduleRateLimitRetry(positionSec())
            return
        }
        // 转码流首次致命错误自动重启一次；重启后仍失败交给用户。
        if (playMode == PlayMode.TRANSCODE && !autoRestarted) {
            autoRestarted = true
            restartTranscode(positionSec())
            return
        }
        update {
            it.copy(
                buffering = false,
                status = "",
                error = if (playMode == PlayMode.TRANSCODE) "转码播放失败，请重试" else "播放失败：$message",
            )
        }
    }

    /** 多版本集去重（同季同集取最大文件），按季集排序。 */
    companion object {
        private const val TAG = "FPlayerPlayer"

        fun sortEpisodes(media: List<Media>): List<Media> {
            val byKey = LinkedHashMap<Pair<Int, Int>, Media>()
            for (item in media) {
                val s = item.season ?: continue
                val e = item.episode ?: continue
                val key = s to e
                val existing = byKey[key]
                if (existing == null || (item.size ?: 0) > (existing.size ?: 0)) byKey[key] = item
            }
            return byKey.values.sortedWith(compareBy({ it.season ?: 0 }, { it.episode ?: 0 }))
        }
    }
}