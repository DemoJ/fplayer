package com.fplayer.tv.ui.common

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fplayer.tv.data.Work

/**
 * 媒体库网格卡片：2:3 海报 + 标题 + 副标题，焦点放大 + 高亮边框。
 * 宽度自适应所在网格列。
 */
@Composable
fun WorkCard(
    work: Work,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val focused by interactionSource.collectIsFocusedAsState()
    val scale by animateFloatAsState(
        targetValue = if (focused) 1.07f else 1f,
        animationSpec = tween(150),
        label = "workCardScale",
    )
    val subtitle = if (work.kind == "show") {
        "共 ${work.seasonCount} 季"
    } else {
        work.year?.toString()
    }
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
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
                .fillMaxWidth()
                .aspectRatio(2f / 3f)
                .clip(RoundedCornerShape(10.dp)),
        ) {
            PosterImage(
                path = work.posterPath,
                modifier = Modifier.fillMaxSize(),
                fallbackText = work.title,
            )
        }
        Text(
            text = work.title,
            color = Color.White,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp, start = 2.dp, end = 2.dp),
        )
        if (subtitle != null) {
            Text(
                text = subtitle,
                color = Color(0xFF9A9AA0),
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 2.dp, end = 2.dp),
            )
        }
    }
}

/**
 * 网格容器：固定列数 + 遥控器纵向滚动。所有网格页共用。
 */
@Composable
fun WorkGrid(
    items: List<Work>,
    onItemClick: (Work) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: androidx.compose.foundation.layout.PaddingValues = androidx.compose.foundation.layout.PaddingValues(horizontal = 36.dp, vertical = 12.dp),
    firstItemFocusRequester: androidx.compose.ui.focus.FocusRequester? = null,
) {
    androidx.compose.foundation.lazy.grid.LazyVerticalGrid(
        columns = androidx.compose.foundation.lazy.grid.GridCells.Fixed(6),
        contentPadding = contentPadding,
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(16.dp),
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(20.dp),
        modifier = modifier,
    ) {
        items(count = items.size) { index ->
            val cardModifier = if (index == 0 && firstItemFocusRequester != null) {
                Modifier.focusRequester(firstItemFocusRequester)
            } else {
                Modifier
            }
            WorkCard(
                work = items[index],
                onClick = { onItemClick(items[index]) },
                modifier = cardModifier,
            )
        }
    }
}