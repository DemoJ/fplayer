package com.fplayer.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme as M3MaterialTheme
import androidx.compose.material3.darkColorScheme as m3DarkColorScheme
import androidx.compose.ui.graphics.Color
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.MaterialTheme as TvMaterialTheme
import androidx.tv.material3.darkColorScheme as tvDarkColorScheme
import com.fplayer.tv.ui.App

class MainActivity : ComponentActivity() {
    @OptIn(ExperimentalTvMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            // TV 端深色配色：背景 #0E0E10、主色品牌红 #E4322D。
            // 必须同时套用 compose material3 与 tv material3 两个 MaterialTheme：
            // - compose material3 驱动 OutlinedTextField 等组件的颜色
            // - tv material3 驱动 Tab/TabRow/Button 等 TV 组件的颜色
            // 否则 Tab 文字会回退到浅色主题的深色字，在深色背景上几乎不可见。
            val bg = Color(0xFF0E0E10)
            val surface = Color(0xFF1E1E22)
            val accent = Color(0xFFE4322D)
            TvMaterialTheme(
                colorScheme = tvDarkColorScheme(
                    primary = accent,
                    onPrimary = Color.White,
                    background = bg,
                    onBackground = Color.White,
                    surface = surface,
                    onSurface = Color.White,
                    secondary = accent,
                ),
            ) {
                M3MaterialTheme(
                    colorScheme = m3DarkColorScheme(
                        primary = accent,
                        onPrimary = Color.White,
                        background = bg,
                        onBackground = Color.White,
                        surface = surface,
                        onSurface = Color.White,
                        secondary = accent,
                    ),
                ) {
                    App()
                }
            }
        }
    }
}