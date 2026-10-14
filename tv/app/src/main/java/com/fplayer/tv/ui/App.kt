package com.fplayer.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.core.SessionState
import com.fplayer.tv.ui.auth.AuthScreen
import com.fplayer.tv.ui.main.MainScreen
import kotlinx.coroutines.launch

@Composable
fun App() {
    AppContainer.init(LocalContext.current)
    val sessions = AppContainer.sessions
    val state by sessions.state.collectAsState()
    val scope = rememberCoroutineScope()

    // 临时连接故障保留会话并提供重试，只有当前 /me 明确返回 401 才自动退出。
    LaunchedEffect(sessions) { sessions.restore() }

    when (val current = state) {
        SessionState.Loading, is SessionState.Checking -> Splash()
        SessionState.SignedOut -> AuthScreen(
            onLoggedIn = { scope.launch { sessions.login(it) } },
        )
        is SessionState.ConnectionFailed -> ConnectionFailure(
            state = current,
            onRetry = { scope.launch { sessions.restore() } },
        )
        is SessionState.Ready -> MainScreen(
            session = current.session,
            onLogout = { scope.launch { sessions.logout() } },
        )
    }
}

@Composable
private fun ConnectionFailure(state: SessionState.ConnectionFailed, onRetry: () -> Unit) {
    val retryFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { retryFocus.requestFocus() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(
                text = "FPLAYER",
                color = Color(0xFFE4322D),
                fontSize = 40.sp,
                fontWeight = FontWeight.Black,
                letterSpacing = 10.sp,
            )
            Text(text = "暂时无法连接", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(text = state.message, color = Color(0xFF9A9AA0), fontSize = 18.sp, textAlign = TextAlign.Center)
            if (state.session != null) {
                Text(text = "登录信息已保留，无需重新登录。", color = Color(0xFF9A9AA0), fontSize = 16.sp)
                Text(text = state.session.baseUrl, color = Color(0xFF9A9AA0), fontSize = 14.sp)
            }
            Button(onClick = onRetry, modifier = Modifier.focusRequester(retryFocus)) {
                Text("重试连接")
            }
        }
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
            Text(
                text = "正在连接服务器...",
                color = Color(0xFF9A9AA0),
                fontSize = 16.sp,
                modifier = Modifier.padding(top = 24.dp),
            )
        }
    }
}
