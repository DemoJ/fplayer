package com.fplayer.tv.data

import org.json.JSONObject
import retrofit2.HttpException

/**
 * 把请求异常转成可读的中文提示：
 * - 优先解析服务端 JSON body 里的 error 字段（如登录 401 的"用户名或密码错误"）
 * - 无 body 时按状态码给出通用提示
 * - 网络类异常透传原始 message
 */
fun Throwable.friendlyMessage(): String {
    if (this is HttpException) {
        val body = response()?.errorBody()?.string()
        if (!body.isNullOrBlank()) {
            runCatching {
                val obj = JSONObject(body)
                val error = obj.optString("error")
                if (error.isNotBlank()) return error
            }
        }
        return when (code()) {
            401 -> "用户名或密码错误"
            403 -> "没有权限执行此操作"
            404 -> "资源不存在"
            429 -> "请求过于频繁，请稍后重试"
            502 -> "服务暂时不可用"
            else -> "请求失败（HTTP ${code()}）"
        }
    }
    return message ?: "网络请求失败"
}