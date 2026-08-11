package com.fplayer.tv.ui.player

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Button
import com.fplayer.tv.core.AppContainer
import kotlin.math.roundToLong

private fun formatTime(ms: Long): String {
    val total = (ms.coerceAtLeast(0) / 1000).toInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}" else "$m:${s.toString().padStart(2, '0')}"
}

/**
 * 全屏播放页：ExoPlayer 视频 + 遥控器按键控制 + MENU 面板（画质/倍速/字幕/上下集）。
 */
@Composable
fun PlayerScreen(
    mediaId: Long,
    onBack: () -> Unit,
    onSwitchEpisode: (Long) -> Unit,
) {
    val context = LocalContext.current
    val controller = remember {
        PlayerController(
            context = context,
            api = AppContainer.apiClient.api,
            tokenProvider = { AppContainer.apiClient.bearerToken() },
            baseUrlProvider = { AppContainer.apiClient.currentBaseUrl() },
        )
    }
    val state by controller.state.collectAsState()
    var menuOpen by remember { mutableStateOf(false) }
    val videoFocus = remember { FocusRequester() }
    val menuFocus = remember { FocusRequester() }

    DisposableEffect(Unit) {
        onDispose { controller.release() }
    }
    LaunchedEffect(mediaId) { controller.load(mediaId) }
    LaunchedEffect(Unit) { videoFocus.requestFocus() }
    LaunchedEffect(menuOpen) {
        if (menuOpen) menuFocus.requestFocus()
    }
    // 播放期间保持屏幕常亮
    DisposableEffect(Unit) {
        val window = (context as android.app.Activity).window
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    BackHandler(enabled = menuOpen) { menuOpen = false }
    // BACK：菜单已关时保存进度并返回（BACK 是系统键，不走 onPreviewKeyEvent）。
    BackHandler(enabled = !menuOpen) {
        controller.save(force = true)
        onBack()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(videoFocus)
            .focusable()
            .onPreviewKeyEvent { event ->
                if (menuOpen) return@onPreviewKeyEvent false
                if (event.nativeKeyEvent.action != KeyEvent.ACTION_DOWN) return@onPreviewKeyEvent false
                when (event.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_DPAD_CENTER,
                    KeyEvent.KEYCODE_ENTER,
                    KeyEvent.KEYCODE_SPACE -> {
                        // 播放失败时 OK 键直接重试（错误遮罩会拦截焦点，遥控器无法移到按钮）。
                        if (state.error.isNotBlank()) controller.retry() else controller.togglePlay()
                        true
                    }
                    KeyEvent.KEYCODE_DPAD_LEFT -> { controller.seekBy(-5); true }
                    KeyEvent.KEYCODE_DPAD_RIGHT -> { controller.seekBy(5); true }
                    KeyEvent.KEYCODE_DPAD_UP -> { controller.nudgeVolume(0.1f); true }
                    KeyEvent.KEYCODE_DPAD_DOWN -> { controller.nudgeVolume(-0.1f); true }
                    KeyEvent.KEYCODE_MENU,
                    KeyEvent.KEYCODE_INFO -> { menuOpen = true; true }
                    else -> false
                }
            },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    player = controller.player
                    useController = false
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        // 顶部信息条
        Column(
            modifier = Modifier
                .align(Alignment.TopStart)
                .fillMaxWidth()
                .background(
                    androidx.compose.ui.graphics.Brush.verticalGradient(
                        0f to Color(0xB3000000),
                        1f to Color.Transparent,
                    ),
                )
                .padding(start = 36.dp, top = 24.dp, end = 36.dp, bottom = 40.dp),
        ) {
            Text(
                text = "← 返回",
                color = Color(0xCCFFFFFF),
                fontSize = 15.sp,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = state.title,
                color = Color.White,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val label = state.episodeLabel
            if (label != null) {
                Text(
                    text = label,
                    color = Color(0xFFE4322D),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }

        // 底部控制条：进度 + 时间 + 状态
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(
                    androidx.compose.ui.graphics.Brush.verticalGradient(
                        0f to Color.Transparent,
                        1f to Color(0xB3000000),
                    ),
                )
                .padding(start = 36.dp, end = 36.dp, bottom = 32.dp, top = 48.dp),
        ) {
            if (state.status.isNotBlank()) {
                Text(
                    text = state.status,
                    color = Color(0xFFFFC107),
                    fontSize = 14.sp,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .background(Color(0x66FFFFFF), RoundedCornerShape(3.dp)),
            ) {
                val progress = if (state.durationMs > 0) {
                    (state.positionMs.toFloat() / state.durationMs.toFloat()).coerceIn(0f, 1f)
                } else 0f
                Box(
                    modifier = Modifier
                        .fillMaxWidth(progress)
                        .height(6.dp)
                        .background(Color(0xFFE4322D), RoundedCornerShape(3.dp)),
                )
            }
            Row(modifier = Modifier.padding(top = 8.dp)) {
                Text(
                    text = formatTime(state.positionMs),
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = if (state.playMode == PlayMode.TRANSCODE) "${state.quality} · 转码" else "直连",
                    color = Color(0xAAFFFFFF),
                    fontSize = 13.sp,
                )
                Spacer(Modifier.width(16.dp))
                Text(
                    text = formatTime(state.durationMs),
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
            Text(
                text = "OK 播放/暂停 · ◀▶ 退/进 5 秒 · ▲▼ 音量 · MENU 更多",
                color = Color(0x88FFFFFF),
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 10.dp),
            )
        }

        if (state.buffering) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("缓冲中...", color = Color.White, fontSize = 18.sp)
            }
        }

        if (state.error.isNotBlank()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(state.error, color = Color(0xFFFF6B6B), fontSize = 16.sp)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { controller.retry() }) { Text("重试") }
                }
            }
        }

        if (menuOpen) {
            MenuPanel(
                state = state,
                focusRequester = menuFocus,
                onClose = { menuOpen = false },
                onSwitchQuality = { controller.switchQuality(it) },
                onSetRate = { controller.setRate(it) },
                onToggleSubtitles = { controller.toggleSubtitles() },
                onPrev = { controller.save(force = true); state.prevId?.let(onSwitchEpisode) },
                onNext = { controller.save(force = true); state.nextId?.let(onSwitchEpisode) },
            )
        }
    }
}