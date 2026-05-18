package com.securityradio.ptt.data.remote

import com.google.gson.annotations.SerializedName

data class ApiErrorDto(
    @SerializedName("error") val error: String? = null,
)
