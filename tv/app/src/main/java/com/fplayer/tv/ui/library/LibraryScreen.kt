package com.fplayer.tv.ui.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.data.Work
import com.fplayer.tv.data.friendlyMessage
import com.fplayer.tv.ui.common.WorkGrid
import kotlinx.coroutines.launch

private const val PAGE_SIZE = 60

/**
 * 电影 / 剧集媒体库：作品网格 + 滚动到底部分页加载。
 */
@Composable
fun LibraryScreen(
    kind: String,
    onWorkClick: (Work) -> Unit,
) {
    val api = AppContainer.apiClient.api
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<Work>>(emptyList()) }
    var total by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var loadingMore by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var reloadKey by remember { mutableIntStateOf(0) }
    val gridState = rememberLazyGridState()

    fun loadMore() {
        if (loadingMore || loading || items.size >= total) return
        loadingMore = true
        scope.launch {
            runCatching { api.works(kind = kind, limit = PAGE_SIZE, offset = items.size) }
                .onSuccess { r ->
                    items = items + r.items
                    total = r.total
                }
            loadingMore = false
        }
    }

    LaunchedEffect(kind, reloadKey) {
        loading = true
        error = ""
        runCatching { api.works(kind = kind, limit = PAGE_SIZE, offset = 0) }
            .onSuccess { r -> items = r.items; total = r.total }
            .onFailure { error = it.friendlyMessage() }
        loading = false
    }

    LaunchedEffect(gridState) {
        snapshotFlow {
            val last = gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            last to gridState.layoutInfo.totalItemsCount
        }.collect { (last, count) ->
            if (count > 0 && last >= count - 6) loadMore()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.Bottom,
                modifier = Modifier.padding(start = 36.dp, end = 36.dp, top = 32.dp, bottom = 18.dp),
            ) {
                Text(
                    text = if (kind == "movie") "全部电影" else "全部剧集",
                    color = Color.White,
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = "$total 部",
                    color = Color(0xFF6E6E74),
                    fontSize = 16.sp,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
            when {
                loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("正在载入...", color = Color(0xFF6E6E74), fontSize = 15.sp)
                }
                error.isNotBlank() && items.isEmpty() -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(error, color = Color(0xFFFF6B6B), fontSize = 15.sp)
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { reloadKey++ }) {
                            Text("重试")
                        }
                    }
                }
                items.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("暂无内容，请先在网页端添加媒体源并扫描", color = Color(0xFF6E6E74), fontSize = 15.sp)
                }
                else -> WorkGrid(
                    items = items,
                    onItemClick = onWorkClick,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}