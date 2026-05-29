package com.securityradio.ptt.data.remote

import com.google.gson.annotations.SerializedName
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

/** Handset-facing endpoints: GPS reporting and emergency / page alerts. */
interface RadioApi {
    @POST("/v1/radio/location")
    suspend fun reportLocation(@Body body: LocationReportDto): RadioOkDto

    /** Recent recorded transmissions with Whisper transcripts (message history). */
    @GET("/v1/radio/transmissions")
    suspend fun recentTransmissions(
        @Query("limit") limit: Int = 40,
    ): RadioTransmissionsResponseDto

    @GET("/v1/radio/inbox")
    suspend fun inbox(
        @Query("unit") unit: String,
        @Query("channel") channel: String?,
        @Query("since") since: Long,
    ): InboxResponseDto

    @POST("/v1/radio/emergency")
    suspend fun emergency(@Body body: EmergencyDto): RadioOkDto

    /** Live profile read — picks up display-name and unit-id changes made on the portal. */
    @GET("/v1/auth/me")
    suspend fun me(): MeResponseDto

    /**
     * Agency-wide audio config set by an admin in the Audio Lab.
     * Returns [AudioConfigResponseDto] with a null [AudioConfigResponseDto.config] when
     * no global config has been pushed yet.
     */
    @GET("/v1/audio/config")
    suspend fun audioConfig(): AudioConfigResponseDto
}

/** Wrapper returned by /v1/audio/config. */
data class AudioConfigResponseDto(
    @SerializedName("config") val config: AudioConfigDto? = null,
    @SerializedName("updatedAt") val updatedAt: String? = null,
)

/**
 * Device-oriented audio config derived from the admin's AudioLabConfig.
 *
 *  agcEnabled      → enable Android AutomaticGainControl and software gain
 *  noiseSuppression→ enable Android NoiseSuppressor
 *  gainMultiplier  → software gain (0.5 – 3.0); only effective when agcEnabled
 */
data class AudioConfigDto(
    @SerializedName("agcEnabled") val agcEnabled: Boolean = false,
    @SerializedName("noiseSuppression") val noiseSuppression: Boolean = false,
    @SerializedName("gainMultiplier") val gainMultiplier: Float = 1.0f,
    /** When true: disable Android's hardware NoiseSuppressor / AGC and skip the
     *  TX conditioner's expander + makeup AGC. Matches the radio-bridge mic
     *  chain so handset audio sounds like bridge audio on the same channel. */
    @SerializedName("bypassMicProcessing") val bypassMicProcessing: Boolean = false,
    /** RX-side post-decode chain (presence bell / saturation / shelves /
     *  upsample mode). `null` when no shaping is in effect — handset uses the
     *  legacy duplicate 8 → 16 kHz upsample with no biquads. */
    @SerializedName("postDecode") val postDecode: AudioPostDecodeDto? = null,
)

/** Subset of `AudioLabConfig.postDecode` the handset applies on RX. Mirrors
 *  the server-side `DevicePostDecodeConfig` and the web's
 *  `AudioConfigPostDecode` so one tuned admin preset is identically applied
 *  across all three clients. */
