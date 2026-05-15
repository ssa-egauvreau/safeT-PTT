package com.securityradio.ptt.domain

enum class ChannelCatalogOrigin {
    NETWORK,
    LOCAL_FALLBACK,
}

data class RadioChannelCatalog(
    val channels: List<String>,
    val origin: ChannelCatalogOrigin,
    val errorMessage: String?,
)
