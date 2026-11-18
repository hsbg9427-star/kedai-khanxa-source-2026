package com.kedaikhanxa.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val EmeraldPrimary = Color(0xFF047857)
val EmeraldLight = Color(0xFFD1FAE5)
val EmeraldDark = Color(0xFF064E3B)
val SlateInk = Color(0xFF0F172A)
val SlateMuted = Color(0xFF64748B)
val SlateBg = Color(0xFFF8FAFC)
val SurfaceCard = Color(0xFFFFFFFF)
val AmberWarn = Color(0xFFB45309)
val RedDanger = Color(0xFFB91C1C)

private val KhanxaColorScheme = lightColorScheme(
    primary = EmeraldPrimary,
    onPrimary = Color.White,
    primaryContainer = EmeraldLight,
    onPrimaryContainer = EmeraldDark,
    secondary = Color(0xFF0369A1),
    onSecondary = Color.White,
    background = SlateBg,
    onBackground = SlateInk,
    surface = SurfaceCard,
    onSurface = SlateInk,
    surfaceVariant = Color(0xFFF1F5F9),
    onSurfaceVariant = SlateMuted,
    error = RedDanger,
    onError = Color.White
)

@Composable
fun KedaiKhanxaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = KhanxaColorScheme,
        content = content
    )
}
