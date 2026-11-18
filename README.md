# PocketLedger

A private, offline expense tracker for Android and iOS. It logs **money you spend** (debit alerts and manual
entries) and ignores money you receive. Everything stays on the device.

## Features
- **Debit-only auto-capture** – reads bank SMS / UPI / card notifications; credits, refunds, cashback, OTPs,
  failed payments, reminders and promos are ignored. Duplicate notifications are de-duplicated.
- **Export** – Excel (`.xlsx`, 3 sheets: Expenses, By Category, By Month) or CSV. Works offline.
- **Dark, fullscreen UI** with a 1-second splash screen. Month view, category breakdown, search, undo on delete.
- **Backup / restore** as a JSON file.

## Layout
| Path | What it is |
|---|---|
| `web/` | **Source of truth** for the UI (`index.html`) and logic (`core.js`) |
| `android/` | Android wrapper (Kotlin): fullscreen WebView, notification listener, file save |
| `ios/` | iOS wrapper (SwiftUI + WKWebView) and an XcodeGen spec |
| `branding/` | Logo SVGs the app icons are rendered from |
| `tests/` | Unit tests for parsing and export (`node tests/core.test.js`) |
| `scripts/sync.sh` | Copies `web/` into the Android and iOS apps |

## Working on it
1. Edit `web/index.html` or `web/core.js`.
2. Run `scripts/sync.sh` to copy them into the apps, and `node tests/core.test.js` to run the tests.
   CI fails if the copies are out of date or a test fails.

## Android
GitHub Actions builds the APK (`Actions` tab → **Build Android APK** → run → download the
`PocketLedger-Local-Android-APK` artifact, unzip, install). The APK is signed with a fixed debug key, so new
builds install over old ones and keep your data.

## iOS
See [`ios/IOS_INSTALLATION_AND_SHORTCUTS.md`](ios/IOS_INSTALLATION_AND_SHORTCUTS.md).
