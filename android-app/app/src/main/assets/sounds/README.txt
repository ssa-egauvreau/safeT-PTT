Place your handset cue audio files in this folder. WAV is recommended (MediaPlayer must support the codec).

  channel_switch.wav   — played when the catalog syncs from the network and when CH+/CH− changes the tuned channel
  ptt_permit.wav       — looped while PTT is held (talk-permit tone)
  emergency.wav        — played once when the emergency control is pressed

If a file is missing, that cue is skipped (the UI still updates).

Configure the API in `android-app/local.properties` (same folder as this module’s Gradle project root):

  radio.api.base.url=https://YOUR_SERVICE.up.railway.app/
  radio.api.key=YOUR_SHARED_SECRET

If `radio.api.base.url` is omitted, debug builds default to `http://10.0.2.2:8080/` (emulator → your PC). Release builds default to a placeholder Railway URL until you set the property.

See `docs/railway-android-setup.md` for full Railway + Android steps.
