# Installing & Automating PocketLedger Local on iOS (iPhone)

Note: `.apk` is strictly an Android package format. On iOS, apps are installed either as a **Standalone Web App (PWA)** (no Mac or developer account required) or compiled into an **`.ipa`** via Xcode.

## Option A: Instant iOS Installation (No Xcode or Computer Needed)
1. Send `web/index.html` to your iPhone or host it locally, and open it in **Safari**.
2. Tap the **Share** button at the bottom of Safari and tap **Add to Home Screen**.
3. PocketLedger Local will appear on your iPhone Home Screen with its own icon and run full-screen completely offline/locally.

## Option B: Auto-Capturing Purchase Alerts on iOS via Apple Shortcuts
1. Open the built-in **Shortcuts** app on your iPhone and go to the **Automation** tab.
2. Tap **+ (New Automation)** -> choose **Transaction** (when you tap Apple Pay / Wallet) OR choose **Message** (when you receive a bank SMS containing `debited`, `Rs`, or `INR`).
3. Set it to **Run Immediately**.
4. Add Action: **URL** -> pass `shortcutInput` (the SMS text) into the `?auto_notif=` query parameter of your saved PocketLedger bookmark, followed by **Open URLs**.
