# Custom radio sounds

Copy your Motorola / Zello tone files into the project as follows.

## Android handset (IRC590 volume check)

**Source (your PC):**

`I:\Shared drives\Executive\Vendors and Services\Zello Motrola Tones and Alerts\volume.wav`

**Destination:**

`android-app/app/src/main/assets/sounds/volume.wav`

Replace the file, then rebuild and install the app. Key **232** plays this clip for volume check.

## Dispatch console — 10-33 channel marker (12 second loop)

**Source (your PC):**

`I:\Shared drives\Executive\Vendors and Services\Zello Motrola Tones and Alerts\10-33 Tone 700hz 12 seconds.wav`

**Destination (bundled default for all agencies):**

`server/web-console/public/sounds/marker_1033.wav`

Copy and rename to exactly `marker_1033.wav`, then rebuild/redeploy the web console.

Agencies can also upload a custom marker under **Admin → Sounds → 10-33 channel marker**.

The marker replays every **12 seconds** while 10-33 is active on a channel panel.

## Busy / out-of-range tone (Android handsets + web console)

**Source (your PC):**

`C:\Users\Evan Gauvreau\Downloads\Busy-OutofRange.wav`

**Destinations (copy and rename to exactly `busy.wav`):**

- `android-app/app/src/main/assets/sounds/busy.wav`
- `server/web-console/public/sounds/busy.wav`

**Behavior:**

- **Channel busy** or **listen-only** while you hold PTT: the tone **loops** until you release PTT.
- **No connection / lost link**: play **2 seconds**, then stop; if still offline after **15 seconds**, play 2s again. When connection returns, the sound **stops immediately**.

Agencies can also upload a custom busy tone under **Admin → Sounds → busy** (server kind `busy`).
