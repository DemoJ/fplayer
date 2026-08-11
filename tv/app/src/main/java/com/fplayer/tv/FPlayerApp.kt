package com.fplayer.tv

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.fplayer.tv.core.AppContainer

/**
 * 应用入口。实现 [ImageLoaderFactory] 让 Coil 复用 ApiClient 的
 * OkHttp 客户端：海报请求自动携带 Bearer token 并重写为真实服务端地址。
 */
class FPlayerApp : Application(), ImageLoaderFactory {

    override fun onCreate() {
        super.onCreate()
        AppContainer.init(this)
    }

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .okHttpClient(AppContainer.apiClient.httpClient)
            .crossfade(true)
            .build()
}