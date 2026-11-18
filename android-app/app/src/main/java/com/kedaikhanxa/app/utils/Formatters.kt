package com.kedaikhanxa.app.utils

import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToLong

object Formatters {
    private val idrLocale = Locale("id", "ID")
    private val currencyFormat = NumberFormat.getCurrencyInstance(idrLocale).apply {
        maximumFractionDigits = 0
        minimumFractionDigits = 0
    }

    fun formatRupiah(amount: Double): String {
        val safe = if (amount.isFinite()) amount else 0.0
        return currencyFormat.format(safe)
    }

    fun roundMoney(value: Double): Double {
        if (!value.isFinite()) return 0.0
        return (value * 100.0).roundToLong() / 100.0
    }

    fun todayDateStr(date: Date = Date()): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(date)

    fun currentTimeStr(date: Date = Date()): String =
        SimpleDateFormat("HH:mm:ss", Locale.US).format(date)

    fun generateSafeId(prefix: String): String {
        val clean = prefix.replace(Regex("[^a-zA-Z0-9_-]"), "").take(16).ifEmpty { "doc" }
        val chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        val rand = (1..6).map { chars.random() }.joinToString("")
        return "${clean}_${System.currentTimeMillis()}_$rand"
    }

    data class TxMeta(
        val transactionNumber: String,
        val transactionDate: String,
        val transactionTime: String,
        val recordedByUid: String,
        val recordedByName: String
    )

    fun createTransactionMetadata(prefix: String, uid: String, displayName: String): TxMeta {
        val now = Date()
        val dateStr = todayDateStr(now)
        val timeStr = currentTimeStr(now)
        val compactDate = dateStr.replace("-", "")
        val chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        val suffix = (1..4).map { chars.random() }.joinToString("")
        return TxMeta(
            transactionNumber = "$prefix-$compactDate-$suffix",
            transactionDate = dateStr,
            transactionTime = timeStr,
            recordedByUid = uid,
            recordedByName = displayName.trim().take(100).ifEmpty { "Kasir" }
        )
    }

    fun accountTypeLabel(type: String): String = when (type) {
        "cash" -> "Kas Tunai / Laci"
        "bank" -> "Rekening Bank"
        "ewallet" -> "E-Wallet / DANA"
        "ppob_deposit" -> "Deposit PPOB"
        else -> type
    }

    fun paymentMethodLabel(method: String): String = when (method) {
        "cash" -> "Tunai"
        "qris" -> "QRIS"
        "transfer" -> "Transfer Bank"
        "mixed" -> "Campuran (Tunai + QRIS)"
        "debt" -> "Kasbon / Piutang"
        else -> method
    }
}
