package com.fplayer.tv.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.core.Session
import com.fplayer.tv.data.LoginBody
import com.fplayer.tv.data.friendlyMessage
import kotlinx.coroutines.launch

/**
 * 首次进入配置页：服务器地址 → 测试连接 → 账号密码 → 登录。
 * 服务器未初始化（无管理员账户）时提示前往网页端创建。
 */
@Composable
fun AuthScreen(onLoggedIn: (Session) -> Unit) {
    val apiClient = AppContainer.apiClient
    val scope = rememberCoroutineScope()

    var baseUrl by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var serverInitialized by remember { mutableStateOf<Boolean?>(null) }

    // TV 遥控器焦点：进入页面自动聚焦地址框；输入完成通过 IME Done 或方向键逐级流转。
    val serverFocus = remember { FocusRequester() }
    val usernameFocus = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }
    val loginButtonFocus = remember { FocusRequester() }
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { serverFocus.requestFocus() }

    // 错误信息以轻提示（Snackbar）显示，不占布局空间。
    LaunchedEffect(error) {
        if (error.isNotBlank()) {
            snackbarHostState.showSnackbar(error)
            error = ""
        }
    }

    /** 全角字符转半角（中文输入法常见：：／／ＡＢＣ → ://ABC）。 */
    fun toHalfWidth(input: String): String {
        val sb = StringBuilder(input.length)
        for (ch in input) {
            when {
                ch == '：' -> sb.append(':')
                ch == '／' -> sb.append('/')
                ch == '．' -> sb.append('.')
                ch.code in 0xFF01..0xFF5E -> sb.append((ch.code - 0xFEE0).toChar())
                ch.code == 0x3000 -> sb.append(' ')
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    fun normalizeUrl(input: String): String {
        val trimmed = toHalfWidth(input).trim()
        return if (trimmed.contains("://")) trimmed else "http://$trimmed"
    }

    /** 地址必须含主机名才可用于连接，避免携带非法 URL 发起网络请求。 */
    fun isValidServerUrl(input: String): Boolean {
        val url = normalizeUrl(input)
        return runCatching {
            val parsed = java.net.URI(url)
            parsed.scheme != null && parsed.host != null
        }.getOrDefault(false)
    }

    fun testServer() {
        val url = normalizeUrl(baseUrl)
        android.util.Log.d("FPlayerAuth", "testServer input=[$baseUrl] normalized=[$url]")
        if (url.isBlank()) { error = "请输入服务器地址"; return }
        if (!isValidServerUrl(url)) { error = "服务器地址无效，请填写完整的地址，例如 http://192.168.1.100:3000"; return }
        error = ""
        busy = true
        scope.launch {
            val result = runCatching {
                apiClient.updateSession(Session(url, token = "", username = ""))
                apiClient.api.setupStatus()
            }
            result.onSuccess { res ->
                serverInitialized = res.initialized
                baseUrl = url
                if (!res.initialized) {
                    error = "服务器尚未初始化：请先在网页端创建管理员账户"
                } else {
                    // 连接成功后自动聚焦到用户名输入框。
                    usernameFocus.requestFocus()
                }
            }.onFailure { e ->
                serverInitialized = null
                error = "连接失败：${e.friendlyMessage()}"
            }
            busy = false
        }
    }

    fun login() {
        if (username.isBlank() || password.isBlank()) { error = "请输入用户名和密码"; return }
        if (!isValidServerUrl(baseUrl)) { error = "服务器地址无效，请返回重新填写"; return }
        error = ""
        busy = true
        scope.launch {
            val result = runCatching {
                apiClient.updateSession(Session(normalizeUrl(baseUrl), token = "", username = ""))
                val res = apiClient.api.login(LoginBody(username.trim(), password))
                Session(normalizeUrl(baseUrl), token = res.token, username = res.user.username)
            }
            result.onSuccess { s -> onLoggedIn(s) }
                .onFailure { e -> error = "登录失败：${e.friendlyMessage()}" }
            busy = false
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.width(640.dp).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "FPLAYER",
                color = Color(0xFFE4322D),
                fontSize = 40.sp,
                fontWeight = FontWeight.Black,
                letterSpacing = 10.sp,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "连接你的私人放映室",
                color = Color(0xFF9A9AA0),
                fontSize = 18.sp,
            )
            Spacer(Modifier.height(40.dp))

            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it; serverInitialized = null },
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(serverFocus)
                    .onPreviewKeyEvent { e ->
                        if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionDown) {
                            testServer(); true
                        } else false
                    },
                label = { Text("服务器地址") },
                placeholder = { Text("http://NAS-IP:3000") },
                singleLine = true,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { testServer() }),
            )
            Spacer(Modifier.height(16.dp))

            Button(
                onClick = { testServer() },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (busy) "连接中..." else "连接服务器")
            }

            if (serverInitialized == true) {
                Spacer(Modifier.height(24.dp))
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(usernameFocus)
                        .onPreviewKeyEvent { e ->
                            if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionDown) {
                                passwordFocus.requestFocus(); true
                            } else false
                        },
                    label = { Text("用户名") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(passwordFocus)
                        .onPreviewKeyEvent { e ->
                            if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionDown) {
                                loginButtonFocus.requestFocus(); true
                            } else false
                        },
                    label = { Text("密码") },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { login() }),
                )
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = { login() },
                    enabled = !busy && serverInitialized == true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(loginButtonFocus),
                ) {
                    Text(if (busy) "登录中..." else "登录")
                }
            }
        }
        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}