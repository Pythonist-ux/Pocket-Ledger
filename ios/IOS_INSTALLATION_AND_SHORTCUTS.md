# PocketLedger on iOS

iOS never allows an app to read other apps' notifications, so auto-capture on iPhone works through
**Shortcuts automations** that hand the bank message to the app. Everything else (adding expenses, export,
backup) works the same as on Android.

## 1. Build the app (needs a Mac with Xcode 15+)
```bash
brew install xcodegen
cd ios
xcodegen generate          # creates PocketLedger.xcodeproj from project.yml
open PocketLedger.xcodeproj
```
In Xcode: select the **PocketLedger** target → *Signing & Capabilities* → choose your Apple ID team, plug in
your iPhone, press **Run**. (A free Apple ID works; the app must be re-installed every 7 days. A paid
developer account removes that limit.)

> The iOS project could not be compiled or run in the environment where it was written (no Xcode). If Xcode
> reports an error, send it over and it will be fixed.

## 2. Auto-log debit messages with Shortcuts
The app registers the URL scheme `pocketledger://add?text=<message>`.

1. Open **Shortcuts** → **Automation** → **+** → **Message**.
2. *Message contains*: `debited` (add another automation for `spent` or `paid` if you like).
3. Choose **Run Immediately**.
4. Add the action **Open URLs** with this URL: `pocketledger://add?text=` followed by the variable
   **Shortcut Input** (the message text). Use the *URL Encode* action on the text first so symbols survive.

The app decides whether the message is a debit. Credits, refunds, OTPs and promos are ignored even if the
automation fires for them, and the same message is never logged twice.

iOS opens the app briefly when the automation runs. That is an iOS rule and can't be avoided.

## 3. Using it without a Mac
Not possible with the native app. An installable web version (Safari → Share → *Add to Home Screen*) needs the
`web/` folder hosted on an HTTPS URL such as GitHub Pages; opening a local file in Safari cannot be installed.
