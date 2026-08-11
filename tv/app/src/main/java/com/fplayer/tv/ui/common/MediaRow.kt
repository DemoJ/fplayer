package com.fplayer.tv.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 横排区块：行标题 + 数量 + 可遥控器横向滚动的卡片列表。
 */
@Composable
fun MediaRow(
    title: String,
    count: Int,
    modifier: Modifier = Modifier,
    content: @Composable (Int) -> Unit,
) {
    Column(modifier = modifier) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 36.dp, end = 36.dp),
        ) {
            Text(
                text = title,
                color = Color.White,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = "$count",
                color = Color(0xFF6E6E74),
                fontSize = 14.sp,
            )
        }
        Spacer(Modifier.height(8.dp))
        LazyRow(
            contentPadding = PaddingValues(horizontal = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (count == 0) {
                item {
                    Text(
                        text = "暂无内容",
                        color = Color(0xFF6E6E74),
                        fontSize = 15.sp,
                        modifier = Modifier.padding(horizontal = 8.dp),
                    )
                }
            } else {
                items(count) { index -> content(index) }
            }
        }
    }
}