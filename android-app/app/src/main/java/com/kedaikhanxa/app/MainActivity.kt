package com.kedaikhanxa.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.google.firebase.FirebaseApp
import com.kedaikhanxa.app.ui.KhanxaApp
import com.kedaikhanxa.app.ui.theme.KedaiKhanxaTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        FirebaseApp.initializeApp(this)
        enableEdgeToEdge()
        setContent {
            KedaiKhanxaTheme {
                KhanxaApp()
            }
        }
    }
}
