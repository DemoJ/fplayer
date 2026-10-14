package com.fplayer.tv.core

import android.content.Context
import com.fplayer.tv.data.ApiClient

/**
 * 进程级单例容器：网络客户端与本地存储由各页面共享。
 * 在 Activity 启动时初始化，持有 Activity context 的引用以访问 DataStore。
 */
object AppContainer {
    lateinit var store: SettingsStore
    val apiClient = ApiClient()
    val sessions: SessionController by lazy {
        SessionController(
            store = store,
            verifySession = { apiClient.api.me(it) },
            logoutSession = { apiClient.api.logout(it) },
            updateSession = apiClient::updateSession,
        )
    }

    fun init(context: Context) {
        if (!::store.isInitialized) {
            store = SettingsStore(context.applicationContext)
        }
    }
}