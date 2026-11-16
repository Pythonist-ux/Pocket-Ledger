# PocketLedger Local — Android (`.apk`) & iOS (`.ipa` / PWA) Build Bundle

## Important Note on Mobile Package Formats
- **Android** uses **`.apk`** packages.
- **iOS** does **not** run `.apk` files — iOS uses **`.ipa`** packages (compiled with Xcode on macOS) or **Standalone Web Apps (PWA)** installed via Safari's **Add to Home Screen** + **iOS Shortcuts Automation**.

Because the cloud sandbox does not have the Android SDK (`aapt2`/`d8`) or macOS Xcode installed to emit binary `.apk` / `.ipa` files directly, this bundle provides:
1. **1-Click Free Cloud APK & iOS Builder (`.github/workflows/build-mobile.yml`)**: Push or upload this folder to a free GitHub repository (private or public), and GitHub Actions will automatically compile and give you the signed **`PocketLedger-Local-debug.apk`** in ~2 minutes with zero local setup required.
2. **Native Android Project (`android/`)**: Includes a native `PaymentNotificationListenerService.kt` (`NotificationListenerService`) that automatically intercepts incoming Google Pay, PhonePe, Paytm, and Bank SMS notifications in the background on your phone and saves them directly into the local SQLite/LocalStorage ledger inside the WebView.
3. **Native iOS Project (`ios/`) + iOS Shortcuts Automation Guide**: Includes `ContentView.swift` (`WKWebView` wrapper) and an iOS Shortcuts Wallet/SMS trigger setup so iPhone purchases auto-log locally.
4. **Standalone Installable Web App (`web/index.html`)**: Open directly in Chrome (Android) or Safari (iOS) and tap **Add to Home Screen** to install immediately as a standalone full-screen app without waiting for a compiler.
