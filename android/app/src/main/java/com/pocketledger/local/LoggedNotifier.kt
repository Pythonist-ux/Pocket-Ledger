package com.pocketledger.local

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.text.NumberFormat
import java.util.Locale

/** Posts the "Logged ₹X · Payee" pop-up and remembers recent payments so one payment pops up once. */
object LoggedNotifier {
    private const val CHANNEL = "logged"
    private const val PREFS = "pocketledger_recent"
    private const val WINDOW_MS = 5 * 60 * 1000L

    fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /**
     * True if this alert is the same payment as one seen in the last few minutes (same alert re-posted,
     * or the bank SMS + UPI-app alert for one payment). Mirrors the ledger's own merge rule.
     */
    @Synchronized
    fun isRepeat(context: Context, r: MessageParser.Result, fp: String, now: Long): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val kept = org.json.JSONArray()
        var repeat = false
        val old = try { org.json.JSONArray(prefs.getString("l", "[]")) } catch (e: Exception) { org.json.JSONArray() }
        for (i in 0 until old.length()) {
            val o = old.getJSONObject(i)
            if (now - o.getLong("ts") > WINDOW_MS) continue
            kept.put(o)
            val sameRef = r.refId.isNotEmpty() && r.refId == o.optString("ref")
            val refClash = r.refId.isNotEmpty() && o.optString("ref").isNotEmpty() && r.refId != o.optString("ref")
            if (o.optString("fp") == fp || sameRef || (!refClash && Math.abs(o.getDouble("amt") - r.amount) < 0.005)) repeat = true
        }
        if (!repeat) {
            kept.put(org.json.JSONObject().put("ts", now).put("fp", fp).put("amt", r.amount).put("ref", r.refId))
        }
        prefs.edit().putString("l", kept.toString()).commit()
        return repeat
    }

    fun show(context: Context, r: MessageParser.Result, now: Long) {
        if (!canPost(context)) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Logged expenses", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A pop-up each time an expense is logged"
                }
            )
        }
        val amount = "₹" + NumberFormat.getNumberInstance(Locale("en", "IN")).apply {
            minimumFractionDigits = if (r.amount % 1.0 == 0.0) 0 else 2; maximumFractionDigits = 2
        }.format(r.amount)
        val payee = if (r.merchant == "Unknown" || r.merchant.isEmpty()) "" else " · " + r.merchant
        val detail = listOf(
            if (r.bank.isNotEmpty()) "From " + r.bank + (if (r.acct.isNotEmpty()) " ••" + r.acct else "") else "",
            r.mode
        ).filter { it.isNotEmpty() }.joinToString(" · ")

        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_logged)
            .setContentTitle("Logged $amount$payee")
            .setContentText(detail.ifEmpty { "Expense added to your ledger" })
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setTimeoutAfter(15000)
            .setContentIntent(open)
            .build()
        try { NotificationManagerCompat.from(context).notify((now % Int.MAX_VALUE).toInt(), n) } catch (e: SecurityException) { }
    }
}
