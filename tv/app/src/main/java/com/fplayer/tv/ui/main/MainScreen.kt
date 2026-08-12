package com.fplayer.tv.ui.main

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.Tab
import androidx.tv.material3.TabRow
import androidx.tv.material3.TabRowDefaults
import com.fplayer.tv.core.Session
import com.fplayer.tv.data.Work
import com.fplayer.tv.ui.browse.BrowseScreen
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
    var browseSourceId by remember { mutableStateOf<Long?>(null) }
    var playingMediaId by remember { mutableStateOf<Long?>(null) }
    // 播放返回时递增，通知首页恢复上次聚焦的卡片。
    var homeRestoreTick by remember { mutableIntStateOf(0) }

    // TabRow 将 focusGroup + focusRestorer 组成独立焦点组：
    // 1. 左右键在组内用方向键预览拦截 + FocusRequester 显式切换，焦点绝不会外逃到"退出登录"等其它层级；
    // 2. 焦点离开组（如去内容区）再回来时，恢复到组内上次聚焦的 tab。
    val tabFocusRequesters = remember { tabs.map { FocusRequester() } }

    // tab 跟随左右键或点击变化后，把焦点显式移动到对应的 Tab 上。
    LaunchedEffect(tab) {
        tabFocusRequesters[tab].requestFocus()
    }

    // BACK 导航：播放页 → 详情/浏览 → 列表/首页（首页 BACK 交给系统退出应用）。
    BackHandler(enabled = playingMediaId != null) { playingMediaId = null }
    BackHandler(enabled = (detailWorkId != null || browseSourceId != null) && playingMediaId == null) {
        detailWorkId = null
        browseSourceId = null
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
    ) {
        // 主界面保持组合：播放页作为覆盖层，返回后首页数据、滚动位置与焦点状态不丢。
        Column(
            modifier = Modifier.fillMaxSize(),
        ) {
        TopBar(session, onLogout)
        TabRow(
            selectedTabIndex = tab,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 36.dp)
                .focusGroup()
                .focusRestorer()
                .onPreviewKeyEvent { keyEvent ->
                    if (keyEvent.type == KeyEventType.KeyDown) {
                        when (keyEvent.key) {
                            Key.DirectionRight -> {
                                if (tab < tabs.lastIndex) tab += 1
                                true
                            }
                            Key.DirectionLeft -> {
                                if (tab > 0) tab -= 1
                                true
                            }
                            else -> false
                        }
                    } else {
                        false
                    }
                },
            separator = { Spacer(Modifier.width(12.dp)) },
            indicator = { tabPositions, doesTabRowHaveFocus ->
                tabPositions.getOrNull(tab)?.let { position ->
                    TabRowDefaults.PillIndicator(
                        currentTabPosition = position,
                        doesTabRowHaveFocus = doesTabRowHaveFocus,
                        activeColor = Color(0xFFE4322D),
                        inactiveColor = Color(0xFFE4322D).copy(alpha = 0.25f),
                    )
                }
            },
        ) {
            tabs.forEachIndexed { index, label ->
                val selected = tab == index
                Tab(
                    selected = selected,
                    onClick = { tab = index; detailWorkId = null; browseSourceId = null; playingMediaId = null },
                    onFocus = {},
                    modifier = Modifier.focusRequester(tabFocusRequesters[index]),
                ) {
                    Text(
                        text = label,
                        color = if (selected) Color.White else Color(0xFF9A9AA0),
                        fontSize = 16.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                        modifier = Modifier.padding(horizontal = 24.dp, vertical = 10.dp),
                    )
                }
            }
        }
        val workId = detailWorkId
        val browseId = browseSourceId
        if (workId != null) {
            WorkDetailScreen(
                workId = workId,
                onBack = { detailWorkId = null },
                onPlay = { playingMediaId = it },
            )
        } else if (browseId != null) {
            BrowseScreen(
                sourceId = browseId,
                onBack = {
                    browseSourceId = null
                    homeRestoreTick += 1
                },
                onPlay = { playingMediaId = it },
            )
        } else {
            when (tab) {
                0 -> HomeScreen(
                    onPlay = { playingMediaId = it },
                    onSourceClick = { browseSourceId = it },
                    restoreTick = homeRestoreTick,
                )
                1 -> LibraryScreen(kind = "movie", onWorkClick = { detailWorkId = it.id })
                2 -> LibraryScreen(kind = "show", onWorkClick = { detailWorkId = it.id })
                else -> SearchScreen(onWorkClick = { detailWorkId = it.id })
            }
        }
        }

        // 播放页覆盖全屏（含顶栏与 tab 栏区域）；返回时递增 restoreTick 通知首页恢复焦点。
        val playingId = playingMediaId
        if (playingId != null) {
            // key 强制重建：切集时重置 ExoPlayer 与播放状态。
            key(playingId) {
                PlayerScreen(
                    mediaId = playingId,
                    onBack = {
                        playingMediaId = null
                        homeRestoreTick += 1
                    },
                    onSwitchEpisode = { playingMediaId = it },
                )
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