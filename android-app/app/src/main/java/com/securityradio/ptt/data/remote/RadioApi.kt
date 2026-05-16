package com.securityradio.ptt.data.remote

import com.google.gson.annotations.SerializedName
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

/** Handset-facing endpoints: GPS reporting and emergency / page alerts. */
interface RadioApi {
    @POST("v1/radio/location")
    suspend fun reportLocation(@Body body: LocationReportDto): RadioOkDto

    @GET("v1/radio/inbox")
    suspend fun inbox(
        @Query("unit") unit: String,
        @Query("channel") channel: String?,
        @Query("since") since: Long,
    ): InboxResponseDto

    @POST("v1/radio/emergency")
    suspend fun emergency(@Body body: EmergencyDto): RadioOkDto
}

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
