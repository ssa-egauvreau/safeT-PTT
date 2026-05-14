package com.securityradio.ptt.data.remote

import com.google.gson.annotations.SerializedName
import retrofit2.http.GET

interface ChannelsApi {
    @GET("v1/channels")
    suspend fun channels(): ChannelsResponseDto
}

data class ChannelsResponseDto(
    @SerializedName("channels") val channels: List<ChannelDto>,
)

data class ChannelDto(
    @SerializedName("id") val id: Int,
    @SerializedName("name") val name: String,
)
