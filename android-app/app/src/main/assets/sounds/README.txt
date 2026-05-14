Place your handset cue audio files in this folder (same names, any format MediaPlayer supports — MP3 is typical):

  channel_switch.mp3   — played when the catalog syncs from the network and when CH+/CH- changes the tuned channel
  ptt_permit.mp3       — looped while PTT is held (talk-permit tone)
  emergency.mp3        — played once when the emergency control is pressed

If a file is missing, that cue is skipped (the UI still updates).

Emulator tip: the debug API base URL points at your PC loopback via 10.0.2.2 (see app/build.gradle.kts). Run `npm run dev` in /server from the repo, then launch the app on an emulator.

Physical device tip: change the debug `API_BASE_URL` to your computer's LAN IP (for example http://192.168.1.50:8080/) and ensure the phone can reach that host on your network.
