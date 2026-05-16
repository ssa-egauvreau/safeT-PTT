package com.securityradio.ptt.data.remote

import com.google.gson.annotations.SerializedName
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

interface ChannelsApi {
    @GET("v1/channels")
    suspend fun channels(): ChannelsResponseDto

    @GET("v1/air")
    suspend fun airState(@Query("channel") channel: String? = null): AirStateDto

    /** Optional telemetry for who is keyed on primary vs scan channels (mock via Railway env vars). */
    @GET("v1/talk-activity")
    suspend fun talkActivity(): TalkActivityDto

    /** Register this handset on its tuned channel so the server can approximate channel population. */
    @POST("v1/presence/heartbeat")
    suspend fun presenceHeartbeat(@Body body: PresenceHeartbeatDto): PresenceHeartbeatResponseDto

    /** Returns how many unique unit identifiers have heartbeated onto this channel lately. */
    @GET("v1/presence/count")
    suspend fun presenceCount(@Query("channel") channel: String): PresenceCountDto
}

data class PresenceHeartbeatDto(
    @SerializedName("unit_id") val unitId: String,
    @SerializedName("channel") val channel: String,
)

data class PresenceHeartbeatResponseDto(
    @SerializedName("ok") val ok: Boolean = true,
)

data class PresenceCountDto(
    @SerializedName("channel") val channel: String = "",
    @SerializedName("count") val count: Int = 0,
)

data class TalkActivityDto(
    @SerializedName("main") val main: TalkerSnapshotDto? = null,
    @SerializedName("scan") val scan: TalkerSnapshotDto? = null,
)

data class TalkerSnapshotDto(
    @SerializedName("channel") val channel: String = "",
    @SerializedName("active") val active: Boolean = false,
    @SerializedName("unit_id") val unitId: String? = null,
    @SerializedName("username") val username: String? = null,
)

data class ChannelsResponseDto(
    @SerializedName("channels") val channels: List<ChannelDto>,
)

data class ChannelDto(
    @SerializedName("id") val id: Int,
    @SerializedName("name") val name: String,
)

data class AirStateDto(
    @SerializedName("occupied") val occupied: Boolean,
    /** Non-null while live PCM keyed on this channel (same TTL as relay “on air”). */
    @SerializedName("transmitting_unit_id") val transmittingUnitId: String? = null,
)
