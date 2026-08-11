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

/**
 * 横排媒体卡片：2:3 海报 + 标题/副标题 + 可选观看进度条。
 * 遥控器焦点时轻微放大并显示高亮边框，突出当前选中项。
 */
@Composable
fun MediaCard(
    imagePath: String?,
    title: String,
    subtitle: String? = null,
    progress: Float? = null,
    fallbackText: String? = null,
    onClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val focused by interactionSource.collectIsFocusedAsState()
    val scale by animateFloatAsState(
        targetValue = if (focused) 1.07f else 1f,
        animationSpec = tween(150),
        label = "cardScale",
    )
    val cardWidth = 140.dp
    val cardHeight = 210.dp
    val clickableModifier = if (onClick != null) {
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
    } else {
        Modifier
    }
    Column(
        modifier = modifier
            .width(cardWidth)
            .then(clickableModifier)
            .then(
                if (focused) {
                    Modifier.border(2.dp, Color(0xFFE4322D), RoundedCornerShape(10.dp))
                } else {
                    Modifier
                }
            )
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            },
    ) {
        Box(
            modifier = Modifier
                .width(cardWidth)
                .height(cardHeight)
                .clip(RoundedCornerShape(10.dp)),
        ) {
            PosterImage(path = imagePath, modifier = Modifier.fillMaxSize(), fallbackText = fallbackText)
            if (progress != null) {
                val clamped = progress.coerceIn(0f, 1f)
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(4.dp)
                        .background(Color(0x66FFFFFF)),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(clamped)
                            .height(4.dp)
                            .background(Color(0xFFE4322D)),
                    )
                }
            }
        }
        Text(
            text = title,
            color = Color.White,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 8.dp, start = 2.dp, end = 2.dp),
        )
        if (subtitle != null) {
            Text(
                text = subtitle,
                color = Color(0xFF9A9AA0),
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 2.dp, end = 2.dp),
            )
        }
    }
}