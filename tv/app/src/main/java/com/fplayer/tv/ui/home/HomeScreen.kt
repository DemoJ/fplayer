package com.fplayer.tv.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.data.Media
import com.fplayer.tv.data.UpNext
import com.fplayer.tv.ui.common.MediaCard
import com.fplayer.tv.ui.common.MediaRow
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

private fun pad(value: Int) = value.toString().padStart(2, '0')

private fun episodeLabel(media: Media): String =
    "S${pad(media.season ?: 0)}E${pad(media.episode ?: 0)}"

private fun mediaSubtitle(media: Media): String? =
    if (media.kind == "show") episodeLabel(media) else null

/** 继续观看进度：position / progress_duration，无可靠数据时不显示进度条。 */
private fun mediaProgress(media: Media): Float? {
    val position = media.position ?: return null
    val duration = media.progressDuration ?: media.duration ?: return null
    if (duration <= 0) return null
    return (position / duration).toFloat()
}

@Composable
fun HomeScreen(onPlay: (Long) -> Unit) {
    val api = AppContainer.apiClient.api
    var continued by remember { mutableStateOf<List<Media>>(emptyList()) }
    var upNext by remember { mutableStateOf<List<UpNext>>(emptyList()) }
    var recent by remember { mutableStateOf<List<Media>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        val result = coroutineScope {
            val a = async { runCatching { api.continueWatching() }.getOrDefault(emptyList()) }
            val b = async { runCatching { api.upNext() }.getOrDefault(emptyList()) }
            val c = async { runCatching { api.recent() }.getOrDefault(emptyList()) }
            Triple(a.await(), b.await(), c.await())
        }
        continued = result.first
        upNext = result.second
        recent = result.third
        loading = false
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            Column(modifier = Modifier.padding(start = 48.dp, end = 48.dp, top = 20.dp, bottom = 16.dp)) {
                Text(
                    text = "PRIVATE CINEMA",
                    color = Color(0xFFE4322D),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 3.sp,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "今晚，看点什么？",
                    color = Color.White,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.Bold,
                )
            }

            if (loading) {
                Text(
                    text = "正在载入媒体库...",
                    color = Color(0xFF6E6E74),
                    fontSize = 15.sp,
                    modifier = Modifier.padding(horizontal = 40.dp),
                )
                Spacer(Modifier.height(24.dp))
            }

            MediaRow(title = "继续观看", count = continued.size) { index ->
                val media = continued[index]
                MediaCard(
                    imagePath = media.workPoster,
                    title = media.title,
                    subtitle = mediaSubtitle(media),
                    progress = mediaProgress(media),
                    fallbackText = media.title,
                    onClick = { onPlay(media.id) },
                )
            }
            Spacer(Modifier.height(20.dp))

            MediaRow(title = "接下来", count = upNext.size) { index ->
                val item = upNext[index]
                MediaCard(
                    imagePath = item.workPoster,
                    title = item.workTitle,
                    subtitle = "下一集 S${pad(item.season)}E${pad(item.episode)}",
                    fallbackText = item.workTitle,
                    onClick = { onPlay(item.id) },
                )
            }
            Spacer(Modifier.height(20.dp))

            MediaRow(title = "最近添加", count = recent.size) { index ->
                val media = recent[index]
                MediaCard(
                    imagePath = media.workPoster,
                    title = media.title,
                    subtitle = mediaSubtitle(media),
                    fallbackText = media.title,
                    onClick = { onPlay(media.id) },
                )
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}