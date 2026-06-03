# iOS / Xcode: build fails after `git pull` and Clean Build Folder

This is a common workflow issue, not a broken Mac. The iOS app is **not** fully self-contained inside `ios-app/` — it compiles native voice code from **`android-app/app/src/main/cpp/`**, and two of those folders are **git submodules** that `git pull` does not fill in by itself.

## The fix (run this every time you pull)

On your Mac, open **Terminal** and run these commands in order.

### 1. Go to the repo root

```bash
cd ~/path/to/safeT-PTT
```

(Use the real folder where you cloned the project.)

### 2. Update submodules

```bash
git submodule update --init --recursive
```

**What it does:** Downloads **codec2** and **opus** source trees the iOS target compiles.  
**What you should see:** Progress lines, then your prompt returns with no `fatal` error.

### 3. Regenerate the Xcode project

```bash
cd ios-app
./setup.sh
```

**What it does:** Recreates `SafeTMobile.xcodeproj` and `SafeTMobile/Info.plist` (these are not stored in Git).  
**What you should see:** `OK — iOS project is ready.`

### 4. Build in Xcode

1. Open **`ios-app/SafeTMobile.xcodeproj`** in Xcode.  
2. Press **⌘B** (Product → Build).  
3. Only use **Product → Clean Build Folder** if Xcode still shows a stale error *after* steps 2–3.

**Do not** Clean Build Folder *before* running `./setup.sh` — that wipes Xcode’s cache while the project files or submodules may still be wrong, which makes the next build fail harder to understand.

---

## Why this happens

| Piece | In Git? | After `git pull` |
|--------|---------|------------------|
| `codec2` submodule | Pointer only | Empty until `git submodule update` |
| `opus` submodule | Pointer only | Empty until `git submodule update` |
| `SafeTMobile.xcodeproj` | No (generated) | Missing or outdated until `xcodegen` |
| `SafeTMobile/Info.plist` | No (generated) | Missing until `xcodegen` |
| `Local.xcconfig` | No (your machine) | Should still be there if you created it once |

A **Clean Build Folder** forces Xcode to recompile everything. If submodule `.c` files are missing, you get dozens of red errors like **“Build input file cannot be found”** or **“No such file or directory: codec2.h”**.

---

## Quick checks (if it still fails)

Run in Terminal from the repo root:

```bash
test -f android-app/app/src/main/cpp/codec2/src/codec2.h && echo "codec2 OK" || echo "codec2 MISSING"
test -f android-app/app/src/main/cpp/opus/include/opus.h && echo "opus OK" || echo "opus MISSING"
test -f ios-app/SafeTMobile/Info.plist && echo "Info.plist OK" || echo "run ios-app/setup.sh"
```

All three should say **OK**.

---

## Other common Xcode errors

| Symptom | Fix |
|---------|-----|
| `xcodegen not found` | `brew install xcodegen`, then `./setup.sh` again |
| Signing / Team error | Xcode → project **SafeTMobile** → **Signing & Capabilities** → pick your **Team** |
| Login fails in app | Edit `ios-app/Local.xcconfig` → `SAFET_API_BASE_URL`, then `./setup.sh` and rebuild |
| Errors only in `dvmvocoder` / vocoder | From repo root: `git pull`, then submodule update + `./setup.sh`, then **Clean Build Folder** once |

---

## One-line habit after every pull

```bash
cd ~/path/to/safeT-PTT && git submodule update --init --recursive && cd ios-app && ./setup.sh
```

Then open Xcode and build.
