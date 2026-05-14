package com.securityradio.ptt.data

import com.securityradio.ptt.domain.ChannelRepository
import com.securityradio.ptt.domain.ChannelSnapshot

/**
 * Placeholder until the data layer talks to PostgreSQL-backed services.
 */
class StubChannelRepository : ChannelRepository {
    override suspend fun snapshot(): ChannelSnapshot = ChannelSnapshot(
        channels = (1..16).map { idx -> "CH %02d".format(idx) },
        index = 0,
    )
}
