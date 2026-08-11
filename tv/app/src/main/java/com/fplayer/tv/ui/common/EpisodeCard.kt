package com.fplayer.tv.ui.common

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fplayer.tv.data.Media

private fun pad(value: Int) = value.toString().padStart(2, '0')

/** 观看进度：position / 参考时长，无数据返回 null。 */
fun mediaProgress(media: Media): Float? {
    val position = media.position ?: return null
    val duration = media.progressDuration ?: media.duration ?: return null
    if (duration <= 0) return null
    return (position / duration).toFloat().coerceIn(0f, 1f)
}

/**
 * 单条媒体卡片（剧集/电影）：横向布局，海报 + 标签 + 标题 + 进度。
 * position > 5 时显示"继续观看"徽标与进度条。焦点时放大并显示高亮边框。
 */
@Composable
fun EpisodeCard(
    media: Media,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val focused by interactionSource.collectIsFocusedAsState()
    val scale by animateFloatAsState(
        targetValue = if (focused) 1.06f else 1f,
        animationSpec = tween(150),
        label = "episodeCardScale",
    )
    val inProgress = (media.position ?: 0.0) > 5.0 && media.completed != 1
    val progress = mediaProgress(media)

    Row(
        modifier = modifier
            .width(300.dp)
            .height(150.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF1E1E22))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
            .then(
                if (focused) {
                    Modifier.border(2.dp, Color(0xFFE4322D), RoundedCornerShape(12.dp))
                } else {
                    Modifier
                }
            )
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .width(100.dp)
                .fillMaxHeight(),
        ) {
            PosterImage(
                path = media.workPoster,
                modifier = Modifier.fillMaxSize(),
                fallbackText = media.title,
            )
            if (media.completed == 1) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color(0xFF2E7D32))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                ) {
                    Text("已看完", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            } else if (inProgress) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color(0xFFE4322D))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                ) {
                    Text("继续观看", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 12.dp, end = 14.dp),
        ) {
            if (media.season != null) {
                Text(
                    text = "S${pad(media.season)}E${pad(media.episode ?: 0)}",
                    color = Color(0xFFE4322D),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(4.dp))
            }
            Text(
                text = media.title,
                color = Color.White,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            val meta = listOfNotNull(
                media.container?.uppercase(),
                media.duration?.let { "${(it / 60).toInt()} 分钟" },
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(
                    text = meta,
                    color = Color(0xFF9A9AA0),
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (progress != null) {
                Spacer(Modifier.height(6.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(4.dp)
                        .background(Color(0x66FFFFFF)),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(progress)
                            .height(4.dp)
                            .background(Color(0xFFE4322D)),
                    )
                }
            }
        }
    }
}
