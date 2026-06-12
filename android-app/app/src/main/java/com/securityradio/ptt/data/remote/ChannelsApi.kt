package com.securityradio.ptt.data.remote

import com.google.gson.annotations.SerializedName
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

interface ChannelsApi {
    /**
     * Channels this signed-in user is allowed on, with per-channel talk permission.
     * Calls /v1/me/channels so the radio sees the same talk-priority / talk /
     * listen-only assignments dispatch sets on the portal.
     */
    @GET("/v1/me/channels")
    suspend fun channels(): ChannelsResponseDto

    @GET("/v1/air")
    suspend fun airState(@Query("channel") channel: String? = null): AirStateDto

    /** Live talker hints: home channel plus optional comma-separated scan channel names. */
    @GET("/v1/talk-activity")
    suspend fun talkActivity(
        @Query("home") home: String? = null,
        @Query("scan") scan: String? = null,
    ): TalkActivityDto

    /** Register this handset on its tuned channel so the server can approximate channel population. */
    @POST("/v1/presence/heartbeat")
    suspend fun presenceHeartbeat(@Body body: PresenceHeartbeatDto): PresenceHeartbeatResponseDto

    /** Returns how many unique unit identifiers have heartbeated onto this channel lately. */
    @GET("/v1/presence/count")
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
    @SerializedName("id") val id: Int = 0,
    @SerializedName("name") val name: String,
    /** Server permission string: "talk_priority" / "talk" / "listen_only". */
    @SerializedName("permission") val permission: String? = null,
    /** Zone label from the portal (safeT Control → Channels); null/blank = ungrouped. */
    @SerializedName("zone") val zone: String? = null,
    /** Zone bank number; shown in front of the channel name on the display ("1 GREEN 1"). */
    @SerializedName("zone_number") val zoneNumber: Int? = null,
)

data class AirStateDto(
    @SerializedName("occupied") val occupied: Boolean,
    /** Non-null while live PCM keyed on this channel (same TTL as relay “on air”). */
    @SerializedName("transmitting_unit_id") val transmittingUnitId: String? = null,
    @SerializedName("transmitting_display_name") val transmittingDisplayName: String? = null,
    /** When true, keyed traffic is from a yielding bridge/AI — local PTT is not blocked. */
    @SerializedName("transmitting_yields") val transmittingYields: Boolean = false,
)
