# safeT Mobile (iOS)

## First time on a Mac

1. Install **Xcode** from the Mac App Store.
2. Install [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`
3. From the **repo root**: `git submodule update --init --recursive`
4. Open Terminal in this folder (`ios-app`) and run: `./setup.sh`
5. Copy `Local.example.xcconfig` → `Local.xcconfig` (setup does this if missing) and set your API URL.
6. Open `SafeTMobile.xcodeproj` in Xcode → set **Signing & Capabilities** → **Team** → **Run** (▶).

Full click-by-click steps: **`docs/ios-xcode-after-pull.md`** (same steps fix most build failures).

## After every `git pull` (important)

**Do not only use Clean Build Folder.** Pull updates submodule pointers and `project.yml`; you must refresh dependencies and regenerate the Xcode project:

```bash
cd ..   # repo root
git submodule update --init --recursive
cd ios-app
./setup.sh
```

Then build in Xcode (⌘B). See **`docs/ios-xcode-after-pull.md`** if anything is still red.

## Generate the Xcode project manually

If you prefer not to use `./setup.sh`:

1. `git submodule update --init --recursive` from the repo root
2. `xcodegen generate` in `ios-app`
3. Open `SafeTMobile.xcodeproj`

## P25 IMBE vocoder

The iOS app bundles the same **dvmvocoder** library as Android (GPL-2.0; see `android-app/app/src/main/cpp/dvmvocoder`). Native sources are compiled from that tree; the thin C bridge lives in `SafeTMobile/Native/p25_vocoder_bridge.cpp`.

When the vocoder loads successfully, voice uplink uses **88-bit IMBE** frames (matching Android and the web console). If the native library fails to link on a device, the app falls back to **clear PCM** uplink so you can still talk, but peers on digital mode may hear garbled audio until the vocoder is fixed.

After pulling repo changes that touch vocoder paths: run **`./setup.sh`** first, then **Product → Clean Build Folder** in Xcode only if needed, then build again.
