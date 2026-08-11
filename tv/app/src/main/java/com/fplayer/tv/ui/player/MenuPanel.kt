package com.fplayer.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button

private val RATES = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)

/**
 * MENU 面板：画质（仅转码）/ 倍速 / 字幕 / 上一集 / 下一集。
 * 面板打开时焦点进入内部按钮，BACK 或再次 MENU 关闭。
 */
@Composable
fun MenuPanel(
    state: PlayerUiState,
    focusRequester: FocusRequester,
    onClose: () -> Unit,
    onSwitchQuality: (String) -> Unit,
    onSetRate: (Float) -> Unit,
    onToggleSubtitles: () -> Unit,
    onPrev: () -> Unit,
    onNext: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0x66000000)),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.weight(1f))
        Column(
            modifier = Modifier
                .width(420.dp)
                .background(Color(0xF01A1A1E), RoundedCornerShape(16.dp))
                .padding(24.dp),
        ) {
            Text(
                text = "播放设置",
                color = Color.White,
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(20.dp))

            if (state.playMode == PlayMode.TRANSCODE) {
                MenuSectionTitle("画质")
                Row {
                    listOf("原画", "1080P", "720P").forEachIndexed { i, label ->
                        val value = when (label) {
                            "原画" -> "original"
                            "720P" -> "720"
                            else -> "1080"
                        }
                        val buttonModifier = if (i == 0) Modifier.focusRequester(focusRequester) else Modifier
                        Button(
                            onClick = { onSwitchQuality(value); onClose() },
                            modifier = buttonModifier.padding(end = 12.dp),
                        ) {
                            Text(if (state.quality == value) "● $label" else label)
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }

            MenuSectionTitle("倍速")
            Row {
                RATES.forEachIndexed { i, rate ->
                    val buttonModifier = if (state.playMode != PlayMode.TRANSCODE && i == 0) {
                        Modifier.focusRequester(focusRequester)
                    } else {
                        Modifier
                    }
                    Button(
                        onClick = { onSetRate(rate); onClose() },
                        modifier = buttonModifier.padding(end = 12.dp),
                    ) {
                        Text(if (state.rate == rate) "● ${rate}x" else "${rate}x")
                    }
                }
            }
            Spacer(Modifier.height(16.dp))

            MenuSectionTitle("字幕")
            Row {
                Button(
                    onClick = { onToggleSubtitles(); onClose() },
                    modifier = Modifier.padding(end = 12.dp),
                ) {
                    Text(if (state.subtitlesEnabled) "● 开" else "关")
                }
            }
            Spacer(Modifier.height(16.dp))

            if (state.prevId != null || state.nextId != null) {
                MenuSectionTitle("剧集")
                Row {
                    if (state.prevId != null) {
                        Button(
                            onClick = { onPrev() },
                            modifier = Modifier.padding(end = 12.dp),
                        ) { Text("上一集") }
                    }
                    if (state.nextId != null) {
                        Button(
                            onClick = { onNext() },
                            modifier = Modifier.padding(end = 12.dp),
                        ) { Text("下一集") }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }

            Button(onClick = onClose) { Text("关闭") }
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun MenuSectionTitle(text: String) {
    Text(
        text = text,
        color = Color(0xFF9A9AA0),
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 10.dp),
    )
}