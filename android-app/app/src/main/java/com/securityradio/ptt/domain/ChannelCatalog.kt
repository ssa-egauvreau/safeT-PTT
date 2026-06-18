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

/** A numbered channel bank from the portal; [number] prefixes the channel name on the display. */
data class ChannelZone(val name: String, val number: Int? = null)

data class RadioChannelCatalog(
    val channels: List<String>,
    /** Lookup by lowercased channel name; missing entries default to [ChannelPermission.TALK]. */
    val permissions: Map<String, ChannelPermission>,
    /** Zone by lowercased channel name; channels missing here fall into the default zone. */
    val zones: Map<String, ChannelZone> = emptyMap(),
    /** Lowercased names of channels with the AI dispatcher enabled (radios show an AI badge). */
    val aiDispatch: Set<String> = emptySet(),
    val origin: ChannelCatalogOrigin,
    val errorMessage: String?,
)
