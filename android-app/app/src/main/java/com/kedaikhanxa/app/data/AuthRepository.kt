package com.kedaikhanxa.app.data

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.ListenerRegistration
import com.kedaikhanxa.app.config.FirebaseModule
import com.kedaikhanxa.app.model.UserProfile
import kotlinx.coroutines.tasks.await

class AuthRepository {
    private val auth = FirebaseModule.auth
    private val db = FirebaseModule.db

    fun currentUser(): FirebaseUser? = auth.currentUser

    suspend fun signInWithGoogle(context: Context): Result<FirebaseUser> = runCatching {
        val credentialManager = CredentialManager.create(context)
        val googleIdOption = GetGoogleIdOption.Builder()
            .setFilterByAuthorizedAccounts(false)
            .setServerClientId(FirebaseModule.WEB_CLIENT_ID)
            .setAutoSelectEnabled(false)
            .build()

        val request = GetCredentialRequest.Builder()
            .addCredentialOption(googleIdOption)
            .build()

        val result = credentialManager.getCredential(context, request)
        val googleIdTokenCredential = GoogleIdTokenCredential.createFrom(result.credential.data)
        val firebaseCred = GoogleAuthProvider.getCredential(googleIdTokenCredential.idToken, null)
        val authResult = auth.signInWithCredential(firebaseCred).await()
        val user = authResult.user ?: throw IllegalStateException("Login Google gagal memuat sesi user.")
        ensureUserProfile(user)
        user
    }

    suspend fun ensureUserProfile(user: FirebaseUser) {
        val userRef = db.collection("users").document(user.uid)
        val bootstrapRef = db.collection("system_config").document("bootstrap")
        val email = (user.email ?: "").trim().lowercase()
        val displayName = (user.displayName ?: email.substringBefore("@")).ifBlank { "Pengguna" }.take(100)

        val userSnap = userRef.get().await()
        val bootstrapSnap = runCatching { bootstrapRef.get().await() }.getOrNull()
        val bootstrapExists = bootstrapSnap?.exists() == true

        if (userSnap.exists()) {
            val role = userSnap.getString("role") ?: "pending"
            val status = userSnap.getString("status") ?: "pending"
            if (!bootstrapExists && role == "admin" && status == "active") {
                runCatching {
                    val batch = db.batch()
                    batch.set(
                        bootstrapRef,
                        mapOf(
                            "primaryAdminUid" to user.uid,
                            "claimedAt" to FieldValue.serverTimestamp()
                        )
                    )
                    batch.update(
                        userRef,
                        mapOf(
                            "isPrimaryAdmin" to true,
                            "shiftLabel" to (userSnap.getString("shiftLabel") ?: "Admin Utama"),
                            "updatedAt" to FieldValue.serverTimestamp()
                        )
                    )
                    batch.commit().await()
                }
            }
            return
        }

        if (!bootstrapExists && email == FirebaseModule.BOOTSTRAP_ADMIN_EMAIL && user.isEmailVerified) {
            val batch = db.batch()
            val profileData = mutableMapOf<String, Any>(
                "uid" to user.uid,
                "email" to email,
                "displayName" to displayName,
                "role" to "admin",
                "status" to "active",
                "isPrimaryAdmin" to true,
                "shiftLabel" to "Admin Utama",
                "createdAt" to FieldValue.serverTimestamp(),
                "updatedAt" to FieldValue.serverTimestamp()
            )
            user.photoUrl?.toString()?.take(500)?.let { profileData["photoURL"] = it }
            batch.set(userRef, profileData)
            batch.set(
                bootstrapRef,
                mapOf(
                    "primaryAdminUid" to user.uid,
                    "claimedAt" to FieldValue.serverTimestamp()
                )
            )
            batch.commit().await()
            return
        }

        val inviteSnap = runCatching {
            db.collection("staff_invites")
                .whereEqualTo("email", email)
                .whereEqualTo("status", "pending")
                .limit(1)
                .get()
                .await()
        }.getOrNull()

        if (inviteSnap != null && !inviteSnap.isEmpty) {
            val inviteDoc = inviteSnap.documents.first()
            val inviteRole = if (inviteDoc.getString("role") == "admin") "admin" else "kasir"
            val inviteName = (inviteDoc.getString("displayName") ?: displayName).take(100)
            val inviteShift = inviteDoc.getString("shiftLabel")?.take(40)

            val batch = db.batch()
            val profileData = mutableMapOf<String, Any>(
                "uid" to user.uid,
                "email" to email,
                "displayName" to inviteName,
                "role" to inviteRole,
                "status" to "active",
                "claimedInviteId" to inviteDoc.id,
                "createdAt" to FieldValue.serverTimestamp(),
                "updatedAt" to FieldValue.serverTimestamp()
            )
            user.photoUrl?.toString()?.take(500)?.let { profileData["photoURL"] = it }
            if (!inviteShift.isNullOrBlank()) profileData["shiftLabel"] = inviteShift

            batch.set(userRef, profileData)
            batch.update(
                inviteDoc.reference,
                mapOf(
                    "status" to "claimed",
                    "updatedAt" to FieldValue.serverTimestamp()
                )
            )
            batch.commit().await()
            return
        }

        val pendingData = mutableMapOf<String, Any>(
            "uid" to user.uid,
            "email" to email,
            "displayName" to displayName,
            "role" to "pending",
            "status" to "pending",
            "createdAt" to FieldValue.serverTimestamp(),
            "updatedAt" to FieldValue.serverTimestamp()
        )
        user.photoUrl?.toString()?.take(500)?.let { pendingData["photoURL"] = it }
        userRef.set(pendingData).await()
    }

    fun observeProfile(
        uid: String,
        onUpdate: (UserProfile?) -> Unit,
        onError: (Exception) -> Unit
    ): ListenerRegistration {
        return db.collection("users").document(uid)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    onError(err)
                    return@addSnapshotListener
                }
                if (snap == null || !snap.exists()) {
                    onUpdate(null)
                    return@addSnapshotListener
                }
                val profile = UserProfile(
                    uid = snap.getString("uid") ?: snap.id,
                    email = snap.getString("email") ?: "",
                    displayName = snap.getString("displayName") ?: "Pengguna",
                    photoURL = snap.getString("photoURL"),
                    role = snap.getString("role") ?: "pending",
                    status = snap.getString("status") ?: "pending",
                    shiftLabel = snap.getString("shiftLabel"),
                    phone = snap.getString("phone"),
                    isPrimaryAdmin = snap.getBoolean("isPrimaryAdmin") ?: false
                )
                onUpdate(profile)
            }
    }

    fun signOut() {
        auth.signOut()
    }
}
