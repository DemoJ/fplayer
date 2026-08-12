package com.fplayer.tv.data

import com.google.gson.annotations.SerializedName

data class User(
    val id: Long,
    val username: String,
    val role: String,
)

data class LoginResponse(
    val token: String,
    val user: User,
)

data class MeResponse(
    val user: User,
)

data class SetupResponse(
    val initialized: Boolean,
    @SerializedName("setupExpired") val setupExpired: Boolean,
)

data class Media(
    val id: Long,
    val title: String,
    val kind: String,
    val season: Int? = null,
    val episode: Int? = null,
    val duration: Double? = null,
    val size: Long? = null,
    val container: String? = null,
    @SerializedName("video_codec") val videoCodec: String? = null,
    @SerializedName("audio_codec") val audioCodec: String? = null,
    val path: String,
    val name: String? = null,
    val position: Double? = null,
    @SerializedName("progress_duration") val progressDuration: Double? = null,
    val completed: Int? = null,
    @SerializedName("source_name") val sourceName: String? = null,
    @SerializedName("source_type") val sourceType: String? = null,
    @SerializedName("work_id") val workId: Long? = null,
    @SerializedName("work_poster") val workPoster: String? = null,
)

data class Work(
    val id: Long,
    val title: String,
    @SerializedName("original_title") val originalTitle: String? = null,
    val kind: String,
    val year: Int? = null,
    val overview: String? = null,
    @SerializedName("poster_path") val posterPath: String? = null,
    @SerializedName("backdrop_path") val backdropPath: String? = null,
    @SerializedName("file_count") val fileCount: Int,
    @SerializedName("season_count") val seasonCount: Int,
)

data class WorksResponse(
    val items: List<Work>,
    val total: Int,
)

data class WorkDetailResponse(
    val work: Work,
    val media: List<Media>,
)

data class UpNext(
    val id: Long,
    val title: String,
    val kind: String,
    val season: Int,
    val episode: Int,
    val duration: Double? = null,
    val size: Long? = null,
    val container: String? = null,
    @SerializedName("work_id") val workId: Long,
    @SerializedName("work_title") val workTitle: String,
    @SerializedName("work_poster") val workPoster: String? = null,
    @SerializedName("source_name") val sourceName: String? = null,
    @SerializedName("from_season") val fromSeason: Int,
    @SerializedName("from_episode") val fromEpisode: Int,
)

data class Source(
    val id: Long,
    val name: String,
    val type: String,
    @SerializedName("base_path") val basePath: String,
    @SerializedName("file_count") val fileCount: Int? = null,
)

data class BrowseFolder(
    val name: String,
    val path: String,
    @SerializedName("file_count") val fileCount: Int,
)

data class Crumb(
    val name: String,
    val path: String,
)

data class BrowseResult(
    val level: String,
    val path: String,
    val crumbs: List<Crumb> = emptyList(),
    val source: Source? = null,
    val sources: List<Source> = emptyList(),
    val folders: List<BrowseFolder> = emptyList(),
    val files: List<Media> = emptyList(),
)

data class ProbeResponse(
    val media: Media,
)

data class TranscodeRequest(
    val start: Double,
    val quality: String,
    val mode: String,
)

data class TranscodeResponse(
    val playlist: String,
    val session: String? = null,
    val cached: Boolean = false,
    val start: Double? = null,
    @SerializedName("coveredUntil") val coveredUntil: Double? = null,
)

data class ProgressRequest(
    val position: Double,
    val duration: Double,
    val completed: Boolean,
)

data class OkResponse(
    val ok: Boolean = false,
)