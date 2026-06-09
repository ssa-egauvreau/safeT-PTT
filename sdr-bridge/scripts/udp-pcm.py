#!/usr/bin/env python3
"""Continuous UDP -> stdout PCM bridge.

trunk-recorder's simplestream plugin sends a talkgroup's audio (raw s16le, mono,
8 kHz) to a UDP port ONLY while a call is in progress. Feeding that straight into
ffmpeg doesn't work for an always-live Icecast mount: ffmpeg blocks at startup
waiting for the first packet, so between calls the mount has no source at all and
a remote listener (the SafeT server) is stranded on silence.

This script fixes that. It binds the UDP port and emits a CONTINUOUS real-time
PCM stream on stdout — the decoder's audio when packets are arriving, digital
silence in the gaps — so the downstream ffmpeg always has data and keeps the
mount permanently live. Voice between calls reads as silence (below VOX), and the
instant a call starts the real audio flows through.

Usage:  udp-pcm.py <port>  |  ffmpeg -f s16le -ar 8000 -ac 1 -i - ...
"""
import socket
import sys
import time

RATE = 8000  # Hz, mono, s16le — must match trunk-recorder's simplestream output.
FRAME_SAMPLES = 160  # 20 ms per frame.
FRAME_BYTES = FRAME_SAMPLES * 2
PERIOD = FRAME_SAMPLES / RATE
SILENCE = b"\x00" * FRAME_BYTES
MAX_BUF = RATE * 2 * 2  # ~2 s of audio; drop older backlog so we never lag behind.


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: udp-pcm.py <port>\n")
        return 2
    port = int(sys.argv[1])

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.setblocking(False)

    buf = bytearray()
    out = sys.stdout.buffer
    clock = time.monotonic()

    try:
        while True:
            # Drain every packet that has arrived since the last frame.
            try:
                while True:
                    buf.extend(sock.recv(65536))
            except BlockingIOError:
                pass

            if len(buf) > MAX_BUF:  # fell behind — keep only the most recent audio
                del buf[: len(buf) - MAX_BUF]

            if len(buf) >= FRAME_BYTES:
                out.write(bytes(buf[:FRAME_BYTES]))
                del buf[:FRAME_BYTES]
            else:
                out.write(SILENCE)
            out.flush()

            # Pace to real time using an accumulator so we don't drift.
            clock += PERIOD
            nap = clock - time.monotonic()
            if nap > 0:
                time.sleep(nap)
            elif nap < -1:
                clock = time.monotonic()  # way behind (e.g. machine slept) — resync
    except (BrokenPipeError, KeyboardInterrupt):
        return 0


if __name__ == "__main__":
    sys.exit(main())
