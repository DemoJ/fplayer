package com.fplayer.tv.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import com.fplayer.tv.core.AppContainer

/**
 * 服务端海报加载：URL 由 ApiClient 拼接（带 Bearer），
 * 加载中 / 失败 / 无路径时显示品牌占位。
 */
@Composable
fun PosterImage(
    path: String?,
    modifier: Modifier = Modifier,
    fallbackText: String? = null,
) {
    val context = LocalContext.current
    val url = AppContainer.apiClient.mediaUrl(path)
    if (url == null) {
        PosterPlaceholder(modifier, fallbackText)
        return
    }
    SubcomposeAsyncImage(
        model = ImageRequest.Builder(context).data(url).build(),
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = modifier,
        loading = { PosterPlaceholder(Modifier.fillMaxSize(), fallbackText) },
        error = { PosterPlaceholder(Modifier.fillMaxSize(), fallbackText) },
    )
}

@Composable
private fun PosterPlaceholder(modifier: Modifier, text: String?) {
    Box(
        modifier = modifier.background(Color(0xFF1E1E22)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text?.take(1) ?: "F",
            color = Color(0xFF4A4A50),
            fontSize = 40.sp,
            fontWeight = FontWeight.Black,
        )
    }
}