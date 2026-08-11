package com.fplayer.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.core.Session
import com.fplayer.tv.ui.auth.AuthScreen
import com.fplayer.tv.ui.main.MainScreen
import kotlinx.coroutines.launch

@Composable
fun App() {
    AppContainer.init(LocalContext.current)
    val store = AppContainer.store
    val apiClient = AppContainer.apiClient

    var booting by remember { mutableStateOf(true) }
    var session by remember { mutableStateOf<Session?>(null) }
    val scope = rememberCoroutineScope()

    // 启动时自动登录：读取本地会话并向后端验证 token，失效则清除。
    LaunchedEffect(Unit) {
        val saved = store.loadSession()
        if (saved != null) {
            apiClient.updateSession(saved)
            val valid = runCatching { apiClient.api.me() }.isSuccess
            if (valid) {
                session = saved
            } else {
                store.clearSession()
                apiClient.updateSession(null)
            }
        }
        booting = false
    }

    if (booting) {
        Splash()
    } else if (session == null) {
        AuthScreen(
            onLoggedIn = { s ->
                scope.launch { store.saveSession(s) }
                apiClient.updateSession(s)
                session = s
            },
        )
    } else {
        MainScreen(
            session = session!!,
            onLogout = {
                scope.launch {
                    runCatching { if (session != null) AppContainer.apiClient.api.logout() }
                    store.clearSession()
                }
                apiClient.updateSession(null)
                session = null
            },
        )
    }
}

@Composable
private fun Splash() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "F",
                color = Color(0xFFE4322D),
                fontSize = 72.sp,
                fontWeight = FontWeight.Black,
            )
            Text(
                text = "FPLAYER",
                color = Color.White,
                fontSize = 20.sp,
                letterSpacing = 8.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}