package com.securityradio.ptt.domain

enum class ChannelCatalogOrigin {
    NETWORK,
    LOCAL_FALLBACK,
}

/** What a user is allowed to do on a channel; matches the server's permission strings. */
enum class ChannelPermission {
    /** Can talk and pre-empt non-priority talkers. */
    TALK_PRIORITY,

    /** Normal: can talk, but never over an existing talker. */
    TALK,

    /** Receive only — the radio refuses local PTT and the server would reject anyway. */
    LISTEN_ONLY,

    ;

    companion object {
        /** Parses the server's "talk_priority" / "talk" / "listen_only" strings; defaults to [TALK]. */
        fun fromWire(value: String?): ChannelPermission = when (value?.trim()?.lowercase()) {
            "talk_priority" -> TALK_PRIORITY
            "listen_only" -> LISTEN_ONLY
            else -> TALK
        }
    }
}

data class RadioChannelCatalog(
    val channels: List<String>,
    /** Lookup by lowercased channel name; missing entries default to [ChannelPermission.TALK]. */
    val permissions: Map<String, ChannelPermission>,
    /** Zone label by lowercased channel name; channels missing here fall into the default zone. */
    val zones: Map<String, String> = emptyMap(),
    val origin: ChannelCatalogOrigin,
    val errorMessage: String?,
)
