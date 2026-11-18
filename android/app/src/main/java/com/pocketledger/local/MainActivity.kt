package com.pocketledger.local

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var receiverRegistered = false

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            fileCallback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
            fileCallback = null
        }

    // The listener service pings us when a new payment notification is queued.
    private val pingReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = pullQueue()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Fullscreen: draw edge to edge, under the cutout, with the system bars hidden.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= 28) {
            val lp = window.attributes
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            window.attributes = lp
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0A0B0F"))
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }
        setContentView(webView)

        // Keep content clear of the camera cutout and above the on-screen keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            insets
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
            builtInZoomControls = false
        }

        // Serve the bundled UI from a real https origin (stable localStorage, no file:// quirks).
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            // The app is fully offline: never navigate away from the bundled page.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != WebViewAssetLoader.DEFAULT_DOMAIN

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                recreate()
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            // Needed for "Restore backup" (<input type="file">).
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                try {
                    fileChooser.launch(params.createIntent())
                } catch (e: Exception) {
                    fileCallback = null
                    callback.onReceiveValue(null)
                }
                return true
            }
        }
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/index.html")

        // Back closes an open sheet first, then leaves the app.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.PL && PL.back()") { handled ->
                    if (handled != "true") finish()
                }
            }
        })

        // First launch only: send the user to enable notification access (also available in Settings).
        val prefs = getSharedPreferences("pocketledger", Context.MODE_PRIVATE)
        if (!isListenerEnabled() && !prefs.getBoolean("asked_listener", false)) {
            prefs.edit().putBoolean("asked_listener", true).apply()
            Handler(Looper.getMainLooper()).postDelayed({ openNotificationAccess() }, 1600)
        }
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        ContextCompat.registerReceiver(
            this, pingReceiver, IntentFilter(PaymentNotificationListenerService.ACTION),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        receiverRegistered = true
        webView.onResume()
        pullQueue()
    }

    override fun onPause() {
        super.onPause()
        if (receiverRegistered) {
            unregisterReceiver(pingReceiver)
            receiverRegistered = false
        }
        webView.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onDestroy() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun hideSystemBars() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun pullQueue() {
        webView.evaluateJavascript("window.PL && PL.pull()", null)
    }

    private fun isListenerEnabled(): Boolean =
        NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)

    private fun openNotificationAccess() {
        try {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } catch (e: Exception) { /* no settings screen on this device */ }
    }

    // ---- file export -------------------------------------------------------------------------

    private fun safeName(name: String) = name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "export" }

    /** Android 10+: saves into Downloads/PocketLedger. Older versions fall back to the share sheet. */
    private fun saveToDownloads(name: String, mime: String, bytes: ByteArray): String {
        if (Build.VERSION.SDK_INT < 29) return shareBytes(name, mime, bytes)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/PocketLedger")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return "err:could not create file"
        return try {
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("could not open file")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            "ok:Downloads/PocketLedger"
        } catch (e: Exception) {
            contentResolver.delete(uri, null, null)
            "err:" + e.message
        }
    }

    private fun shareBytes(name: String, mime: String, bytes: ByteArray): String {
        val dir = File(cacheDir, "exports").apply { mkdirs() }
        val file = File(dir, name).apply { writeBytes(bytes) }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runOnUiThread { startActivity(Intent.createChooser(send, "Export")) }
        return "shared"
    }

    /** Called from the web UI (runs on a background thread). */
    inner class Bridge {
        @JavascriptInterface
        fun drainQueue(): String = NotificationQueue.drain(applicationContext)

        @JavascriptInterface
        fun isListenerEnabled(): Boolean = this@MainActivity.isListenerEnabled()

        @JavascriptInterface
        fun openNotificationAccess() {
            runOnUiThread { this@MainActivity.openNotificationAccess() }
        }

        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String): String = try {
            saveToDownloads(safeName(name), mime, Base64.decode(base64, Base64.DEFAULT))
        } catch (e: Exception) {
            "err:" + e.message
        }

        @JavascriptInterface
        fun shareFile(name: String, mime: String, base64: String): String = try {
            shareBytes(safeName(name), mime, Base64.decode(base64, Base64.DEFAULT))
        } catch (e: Exception) {
            "err:" + e.message
        }
    }
}
