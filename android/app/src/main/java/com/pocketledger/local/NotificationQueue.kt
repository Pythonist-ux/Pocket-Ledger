package com.pocketledger.local

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Holds payment notifications captured while the app UI is closed, each with the time it arrived.
 * The web UI drains it as soon as it is open and writes the entries into the ledger.
 */
object NotificationQueue {
    private const val PREFS = "pocketledger_queue"
    private const val KEY = "items"
    private const val MAX_ITEMS = 200

    @Synchronized
    fun add(context: Context, text: String, ts: Long) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val items = try { JSONArray(prefs.getString(KEY, "[]")) } catch (e: Exception) { JSONArray() }
        items.put(JSONObject().put("t", text).put("ts", ts))
        val keep = if (items.length() > MAX_ITEMS) {
            JSONArray().also { out -> for (i in items.length() - MAX_ITEMS until items.length()) out.put(items.get(i)) }
        } else items
        prefs.edit().putString(KEY, keep.toString()).commit()
    }

    /** Returns the queued messages as a JSON array string and empties the queue. */
    @Synchronized
    fun drain(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val json = prefs.getString(KEY, null) ?: return "[]"
        prefs.edit().remove(KEY).commit()
        return json
    }
}
