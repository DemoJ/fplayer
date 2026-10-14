package com.fplayer.tv.core

import com.google.gson.JsonSyntaxException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class SessionControllerTest {
    private val saved = Session("http://old-server:3000", "old-token", "viewer")
    private val replacement = Session("http://new-server:3000", "new-token", "other")

    @Test
    fun missingSessionShowsLoginWithoutRequest() = runBlocking {
        val fixture = Fixture(null)
        fixture.controller.restore()
        assertEquals(SessionState.SignedOut, fixture.controller.state.value)
        assertEquals(0, fixture.verifications)
        assertEquals(0, fixture.store.clears)
    }

    @Test
    fun successfulValidationRestoresSession() = runBlocking {
        val fixture = Fixture(saved)
        fixture.controller.restore()
        assertEquals(SessionState.Ready(saved), fixture.controller.state.value)
        assertEquals(saved, fixture.active)
        assertEquals(saved, fixture.store.saved)
    }

    @Test
    fun onlyExplicit401ClearsCurrentSession() = runBlocking {
        val fixture = Fixture(saved, verify = { throw httpError(401) })
        fixture.controller.restore()
        assertEquals(SessionState.SignedOut, fixture.controller.state.value)
        assertEquals(null, fixture.active)
        assertEquals(null, fixture.store.saved)
        assertEquals(1, fixture.store.clears)
    }

    @Test
    fun networkHttpAndParsingFailuresKeepCredentials() = runBlocking {
        val failures = listOf(
            IOException("connection reset"),
            SocketTimeoutException("timeout"),
            UnknownHostException("offline"),
            httpError(500), httpError(502), httpError(503),
            httpError(403), httpError(404), httpError(429),
            JsonSyntaxException("invalid JSON"),
            IllegalStateException("empty response"),
        )
        for (failure in failures) {
            val fixture = Fixture(saved, verify = { throw failure })
            fixture.controller.restore()
            val state = fixture.controller.state.value
            assertTrue("Expected retry state for $failure", state is SessionState.ConnectionFailed)
            assertEquals(saved, (state as SessionState.ConnectionFailed).session)
            assertTrue(state.message.isNotBlank())
            assertEquals(saved, fixture.active)
            assertEquals(saved, fixture.store.saved)
            assertEquals(0, fixture.store.clears)
        }
    }

    @Test
    fun retryRecoversWithSameCredentialsWithoutSavingAgain() = runBlocking {
        var offline = true
        val fixture = Fixture(saved, verify = {
            assertEquals(saved, it)
            if (offline) throw IOException("offline")
        })
        fixture.controller.restore()
        assertTrue(fixture.controller.state.value is SessionState.ConnectionFailed)
        offline = false
        fixture.controller.restore()
        assertEquals(SessionState.Ready(saved), fixture.controller.state.value)
        assertEquals(2, fixture.verifications)
        assertEquals(0, fixture.store.saves)
        assertEquals(0, fixture.store.clears)
    }

    @Test
    fun retryMayClearCredentialsWhenServerExplicitlyRejectsThem() = runBlocking {
        var failure: Exception = IOException("offline")
        val fixture = Fixture(saved, verify = { throw failure })
        fixture.controller.restore()
        failure = httpError(401)
        fixture.controller.restore()
        assertEquals(SessionState.SignedOut, fixture.controller.state.value)
        assertEquals(1, fixture.store.clears)
    }

    @Test
    fun cancelledValidationDoesNotClearOrShowConnectionFailure() = runBlocking {
        val fixture = Fixture(saved, verify = { throw CancellationException("screen disposed") })
        var cancelled = false
        try {
            fixture.controller.restore()
        } catch (_: CancellationException) {
            cancelled = true
        }
        assertTrue(cancelled)
        assertEquals(SessionState.Checking(saved), fixture.controller.state.value)
        assertEquals(saved, fixture.store.saved)
        assertEquals(0, fixture.store.clears)
    }

    @Test
    fun oldUnauthorizedResponseCannotClearNewSessionEvenWithSameToken() = runBlocking {
        for (newSession in listOf(replacement, saved.copy())) {
            val response = CompletableDeferred<Unit>()
            val fixture = Fixture(saved, verify = { response.await() })
            val request = launch(start = CoroutineStart.UNDISPATCHED) { fixture.controller.restore() }
            fixture.controller.login(newSession)
            response.completeExceptionally(httpError(401))
            request.join()
            assertEquals(SessionState.Ready(newSession), fixture.controller.state.value)
            assertEquals(newSession, fixture.store.saved)
            assertEquals(newSession, fixture.active)
            assertEquals(0, fixture.store.clears)
        }
    }

    @Test
    fun oldSuccessAndNetworkFailureCannotReplaceNewSession() = runBlocking {
        for (failure in listOf(null, IOException("offline"))) {
            val response = CompletableDeferred<Unit>()
            val fixture = Fixture(saved, verify = { response.await() })
            val request = launch(start = CoroutineStart.UNDISPATCHED) { fixture.controller.restore() }
            fixture.controller.login(replacement)
            if (failure == null) response.complete(Unit) else response.completeExceptionally(failure)
            request.join()
            assertEquals(SessionState.Ready(replacement), fixture.controller.state.value)
            assertEquals(replacement, fixture.store.saved)
        }
    }

    @Test
    fun latestVerificationWinsOverOlderUnauthorizedResponse() = runBlocking {
        val oldResponse = CompletableDeferred<Unit>()
        var calls = 0
        val fixture = Fixture(saved, verify = { if (++calls == 1) oldResponse.await() })
        val oldRequest = launch(start = CoroutineStart.UNDISPATCHED) { fixture.controller.restore() }
        fixture.controller.restore()
        oldResponse.completeExceptionally(httpError(401))
        oldRequest.join()
        assertEquals(SessionState.Ready(saved), fixture.controller.state.value)
        assertEquals(saved, fixture.store.saved)
        assertEquals(0, fixture.store.clears)
    }

    @Test
    fun oldLogoutResponseCannotClearNewLogin() = runBlocking {
        val logoutResponse = CompletableDeferred<Unit>()
        val fixture = Fixture(saved, logout = {
            assertEquals(saved, it)
            logoutResponse.await()
        })
        fixture.controller.restore()
        val logout = launch(start = CoroutineStart.UNDISPATCHED) { fixture.controller.logout() }
        assertEquals(SessionState.SignedOut, fixture.controller.state.value)
        assertEquals(null, fixture.store.saved)
        fixture.controller.login(replacement)
        logoutResponse.complete(Unit)
        logout.join()
        assertEquals(SessionState.Ready(replacement), fixture.controller.state.value)
        assertEquals(replacement, fixture.store.saved)
        assertEquals(replacement, fixture.active)
        assertEquals(1, fixture.store.clears)
    }

    @Test
    fun oldValidationCannotRestoreSessionAfterExplicitLogout() = runBlocking {
        val response = CompletableDeferred<Unit>()
        val fixture = Fixture(saved, verify = { response.await() })
        val request = launch(start = CoroutineStart.UNDISPATCHED) { fixture.controller.restore() }
        fixture.controller.logout()
        response.complete(Unit)
        request.join()
        assertEquals(SessionState.SignedOut, fixture.controller.state.value)
        assertEquals(null, fixture.store.saved)
        assertEquals(null, fixture.active)
    }

    @Test
    fun explicitLogoutWorksOffline() = runBlocking {
        val fixture = Fixture(saved, logout = { throw IOException("offline") })
        fixture.controller.restore()
        fixture.controller.logout()
        assertEquals(SessionState.SignedOut, fixture.controller.state.value)
        assertEquals(null, fixture.store.saved)
        assertEquals(null, fixture.active)
    }

    @Test
    fun storageReadFailureCanRetryWithoutDeletingCredentials() = runBlocking {
        val fixture = Fixture(saved)
        fixture.store.loadFailure = IOException("unavailable")
        fixture.controller.restore()
        assertTrue(fixture.controller.state.value is SessionState.ConnectionFailed)
        assertEquals(saved, fixture.store.saved)
        fixture.store.loadFailure = null
        fixture.controller.restore()
        assertEquals(SessionState.Ready(saved), fixture.controller.state.value)
        assertEquals(0, fixture.store.clears)
    }

    @Test
    fun storageClearFailureKeepsRetryStateUntilInvalidSessionCanBeRemoved() = runBlocking {
        val fixture = Fixture(saved, verify = { throw httpError(401) })
        fixture.store.clearFailure = IOException("unavailable")
        fixture.controller.restore()
        assertTrue(fixture.controller.state.value is SessionState.ConnectionFailed)
        assertEquals(saved, fixture.store.saved)
        assertEquals(saved, fixture.active)
        fixture.store.clearFailure = null
        fixture.controller.restore()
        assertEquals(SessionState.SignedOut, fixture.controller.state.value)
        assertEquals(null, fixture.store.saved)
    }

    private fun httpError(status: Int) = HttpException(Response.error<Unit>(status, "not JSON".toResponseBody()))

    private class Fixture(
        initial: Session?,
        verify: suspend (Session) -> Unit = {},
        logout: suspend (Session) -> Unit = {},
    ) {
        val store = FakeStore(initial)
        var active: Session? = null
        var verifications = 0
        val controller = SessionController(
            store = store,
            verifySession = { verifications++; verify(it) },
            logoutSession = logout,
            updateSession = { active = it },
        )
    }

    private class FakeStore(var saved: Session?) : SessionStore {
        var saves = 0
        var clears = 0
        var loadFailure: Exception? = null
        var clearFailure: Exception? = null
        override suspend fun loadSession(): Session? {
            loadFailure?.let { throw it }
            return saved
        }
        override suspend fun saveSession(session: Session) {
            saves++
            saved = session
        }
        override suspend fun clearSession() {
            clearFailure?.let { throw it }
            clears++
            saved = null
        }
    }
}
