package com.pocketledger.local

import android.app.Notification
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Watches incoming notifications (bank SMS, UPI apps, card alerts) and queues the ones that look
 * like money going OUT, queues them for the ledger, and shows a "Logged" pop-up.
 * Parsing uses MessageParser (a tested port of web/core.js), so credits, refunds, OTPs and promos are ignored.
 */
class PaymentNotificationListenerService : NotificationListenerService() {

    private val currency = Regex("(?:rs\\.?|inr|₹)\\s*[0-9]", RegexOption.IGNORE_CASE)
    private val outgoing = Regex(
        "\\b(?:debited|spent|paid|purchase[d]?|withdrawn|charged|deducted|payment of|sent)\\b",
        RegexOption.IGNORE_CASE
    )

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null || sbn.packageName == packageName) return
        val n = sbn.notification ?: return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
        val combined = "$title ${if (big.length > text.length) big else text}".trim()

        if (!currency.containsMatchIn(combined) || !outgoing.containsMatchIn(combined)) return

        // Same parser as the app (tests/vectors.tsv keeps the two identical): credits, OTPs and promos stop here.
        val parsed = MessageParser.parse(combined)
        if (parsed.kind != "debit") return

        val now = System.currentTimeMillis()
        NotificationQueue.add(this, combined, now)
        if (!LoggedNotifier.isRepeat(this, parsed, MessageParser.fingerprint(combined), now)) {
            LoggedNotifier.show(this, parsed, now)
        }
        sendBroadcast(Intent(ACTION).setPackage(packageName))
    }

    // Some phones silently unbind listeners; ask the system to reconnect us.
    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        if (Build.VERSION.SDK_INT >= 24) {
            requestRebind(ComponentName(this, PaymentNotificationListenerService::class.java))
        }
    }

    companion object {
        const val ACTION = "com.pocketledger.local.NEW_PAYMENT"
    }
}
