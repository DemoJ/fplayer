package com.fplayer.tv.ui.player

import android.media.MediaCodecList
import androidx.media3.common.MimeTypes
import com.fplayer.tv.data.Media

enum class PlayMode { DIRECT, TRANSCODE }

/**
 * 播放策略，对齐网页端 playbackStrategy：
 * - 远程源（WebDAV）一律直接播放（ExoPlayer 自带 Range 请求，不触发服务端转码）
 * - 本地源按 codec/container + 设备解码能力决定
 * - codec 未知时由调用方先 probe 再决策
 */
object PlaybackStrategy {

    fun decide(media: Media): PlayMode {
        if (media.sourceType != null && media.sourceType != "local") return PlayMode.DIRECT
        val codec = media.videoCodec?.lowercase()
        val container = media.container?.lowercase()
        if (codec == null) return PlayMode.TRANSCODE
        val playableCodec = Regex("^(h264|avc1|vp8|vp9|av01|av1|theora|mp4v|hev1|hvc1|hevc|h265)").matches(codec)
        if (!playableCodec) return PlayMode.TRANSCODE
        val playableContainer = container == null || Regex("^(mp4|m4v|mov|webm|ogv|ogg)").matches(container)
        // 非标准容器（mkv 等）：ExoPlayer 的 Matroska demux 同样支持，仅依赖设备解码器。
        return if (deviceSupportsCodec(codec)) PlayMode.DIRECT else PlayMode.TRANSCODE
    }

    /** 本地源且 codec 未知时，播放前需要先探测。 */
    fun needsProbe(media: Media): Boolean =
        (media.sourceType == null || media.sourceType == "local") && media.videoCodec == null

    /** 设备是否有对应 MIME 的解码器（含软解）。 */
    fun deviceSupportsCodec(codecName: String?): Boolean {
        val mime = when (codecName?.lowercase()) {
            "h264", "avc1" -> MimeTypes.VIDEO_H264
            "hevc", "h265", "hev1", "hvc1" -> MimeTypes.VIDEO_H265
            "vp8" -> MimeTypes.VIDEO_VP8
            "vp9" -> MimeTypes.VIDEO_VP9
            "av1", "av01" -> MimeTypes.VIDEO_AV1
            else -> return true
        }
        return MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
            !info.isEncoder && info.supportedTypes.any { it.equals(mime, ignoreCase = true) }
        }
    }
}