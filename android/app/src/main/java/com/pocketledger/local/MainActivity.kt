package com.pocketledger.local

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import java.net.URLEncoder

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    private val paymentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val rawText = intent?.getStringExtra("notif_text") ?: return
            val encoded = URLEncoder.encode(rawText, "UTF-8")
            webView.post {
                webView.loadUrl("file:///android_asset/index.html?auto_notif=$encoded")
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
        }
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()

        // Prompt user once to enable Notification Access if not already granted
        if (!isNotificationServiceEnabled()) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        // Check if Pending notifications were queued while app was closed
        val prefs = getSharedPreferences("pocketledger_queue", Context.MODE_PRIVATE)
        val pending = prefs.getString("last_notif", null)
        if (pending != null) {
            prefs.edit().remove("last_notif").apply()
            val encoded = URLEncoder.encode(pending, "UTF-8")
            webView.loadUrl("file:///android_asset/index.html?auto_notif=$encoded")
        } else {
            webView.loadUrl("file:///android_asset/index.html")
        }
    }

    override fun onResume() {
        super.onResume()
        registerReceiver(paymentReceiver, IntentFilter("com.pocketledger.local.NEW_PAYMENT"), Context.RECEIVER_NOT_EXPORTED)
    }

    override fun onPause() {
        super.onPause()
        unregisterReceiver(paymentReceiver)
    }

    private fun isNotificationServiceEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        return flat != null && flat.contains(packageName)
    }
}
