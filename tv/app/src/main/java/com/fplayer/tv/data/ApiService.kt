package com.fplayer.tv.data

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

interface ApiService {

    @POST("api/setup")
    suspend fun setup(@Body body: SetupBody): SetupResponse

    @GET("api/setup")
    suspend fun setupStatus(): SetupResponse

    @POST("api/login")
    suspend fun login(@Body body: LoginBody): LoginResponse

    @POST("api/logout")
    suspend fun logout(): OkResponse

    @GET("api/me")
    suspend fun me(): MeResponse

    @GET("api/continue")
    suspend fun continueWatching(@Query("limit") limit: Int = 12): List<Media>

    @GET("api/up-next")
    suspend fun upNext(@Query("limit") limit: Int = 10): List<UpNext>

    @GET("api/recent")
    suspend fun recent(@Query("limit") limit: Int = 10): List<Media>

    @GET("api/works")
    suspend fun works(
        @Query("kind") kind: String = "",
        @Query("q") q: String = "",
        @Query("limit") limit: Int = 200,
        @Query("offset") offset: Int = 0,
    ): WorksResponse

    @GET("api/browse")
    suspend fun browse(
        @Query("sourceId") sourceId: Long = 0,
        @Query("path") path: String = "",
    ): BrowseResult

    @GET("api/media")
    suspend fun searchMedia(
        @Query("q") q: String,
        @Query("kind") kind: String = "",
    ): List<Media>

    @GET("api/works/{id}")
    suspend fun workDetail(@Path("id") id: Long): WorkDetailResponse

    @GET("api/media/{id}")
    suspend fun media(@Path("id") id: Long): Media

    @POST("api/media/{id}/probe")
    suspend fun probe(@Path("id") id: Long): ProbeResponse

    @POST("api/media/{id}/transcode")
    suspend fun transcode(@Path("id") id: Long, @Body body: TranscodeRequest): TranscodeResponse

    @PUT("api/media/{id}/progress")
    suspend fun progress(@Path("id") id: Long, @Body body: ProgressRequest): OkResponse

    @DELETE("api/transcode/{session}")
    suspend fun stopTranscode(@Path("session") session: String): OkResponse

    @GET("api/transcode/{session}/keepalive")
    suspend fun keepalive(@Path("session") session: String): OkResponse
}

data class SetupBody(
    val username: String,
    val password: String,
)

data class LoginBody(
    val username: String,
    val password: String,
)