Place your handset cue audio files in this folder. WAV is recommended (MediaPlayer must support the codec).

The repo ships **small default beeps** so the app plays sound immediately. Replace these files with your own recordings (keep the same names):

  channel_switch.wav   — played when the catalog syncs from the network and when CH+/CH− changes the tuned channel
  ptt_permit.wav       — played once per PTT press when air is clear (stable); not looped while holding PTT
  emergency.wav        — played once when the emergency latch is turned ON
  busy.wav             — looped while PTT is held if there is no connection (not ONLINE) or the server reports the channel occupied (`GET /v1/air`)

If a file is missing, that cue is skipped (the UI still updates).

Configure the API in `android-app/local.properties` (same folder as this module’s Gradle project root):

  radio.api.base.url=https://YOUR_SERVICE.up.railway.app/
  radio.api.key=YOUR_SHARED_SECRET

If `radio.api.base.url` is omitted, debug builds default to `http://10.0.2.2:8080/` (emulator → your PC). Release builds default to a placeholder Railway URL until you set the property.

See `docs/railway-android-setup.md` for full Railway + Android steps.
