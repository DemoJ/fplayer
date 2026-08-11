package com.fplayer.tv.ui.main

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.Tab
import androidx.tv.material3.TabRow
import com.fplayer.tv.core.Session
import com.fplayer.tv.data.Work
import com.fplayer.tv.ui.detail.WorkDetailScreen
import com.fplayer.tv.ui.home.HomeScreen
import com.fplayer.tv.ui.library.LibraryScreen
import com.fplayer.tv.ui.library.SearchScreen
import com.fplayer.tv.ui.player.PlayerScreen

private val tabs = listOf("首页", "电影", "剧集", "搜索")

@Composable
fun MainScreen(session: Session, onLogout: () -> Unit) {
    var tab by remember { mutableIntStateOf(0) }
    var detailWorkId by remember { mutableStateOf<Long?>(null) }
    var playingMediaId by remember { mutableStateOf<Long?>(null) }

    // BACK 导航：播放页 → 详情 → 列表/首页（首页 BACK 交给系统退出应用）。
    BackHandler(enabled = playingMediaId != null) { playingMediaId = null }
    BackHandler(enabled = detailWorkId != null && playingMediaId == null) { detailWorkId = null }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
    ) {
        TopBar(session, onLogout)
        TabRow(
            selectedTabIndex = tab,
            modifier = Modifier.fillMaxWidth(),
        ) {
            tabs.forEachIndexed { index, label ->
                Tab(
                    selected = tab == index,
                    onClick = { tab = index; detailWorkId = null; playingMediaId = null },
                    onFocus = {},
                    content = { Text(label) },
                )
            }
        }
        val playingId = playingMediaId
        if (playingId != null) {
            // key 强制重建：切集时重置 ExoPlayer 与播放状态。
            key(playingId) {
                PlayerScreen(
                    mediaId = playingId,
                    onBack = { playingMediaId = null },
                    onSwitchEpisode = { playingMediaId = it },
                )
            }
            return@Column
        }
        val workId = detailWorkId
        if (workId != null) {
            WorkDetailScreen(
                workId = workId,
                onBack = { detailWorkId = null },
                onPlay = { playingMediaId = it },
            )
        } else {
            when (tab) {
                0 -> HomeScreen(onPlay = { playingMediaId = it })
                1 -> LibraryScreen(kind = "movie", onWorkClick = { detailWorkId = it.id })
                2 -> LibraryScreen(kind = "show", onWorkClick = { detailWorkId = it.id })
                else -> SearchScreen(onWorkClick = { detailWorkId = it.id })
            }
        }
    }
}

@Composable
private fun TopBar(session: Session, onLogout: () -> Unit) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 48.dp, end = 32.dp, top = 8.dp, bottom = 4.dp),
        ) {
        Text(
            text = "F",
            color = Color(0xFFE4322D),
            fontSize = 26.sp,
            fontWeight = FontWeight.Black,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = "FPLAYER",
            color = Color.White,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 3.sp,
        )
        Spacer(Modifier.weight(1f))
        Text(
            text = session.username,
            color = Color(0xFF9A9AA0),
            fontSize = 14.sp,
        )
        Spacer(Modifier.width(16.dp))
        Button(onClick = onLogout) {
            Text("退出登录")
        }
    }
}