data class AudioPostDecodeDto(
    @SerializedName("upsampleMode") val upsampleMode: String = "duplicate",
    @SerializedName("hpfEnabled") val hpfEnabled: Boolean? = null,
    @SerializedName("hpfHz") val hpfHz: Float? = null,
    @SerializedName("lpfEnabled") val lpfEnabled: Boolean? = null,
    @SerializedName("lpfHz") val lpfHz: Float? = null,
    @SerializedName("lowShelfEnabled") val lowShelfEnabled: Boolean? = null,
    @SerializedName("lowShelfHz") val lowShelfHz: Float? = null,
    @SerializedName("lowShelfDb") val lowShelfDb: Float? = null,
    @SerializedName("highShelfEnabled") val highShelfEnabled: Boolean? = null,
    @SerializedName("highShelfHz") val highShelfHz: Float? = null,
    @SerializedName("highShelfDb") val highShelfDb: Float? = null,
    @SerializedName("presenceEnabled") val presenceEnabled: Boolean? = null,
    @SerializedName("presenceHz") val presenceHz: Float? = null,
    @SerializedName("presenceDb") val presenceDb: Float? = null,
    @SerializedName("presenceQ") val presenceQ: Float? = null,
    @SerializedName("saturationAmount") val saturationAmount: Float? = null,
    /** Run the chain on the Opus (16 kHz) path too. Shapes nothing on its own. */
    @SerializedName("wideband") val wideband: Boolean? = null,
    /** Feed-forward compressor, after the biquads and before saturation. */
    @SerializedName("compressorEnabled") val compressorEnabled: Boolean? = null,
    @SerializedName("compressorThresholdDb") val compressorThresholdDb: Float? = null,
    @SerializedName("compressorRatio") val compressorRatio: Float? = null,
    @SerializedName("compressorAttackMs") val compressorAttackMs: Float? = null,
    @SerializedName("compressorReleaseMs") val compressorReleaseMs: Float? = null,
    @SerializedName("compressorMakeupDb") val compressorMakeupDb: Float? = null,
    /** End-of-transmission cue, synthesized locally on `air_released`. */
    @SerializedName("rogerBeepEnabled") val rogerBeepEnabled: Boolean? = null,
    @SerializedName("rogerBeepHz") val rogerBeepHz: Float? = null,
    @SerializedName("rogerBeepMs") val rogerBeepMs: Float? = null,
    @SerializedName("squelchTailEnabled") val squelchTailEnabled: Boolean? = null,
    @SerializedName("squelchTailMs") val squelchTailMs: Float? = null,
    @SerializedName("squelchTailLevel") val squelchTailLevel: Float? = null,
)

data class LocationReportDto(
    @SerializedName("unit_id") val unitId: String,
    @SerializedName("lat") val lat: Double,
    @SerializedName("lon") val lon: Double,
    @SerializedName("channel") val channel: String? = null,
    @SerializedName("display_name") val displayName: String? = null,
    @SerializedName("accuracy_m") val accuracyM: Double? = null,
    @SerializedName("heading") val heading: Double? = null,
    @SerializedName("speed_mps") val speedMps: Double? = null,
)

data class EmergencyDto(
    @SerializedName("unit_id") val unitId: String,
    @SerializedName("channel") val channel: String? = null,
    @SerializedName("display_name") val displayName: String? = null,
    @SerializedName("message") val message: String? = null,
    @SerializedName("active") val active: Boolean = true,
)

data class RadioOkDto(
    @SerializedName("ok") val ok: Boolean = false,
)

data class InboxResponseDto(
    @SerializedName("alerts") val alerts: List<InboxAlertDto> = emptyList(),
    @SerializedName("lastId") val lastId: Long = 0,
    /** Channel names a dispatcher has flagged 10-33. */
    @SerializedName("ten33") val ten33: List<String> = emptyList(),
)

data class RadioTransmissionsResponseDto(
    @SerializedName("transmissions") val transmissions: List<RadioTransmissionDto> = emptyList(),
)

data class RadioTransmissionDto(
    @SerializedName("id") val id: Int = 0,
    @SerializedName("channel_name") val channelName: String = "",
    @SerializedName("started_at") val startedAt: String = "",
    @SerializedName("duration_ms") val durationMs: Long = 0,
    @SerializedName("transcript") val transcript: String? = null,
    @SerializedName("transcript_status") val transcriptStatus: String = "",
    @SerializedName("unit_id") val unitId: String? = null,
    @SerializedName("display_name") val displayName: String? = null,
)

data class InboxAlertDto(
    @SerializedName("id") val id: Long = 0,
    @SerializedName("kind") val kind: String = "",
    @SerializedName("channel_name") val channelName: String? = null,
    @SerializedName("from_unit") val fromUnit: String? = null,
    @SerializedName("from_name") val fromName: String? = null,
    @SerializedName("message") val message: String? = null,
    @SerializedName("active") val active: Boolean = true,
)
