package com.fplayer.tv.data

import android.util.Log
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.fplayer.tv.core.Session
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * 服务端地址在登录后才确定，Retrofit 使用占位 baseUrl，
 * 实际主机/端口由 [UrlRewriteInterceptor] 按当前会话实时替换。
 * Bearer token 由 [AuthHeaderInterceptor] 统一注入。
 */
class ApiClient {

    @Volatile
    private var session: Session? = null

    fun updateSession(session: Session?) {
        this.session = session
    }

    fun bearerToken(): String? = session?.token

    fun currentBaseUrl(): String? = session?.baseUrl

    /** 公开给 Coil 等组件复用：同一 OkHttp 客户端，自动注入 Bearer 并重写为真实服务端地址。 */
    val httpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(AuthHeaderInterceptor())
            .addInterceptor(UrlRewriteInterceptor())
            .build()
    }

    private val retrofit: Retrofit by lazy {
        val gson: Gson = GsonBuilder().create()
        Retrofit.Builder()
            .baseUrl(BASE_PLACEHOLDER)
            .client(httpClient)
            .addConverterFactory(GsonConverterFactory.create(gson))
            .build()
    }

    val api: ApiService by lazy { retrofit.create(ApiService::class.java) }

    /** 将服务端相对路径（如 /api/posters/x.jpg）拼成可请求的完整 URL；无会话时返回 null。 */
    fun mediaUrl(path: String?): String? {
        val base = session?.baseUrl ?: return null
        if (path.isNullOrBlank()) return null
        return if (path.startsWith("http")) path else base.trimEnd('/') + "/" + path.trimStart('/')
    }

    private inner class AuthHeaderInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val token = session?.token
            if (token.isNullOrEmpty()) return chain.proceed(chain.request())
            val request = chain.request().newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
            return chain.proceed(request)
        }
    }

    private inner class UrlRewriteInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val baseUrl = session?.baseUrl
            val request = chain.request()
            if (baseUrl.isNullOrEmpty()) return chain.proceed(request)
            var rewrittenUrl: String? = null
            val original = request.url
            try {
                val parsed = URI(baseUrl)
                if (parsed.scheme != null && parsed.host != null) {
                    val defaultPort = if (parsed.scheme == "https") 443 else 80
                    rewrittenUrl = original.newBuilder()
                        .scheme(parsed.scheme!!)
                        .host(parsed.host!!)
                        .port(if (parsed.port > 0) parsed.port else defaultPort)
                        .build()
                        .toString()
                }
            } catch (e: Exception) {
                Log.w(TAG, "url rewrite failed base=$baseUrl err=${e.message}")
            }
            if (rewrittenUrl == null) {
                // 只抛网络类异常：OkHttp 拦截器抛其他异常会杀死进程。
                throw java.io.IOException("服务器地址无效：$baseUrl")
            }
            return chain.proceed(request.newBuilder().url(rewrittenUrl).build())
        }
    }

    companion object {
        private const val BASE_PLACEHOLDER = "http://0.0.0.0/"
        private const val TAG = "FPlayerApi"
    }
}