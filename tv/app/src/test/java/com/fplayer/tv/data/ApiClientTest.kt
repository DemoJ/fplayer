package com.fplayer.tv.data

import com.fplayer.tv.core.Session
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

class ApiClientTest {
    private val original = Session("http://original-server:3000", "original-token", "viewer")
    private val replacement = Session("https://new-server:4000", "replacement-token", "other")

    @Test
    fun meAndLogoutKeepTheirOriginalCredentialsWhenCurrentSessionChanges() = runBlocking {
        val client = ApiClient()
        client.updateSession(replacement)
        val requests = mutableListOf<Request>()
        val http = client.httpClient.newBuilder().addInterceptor { chain ->
            val request = chain.request()
            requests += request
            response(request, if (request.url.encodedPath == "/api/me") {
                """{"user":{"id":1,"username":"viewer","role":"admin"}}"""
            } else {
                """{"ok":true}"""
            })
        }.build()
        val api = Retrofit.Builder()
            .baseUrl("http://0.0.0.0/")
            .client(http)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)

        api.me(original)
        client.updateSession(null)
        api.logout(original)

        assertEquals(listOf("/api/me", "/api/logout"), requests.map { it.url.encodedPath })
        requests.forEach {
            assertEquals("original-server", it.url.host)
            assertEquals(3000, it.url.port)
            assertEquals("http", it.url.scheme)
            assertEquals("Bearer original-token", it.header("Authorization"))
            assertEquals(original, it.tag(Session::class.java))
        }
        assertEquals(null, client.bearerToken())
    }

    @Test
    fun ordinaryRequestsUseOneCurrentSessionSnapshot() {
        val client = ApiClient()
        client.updateSession(replacement)
        val http = client.httpClient.newBuilder().addInterceptor { chain ->
            val request = chain.request()
            assertEquals("new-server", request.url.host)
            assertEquals(4000, request.url.port)
            assertEquals("https", request.url.scheme)
            assertEquals("Bearer replacement-token", request.header("Authorization"))
            assertEquals(replacement, request.tag(Session::class.java))
            response(request, "{}")
        }.build()
        http.newCall(Request.Builder().url("http://0.0.0.0/api/recent").build()).execute().close()
    }

    private fun response(request: Request, body: String): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .body(body.toResponseBody("application/json".toMediaType()))
        .build()
}
