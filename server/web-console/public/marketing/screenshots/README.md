# Marketing screenshots

Real product screenshots used on public marketing pages (`/`, `/setup`, `/mobile`, etc.).

## Regenerating

1. Start PostgreSQL and the API server (`npm run dev` in `server/` with `DATABASE_URL` set).
2. Start the Vite dev server (`npm run dev` in `server/web-console/`).
3. From `server/` run:

```bash
npm run capture-marketing-screenshots
```

Output is written to `server/web-console/public/marketing/screenshots/`.

## Files

| File | Source |
|------|--------|
| `signup.webp` | `/signup` |
| `command-console.webp` | `/console` (dispatch) |
| `control-users.webp` | `/admin` → Users |
| `control-channels.webp` | `/admin` → Channels |
| `control-downloads.webp` | `/admin` → Downloads |
| `mobile-radio-portal.webp` | `/radio` (390×844 mobile viewport) |

Android OS settings steps in `/setup/android` intentionally have no images until real device screenshots are captured.

Native safeT Mobile (APK) screenshots can be added when captured from a handset or emulator; replace `mobile-radio-portal.webp` references if a dedicated APK shot is added.
