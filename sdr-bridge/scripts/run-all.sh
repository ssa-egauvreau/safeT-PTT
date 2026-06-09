#!/usr/bin/env bash
# One-shot launcher: Icecast + per-talkgroup streamers + trunk-recorder, together.
# Press Ctrl-C once to stop everything. Run from sdr-bridge/ AFTER `npm run generate`.
#
# Works the same inside WSL2 (Windows) or on native Linux.
set -uo pipefail
cd "$(dirname "$0")/.."   # -> sdr-bridge/

# Pull the latest talkgroups from the bridges you created in the SafeT console
# (Bridges -> Import from RadioReference) and regenerate the runtime files. Set
# SDR_SKIP_SYNC=1 to use a hand-built config (npm run generate) instead.
if [ "${SDR_SKIP_SYNC:-0}" != "1" ]; then
  echo "[sync] reading bridges from SafeT..."
  node scripts/sync-from-safet.mjs || {
    echo "  ! sync failed — falling back to existing generated files (or run 'npm run generate')." >&2
  }
fi

if [ ! -f icecast/icecast.xml ] || [ ! -f generated/stream-talkgroups.sh ]; then
  echo "  ✗ No runtime files yet. Create bridges in the console then re-run, or 'npm run generate'." >&2
  exit 1
fi

# Pick whichever Compose is installed: the v2 plugin (`docker compose`) or the
# standalone v1 binary (`docker-compose`).
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "  ✗ Docker Compose not found. Install it (Setup does this) and retry." >&2
  exit 1
fi

PIDS=()
cleanup() {
  trap '' EXIT INT TERM
  echo
  echo "stopping..."
  $COMPOSE down >/dev/null 2>&1 || true
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  # Reap the local bridge + its UDP-reading ffmpegs (children may outlive the subshell).
  pkill -9 -f local-bridge.mjs 2>/dev/null || true
  pkill -9 -f "i udp://127.0.0.1:9" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[1/3] Icecast..."
mkdir -p /tmp/icecast-logs
# Clear any stale icecast/streamers from a previous run and wait for port 8000
# to free up first. Ubuntu's icecast2 SEGFAULTS instead of erroring when it
# can't bind the port, so a leftover instance would crash this start.
pkill -9 icecast2 2>/dev/null || true
pkill -9 -f "icecast://source" 2>/dev/null || true
# Also free the per-talkgroup UDP ports the local bridge needs — leftover
# streamers/bridges from a previous run hold them ("bind: address in use").
pkill -9 -f udp-pcm.py 2>/dev/null || true
pkill -9 -f local-bridge.mjs 2>/dev/null || true
pkill -9 -f "udp://127.0.0.1:9" 2>/dev/null || true
sleep 1
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ss -ltn 2>/dev/null | grep -q ':8000 ' || break
  sleep 1
done
icecast2 -c icecast/icecast.xml >/tmp/sdr-icecast.log 2>&1 &
PIDS+=($!)
sleep 2
if ! ss -ltn 2>/dev/null | grep -q ':8000 '; then
  echo "  ✗ Icecast failed to bind :8000 (see /tmp/sdr-icecast.log)." >&2
fi

# Push audio to SafeT from THIS PC. The cloud server can't pull the streams
# through the Cloudflare tunnel (it buffers continuous audio and returns 5XX),
# so the bridge reads the decoder's per-talkgroup UDP directly and pushes voice
# onto each channel over the SafeT voice relay. We do NOT run the Icecast
# talkgroup streamers anymore — they'd bind the same UDP ports and fight the
# bridge. (Icecast itself stays up, just idle.) Logs: /tmp/sdr-bridge.log
echo "[2/3] local SafeT bridge (pushing audio to your channels)..."
( sleep 5; node scripts/local-bridge.mjs ) >/tmp/sdr-bridge.log 2>&1 &
PIDS+=($!)

echo "[3/3] trunk-recorder — decoding the system (Ctrl-C to stop everything)"
echo "      Icecast log:   /tmp/sdr-icecast.log"
echo "      SafeT bridge:  /tmp/sdr-bridge.log"
echo
# Foreground so you see the decoder lock the control channel and log calls.
$COMPOSE up
