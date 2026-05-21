Place your handset cue audio files in this folder. WAV is recommended (MediaPlayer must support the codec).

The repo ships **small default beeps** so the app plays sound immediately. Replace these files with your own recordings (keep the same names):

  channel_switch.wav   — played when the catalog syncs from the network and when CH+/CH− changes the tuned channel
  ptt_permit.wav       — played once per PTT press when air is clear (stable); not looped while holding PTT
  emergency.wav        — played once when the emergency latch is turned ON
  busy.wav             — Channel busy / listen-only / lost-link: same media volume as ptt_permit and channel_switch;
                       loops while PTT is held on a busy channel or listen-only;
                         plays 2s (then silence) when link is lost, repeating every 15s until ONLINE again
  volume.wav           — IRC590 volume-check key (232); replace on GitHub under this folder (PCM WAV)

See docs/custom-radio-sounds.md for the exact source paths on your PC.

If a file is missing, that cue is skipped (the UI still updates).

Configure the API in `android-app/local.properties` (same folder as this module’s Gradle project root):

  radio.api.base.url=https://safet.up.railway.app/
  radio.api.key=YOUR_SHARED_SECRET

If `radio.api.base.url` is omitted, debug builds default to `http://10.0.2.2:8080/` (emulator → your PC). Release builds default to `https://safet.up.railway.app/`.

See `docs/railway-android-setup.md` for full Railway + Android steps.
