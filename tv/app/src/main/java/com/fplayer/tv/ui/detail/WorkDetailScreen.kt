package com.fplayer.tv.ui.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.data.Media
import com.fplayer.tv.data.WorkDetailResponse
import com.fplayer.tv.data.friendlyMessage
import com.fplayer.tv.ui.common.EpisodeCard
import com.fplayer.tv.ui.common.PosterImage

/**
 * 作品详情页：backdrop 头部 + 概述；剧集按季分组横排，电影单行。
 * 点击媒体由 [onPlay] 交给上层（M4 接入播放器）。
 */
@Composable
fun WorkDetailScreen(
    workId: Long,
    onBack: () -> Unit,
    onPlay: (Long) -> Unit,
) {
    val api = AppContainer.apiClient.api
    var data by remember { mutableStateOf<WorkDetailResponse?>(null) }
    var error by remember { mutableStateOf("") }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(workId, reloadKey) {
        runCatching { api.workDetail(workId) }
            .onSuccess { data = it }
            .onFailure { error = it.friendlyMessage() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
    ) {
        when {
            data == null && error.isBlank() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("正在载入作品...", color = Color(0xFF6E6E74), fontSize = 15.sp)
            }
            error.isNotBlank() && data == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(error, color = Color(0xFFFF6B6B), fontSize = 15.sp)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { reloadKey++ }) { Text("重试") }
                }
            }
            data != null -> Content(data!!, onBack, onPlay)
        }
    }
}

@Composable
private fun Content(data: WorkDetailResponse, onBack: () -> Unit, onPlay: (Long) -> Unit) {
    val work = data.work
    val media = data.media
    val seasons = media.mapNotNull { it.season }.distinct().sorted()

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            Column {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 28.dp, top = 20.dp, end = 28.dp, bottom = 8.dp),
                ) {
                    Button(onClick = onBack) {
                        Text("← 返回")
                    }
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(16f / 9f),
                ) {
                    PosterImage(
                        path = work.backdropPath ?: work.posterPath,
                        modifier = Modifier.fillMaxSize(),
                        fallbackText = work.title,
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(
                                Brush.verticalGradient(
                                    0f to Color.Transparent,
                                    0.55f to Color(0x660E0E10),
                                    1f to Color(0xFF0E0E10),
                                ),
                            ),
                    )
                    Column(
                        modifier = Modifier
                            .align(Alignment.BottomStart)
                            .padding(horizontal = 36.dp, vertical = 24.dp),
                    ) {
                        Text(
                            text = "${if (work.kind == "show") "剧集" else "电影"} · ${work.year ?: "未匹配年份"}",
                            color = Color(0xFFE4322D),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 2.sp,
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            text = work.title,
                            color = Color.White,
                            fontSize = 42.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        if (work.originalTitle != null && work.originalTitle != work.title) {
                            Text(
                                text = work.originalTitle,
                                color = Color(0xFF9A9AA0),
                                fontSize = 16.sp,
                            )
                        }
                    }
                }
                if (!work.overview.isNullOrBlank()) {
                    Text(
                        text = work.overview,
                        color = Color(0xFFC8C8CC),
                        fontSize = 15.sp,
                        lineHeight = 24.sp,
                        maxLines = 5,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 36.dp, end = 36.dp, top = 8.dp, bottom = 24.dp),
                    )
                }
            }
        }

        if (work.kind == "show" && seasons.isNotEmpty()) {
            seasons.forEach { season ->
                val episodes = media.filter { it.season == season }.sortedBy { it.episode ?: 0 }
                item {
                    Text(
                        text = "第 $season 季 · ${episodes.size} 集",
                        color = Color.White,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(start = 36.dp, end = 36.dp, bottom = 14.dp),
                    )
                }
                item {
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 32.dp),
                        horizontalArrangement = Arrangement.spacedBy(18.dp),
                    ) {
                        items(episodes.size) { index ->
                            EpisodeCard(media = episodes[index], onClick = { onPlay(episodes[index].id) })
                        }
                    }
                }
                item { Spacer(Modifier.height(28.dp)) }
            }
        } else if (media.isNotEmpty()) {
            item {
                Text(
                    text = "播放源",
                    color = Color.White,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(start = 36.dp, end = 36.dp, bottom = 14.dp),
                )
            }
            item {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 32.dp),
                    horizontalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    items(media.size) { index ->
                        EpisodeCard(media = media[index], onClick = { onPlay(media[index].id) })
                    }
                }
            }
            item { Spacer(Modifier.height(28.dp)) }
        }
    }
}