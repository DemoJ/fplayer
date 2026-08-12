package com.fplayer.tv.ui.browse

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.data.BrowseResult
import com.fplayer.tv.data.Media
import com.fplayer.tv.data.friendlyMessage

/**
 * 媒体源目录浏览页：面包屑导航 + 文件夹/文件列表。
 * 文件夹行进入子目录，文件行直接播放。
 */
@Composable
fun BrowseScreen(
    sourceId: Long,
    onBack: () -> Unit,
    onPlay: (Long) -> Unit,
) {
    val api = AppContainer.apiClient.api
    var data by remember { mutableStateOf<BrowseResult?>(null) }
    var path by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }

    LaunchedEffect(sourceId, path) {
        error = ""
        runCatching { api.browse(sourceId = sourceId, path = path) }
            .onSuccess { data = it }
            .onFailure { error = it.friendlyMessage() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 28.dp, top = 20.dp, end = 28.dp, bottom = 12.dp),
            ) {
                Button(onClick = onBack) { Text("← 返回") }
                Spacer(Modifier.width(20.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = data?.source?.name ?: "浏览媒体",
                        color = Color.White,
                        fontSize = 28.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    if (data != null && data!!.crumbs.size > 1) {
                        Text(
                            text = data!!.crumbs.joinToString(" / ") { it.name },
                            color = Color(0xFF9A9AA0),
                            fontSize = 14.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            when {
                error.isNotBlank() && data == null -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(error, color = Color(0xFFFF6B6B), fontSize = 15.sp)
                }
                data == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("正在读取目录...", color = Color(0xFF6E6E74), fontSize = 15.sp)
                }
                else -> FileList(
                    result = data!!,
                    onOpenFolder = { folderPath -> path = folderPath },
                    onPlay = onPlay,
                )
            }
        }
    }
}

@Composable
private fun FileList(
    result: BrowseResult,
    onOpenFolder: (String) -> Unit,
    onPlay: (Long) -> Unit,
) {
    val folders = result.folders
    val files = result.files
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(folders, key = { "f:${it.path}" }) { folder ->
            BrowseRow(
                badge = "DIR",
                title = folder.name,
                subtitle = "${folder.fileCount} 个文件",
                onClick = { onOpenFolder(folder.path) },
            )
        }
        items(files, key = { "m:${it.id}" }) { media ->
            BrowseRow(
                badge = "VID",
                title = media.name ?: media.title,
                subtitle = fileMeta(media),
                onClick = { onPlay(media.id) },
            )
        }
        if (folders.isEmpty() && files.isEmpty()) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 40.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "这个目录下没有媒体文件",
                        color = Color(0xFF6E6E74),
                        fontSize = 15.sp,
                    )
                }
            }
        }
    }
}

private fun fileMeta(media: Media): String {
    val episode = if (media.kind == "show" && media.season != null) {
        "S${media.season.toString().padStart(2, '0')}E${media.episode?.toString()?.padStart(2, '0')}"
    } else {
        media.container?.uppercase() ?: "VIDEO"
    }
    val size = media.size?.let { "${Math.round(it / 1024.0 / 1024.0)} MB" }
    val position = if (media.position != null) "继续" else null
    return listOfNotNull(episode, size, position).joinToString(" · ")
}

@Composable
private fun BrowseRow(
    badge: String,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val focused by interactionSource.collectIsFocusedAsState()
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 36.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (focused) Color(0x14FFFFFF) else Color.Transparent)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 18.dp, vertical = 14.dp),
    ) {
        Text(
            text = badge,
            color = if (badge == "DIR") Color(0xFFE4322D) else Color(0xFF8AB4F8),
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
        )
        Spacer(Modifier.width(18.dp))
        Text(
            text = title,
            color = Color.White,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(16.dp))
        Text(
            text = subtitle,
            color = Color(0xFF9A9AA0),
            fontSize = 13.sp,
        )
    }
}