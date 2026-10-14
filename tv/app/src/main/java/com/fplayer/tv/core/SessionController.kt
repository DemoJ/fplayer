package com.fplayer.tv.core

import com.google.gson.JsonParseException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException
import java.io.IOException

data class Session(
    val baseUrl: String,
    val token: String,
    val username: String,
)

interface SessionStore {
    suspend fun loadSession(): Session?
    suspend fun saveSession(session: Session)
    suspend fun clearSession()
}

sealed interface SessionState {
    data object Loading : SessionState
    data object SignedOut : SessionState
    data class Checking(val session: Session) : SessionState
    data class Ready(val session: Session) : SessionState
    data class ConnectionFailed(val session: Session?, val message: String) : SessionState
}

/** 会话写入串行执行；网络请求在锁外执行，结果只允许作用于发起时的会话代次。 */
class SessionController(
    private val store: SessionStore,
    private val verifySession: suspend (Session) -> Unit,
    private val logoutSession: suspend (Session) -> Unit,
    private val updateSession: (Session?) -> Unit,
) {
    private val mutex = Mutex()
    private val mutableState = MutableStateFlow<SessionState>(SessionState.Loading)
    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    private var initialized = false
    private var session: Session? = null
    private var revision = 0L

    /** 启动或重试。Activity 重建时可重新发起尚未完成的校验，旧结果会被忽略。 */
    suspend fun restore() {
        val request = mutex.withLock {
            if (!initialized) {
                mutableState.value = SessionState.Loading
                try {
                    session = store.loadSession()
                    updateSession(session)
                    initialized = true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    mutableState.value = SessionState.ConnectionFailed(null, "无法读取登录信息，请重试。")
                    return@withLock null
                }
                if (session == null) mutableState.value = SessionState.SignedOut
            }
            when (mutableState.value) {
                is SessionState.Ready, SessionState.SignedOut -> null
                else -> session?.let {
                    mutableState.value = SessionState.Checking(it)
                    CheckRequest(it, ++revision)
                }
            }
        } ?: return

        val failure = try {
            verifySession(request.session)
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            e
        }
        // 不把取消（包括不配合取消的旧请求）当作网络故障或登录失效。
        currentCoroutineContext().ensureActive()
        mutex.withLock {
            if (revision != request.revision || session != request.session) return@withLock
            when {
                failure == null -> mutableState.value = SessionState.Ready(request.session)
                failure is HttpException && failure.code() == 401 -> {
                    try {
                        store.clearSession()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        mutableState.value = SessionState.ConnectionFailed(request.session, "无法更新登录信息，请重试。")
                        return@withLock
                    }
                    revision++
                    session = null
                    updateSession(null)
                    mutableState.value = SessionState.SignedOut
                }
                else -> mutableState.value = SessionState.ConnectionFailed(request.session, failure.connectionMessage())
            }
        }
    }

    suspend fun login(newSession: Session) {
        mutex.withLock {
            store.saveSession(newSession)
            revision++
            initialized = true
            session = newSession
            updateSession(newSession)
            mutableState.value = SessionState.Ready(newSession)
        }
    }

    suspend fun logout() {
        val previous = mutex.withLock {
            val current = session ?: return@withLock null
            // 先完成本地退出，再开放登录页；旧 logout 的网络响应不能再清除新会话。
            store.clearSession()
            revision++
            session = null
            updateSession(null)
            mutableState.value = SessionState.SignedOut
            current
        } ?: return
        try {
            logoutSession(previous)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // 用户主动退出不依赖服务器是否可达，本地凭证已清除。
        }
    }

    private data class CheckRequest(val session: Session, val revision: Long)
}

private fun Exception.connectionMessage(): String = when (this) {
    is HttpException -> "服务器暂时无法完成验证（HTTP ${code()}），请稍后重试。"
    is JsonParseException -> "服务器响应异常，请稍后重试。"
    is IOException -> "无法连接服务器，请检查网络或服务器状态后重试。"
    else -> "暂时无法验证登录状态，请稍后重试。"
}
