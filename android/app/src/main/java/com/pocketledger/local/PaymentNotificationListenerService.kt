package com.pocketledger.local

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class PaymentNotificationListenerService : NotificationListenerService() {

    private val paymentKeywords = listOf("debited", "paid", "spent", "upi ref", "vpa", "rs.", "inr", "₹")

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        val extras = sbn.notification.extras
        val title = extras.getString(Notification.EXTRA_TITLE) ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        val combined = "$title $text".trim()

        val lower = combined.lowercase()
        if (paymentKeywords.any { lower.contains(it) }) {
            // Save to SharedPreferences queue in case MainActivity is closed
            val prefs = getSharedPreferences("pocketledger_queue", Context.MODE_PRIVATE)
            prefs.edit().putString("last_notif", combined).apply()

            // Also broadcast live to MainActivity if open
            val intent = Intent("com.pocketledger.local.NEW_PAYMENT")
            intent.putExtra("notif_text", combined)
            intent.setPackage(packageName)
            sendBroadcast(intent)
        }
    }
}
