package com.kedaikhanxa.app.config

import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.PersistentCacheSettings

object FirebaseModule {
    const val PROJECT_ID = "flash-lead-kwpgt"
    const val FIRESTORE_DATABASE_ID = "ai-studio-655beb1c-8e1a-4a3c-8e9c-6d8a3dcc3557"
    const val WEB_CLIENT_ID = "296972496024-fcs7kgrua8c7rqnb9ujdmbblich70pgs.apps.googleusercontent.com"
    const val BOOTSTRAP_ADMIN_EMAIL = "hsbg9427@gmail.com"

    val auth: FirebaseAuth by lazy {
        FirebaseAuth.getInstance()
    }

    val db: FirebaseFirestore by lazy {
        val instance = FirebaseFirestore.getInstance(
            FirebaseApp.getInstance(),
            FIRESTORE_DATABASE_ID
        )
        val settings = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(PersistentCacheSettings.newBuilder().build())
            .build()
        instance.firestoreSettings = settings
        instance
    }
}
