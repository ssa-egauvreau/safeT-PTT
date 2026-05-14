package com.securityradio.ptt.domain

/**
 * Future hook for channel/talkgroup metadata from the backend. Not wired into the prototype ViewModel yet.
 */
interface ChannelRepository {
    suspend fun snapshot(): ChannelSnapshot
}

data class ChannelSnapshot(
    val channels: List<String>,
    val index: Int,
)
