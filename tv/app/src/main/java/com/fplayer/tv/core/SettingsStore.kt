package com.fplayer.tv.core

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.settingsDataStore by preferencesDataStore(name = "fplayer_settings")

class SettingsStore(private val context: Context) : SessionStore {

    private val keyBaseUrl = stringPreferencesKey("base_url")
    private val keyToken = stringPreferencesKey("token")
    private val keyUsername = stringPreferencesKey("username")

    override suspend fun loadSession(): Session? {
        val prefs = context.settingsDataStore.data.first()
        val baseUrl = prefs[keyBaseUrl]
        val token = prefs[keyToken]
        val username = prefs[keyUsername]
        return if (baseUrl != null && token != null && username != null) {
            Session(baseUrl, token, username)
        } else {
            null
        }
    }

    override suspend fun saveSession(session: Session) {
        context.settingsDataStore.edit { prefs ->
            prefs[keyBaseUrl] = session.baseUrl
            prefs[keyToken] = session.token
            prefs[keyUsername] = session.username
        }
    }

    override suspend fun clearSession() {
        context.settingsDataStore.edit { prefs ->
            prefs.remove(keyBaseUrl)
            prefs.remove(keyToken)
            prefs.remove(keyUsername)
        }
    }
}