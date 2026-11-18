package com.kedaikhanxa.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.kedaikhanxa.app.model.Account
import com.kedaikhanxa.app.model.CashierClosing
import com.kedaikhanxa.app.model.MiniAtmTransaction
import com.kedaikhanxa.app.model.PpobTransaction
import com.kedaikhanxa.app.model.Receivable
import com.kedaikhanxa.app.model.Sale
import com.kedaikhanxa.app.utils.ClosingMath
import com.kedaikhanxa.app.utils.Formatters
import kotlinx.coroutines.launch

@Composable
fun ClosingKasirScreen(
    isAdmin: Boolean,
    userUid: String,
    accounts: List<Account>,
    sales: List<Sale>,
    miniAtm: List<MiniAtmTransaction>,
    ppob: List<PpobTransaction>,
    receivables: List<Receivable>,
    closings: List<CashierClosing>,
    onFinalizeClosing: suspend (
        shiftLabel: String,
        periodStart: String,
        periodEnd: String,
        openingCash: Double,
        actualCash: Double,
        notes: String
    ) -> Result<String>,
    onReviewClosing: suspend (closingId: String, status: String, note: String) -> Result<Unit>
) {
    val scope = rememberCoroutineScope()
    val today = remember { Formatters.todayDateStr() }

    var startDate by remember { mutableStateOf(today) }
    var endDate by remember { mutableStateOf(today) }
    var shiftLabel by remember { mutableStateOf("Shift Utama") }
    var openingCashInput by remember { mutableStateOf("0") }
    var actualCashInput by remember { mutableStateOf("") }
    var notesInput by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }

    var reviewTarget by remember { mutableStateOf<CashierClosing?>(null) }
    var reviewNote by remember { mutableStateOf("") }

    val breakdown = remember(sales, miniAtm, ppob, receivables, accounts, userUid, startDate, endDate, openingCashInput) {
        ClosingMath.computeBreakdown(
            sales = sales,
            miniAtm = miniAtm,
            ppob = ppob,
            receivables = receivables,
            accounts = accounts,
            targetCashierUid = userUid,
            periodStartDate = startDate,
            periodEndDate = endDate,
            openingCash = openingCashInput.toDoubleOrNull() ?: 0.0
        )
    }

    val variance = remember(breakdown.expectedCash, actualCashInput) {
        ClosingMath.evaluateVariance(breakdown.expectedCash, actualCashInput.toDoubleOrNull() ?: 0.0)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Closing Kasir & Hitung Uang Fisik", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Transaksi QRIS, Transfer Bank, DANA, dan Piutang dipisahkan dari uang fisik laci kasir.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = startDate,
                            onValueChange = { startDate = it },
                            label = { Text("Dari Tanggal") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = endDate,
                            onValueChange = { endDate = it },
                            label = { Text("Sampai Tanggal") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = shiftLabel,
                            onValueChange = { shiftLabel = it },
                            label = { Text("Shift") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = openingCashInput,
                            onValueChange = { openingCashInput = it.filter { ch -> ch.isDigit() } },
                            label = { Text("Modal Awal Laci") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }

                    HorizontalDivider()
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Total Penjualan (${breakdown.retailTxCount} trx)")
                        Text(Formatters.formatRupiah(breakdown.totalSalesAmount), fontWeight = FontWeight.SemiBold)
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Penjualan Tunai (Masuk Laci)")
                        Text(Formatters.formatRupiah(breakdown.retailCashIn))
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("QRIS + Transfer Non-Tunai")
                        Text(Formatters.formatRupiah(breakdown.retailQrisTotal + breakdown.retailTransferTotal))
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Mini ATM Tunai Masuk / Keluar")
                        Text("+${Formatters.formatRupiah(breakdown.miniAtmCashIn)} / -${Formatters.formatRupiah(breakdown.miniAtmCashOut)}")
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("PPOB Tunai + Pelunasan Piutang Tunai")
                        Text(Formatters.formatRupiah(breakdown.ppobCashIn + breakdown.receivableCashIn))
                    }
                    HorizontalDivider()
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Uang Fisik yang Diharapkan", fontWeight = FontWeight.Bold)
                        Text(
                            Formatters.formatRupiah(breakdown.expectedCash),
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }

                    OutlinedTextField(
                        value = actualCashInput,
                        onValueChange = { actualCashInput = it.filter { ch -> ch.isDigit() } },
                        label = { Text("Jumlah Uang Fisik Hasil Hitung (Rp)*") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )

                    if (actualCashInput.isNotEmpty()) {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.primaryContainer
                            )
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(12.dp),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text("Status: ${variance.statusLabel}", fontWeight = FontWeight.Bold)
                                Text(
                                    "Selisih: ${Formatters.formatRupiah(variance.varianceAmount)}",
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }

                    OutlinedTextField(
                        value = notesInput,
                        onValueChange = { notesInput = it },
                        label = {
                            Text(
                                if (variance.status != "balance") "Catatan Penjelasan Selisih (Wajib)*"
                                else "Catatan Closing (Opsional)"
                            )
                        },
                        modifier = Modifier.fillMaxWidth()
                    )

                    if (!feedback.isNullOrBlank()) {
                        Text(feedback ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }

                    Button(
                        onClick = {
                            scope.launch {
                                busy = true
                                val actual = actualCashInput.toDoubleOrNull()
                                if (actual == null) {
                                    feedback = "Masukkan jumlah uang fisik yang dihitung terlebih dahulu."
                                    busy = false
                                    return@launch
                                }
                                val res = onFinalizeClosing(
                                    shiftLabel,
                                    startDate,
                                    endDate,
                                    openingCashInput.toDoubleOrNull() ?: 0.0,
                                    actual,
                                    notesInput
                                )
                                res.onSuccess { trxNo ->
                                    feedback = "Closing $trxNo berhasil difinalisasi permanen."
                                    actualCashInput = ""
                                    notesInput = ""
                                }.onFailure { err ->
                                    feedback = err.message ?: "Gagal menyimpan closing."
                                }
                                busy = false
                            }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(if (busy) "Memfinalisasi..." else "Finalisasi Closing Kasir")
                    }
                }
            }
        }

        item {
            Text(
                text = if (isAdmin) "Seluruh Riwayat Closing Kasir (Mode Audit Admin)" else "Riwayat Closing Saya (Permanen)",
                fontWeight = FontWeight.Bold
            )
        }

        items(closings, key = { it.id }) { c ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${c.transactionNumber} · ${c.recordedByName}", fontWeight = FontWeight.Bold)
                        Text(ClosingMath.statusLabel(c.status), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                    }
                    Text("Periode: ${c.periodStartDate} s/d ${c.periodEndDate}", style = MaterialTheme.typography.labelSmall)
                    Text(
                        "Diharapkan: ${Formatters.formatRupiah(c.expectedCash)} · Fisik: ${Formatters.formatRupiah(c.actualCash)} · Selisih: ${Formatters.formatRupiah(c.varianceAmount)}",
                        style = MaterialTheme.typography.bodySmall
                    )
                    if (c.notes.isNotBlank()) {
                        Text("Catatan Kasir: ${c.notes}", style = MaterialTheme.typography.labelSmall)
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "Audit: ${c.reviewStatus}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        // Hanya Admin yang dapat memeriksa / memverifikasi closing
                        if (isAdmin) {
                            OutlinedButton(onClick = {
                                reviewTarget = c
                                reviewNote = c.reviewNote
                            }) {
                                Text("Periksa / Verifikasi")
                            }
                        }
                    }
                }
            }
        }
    }

    if (reviewTarget != null && isAdmin) {
        val t = reviewTarget!!
        AlertDialog(
            onDismissRequest = { reviewTarget = null },
            title = { Text("Pemeriksaan Closing ${t.transactionNumber}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Kasir: ${t.recordedByName}")
                    Text("Selisih: ${Formatters.formatRupiah(t.varianceAmount)} (${ClosingMath.statusLabel(t.status)})")
                    OutlinedTextField(
                        value = reviewNote,
                        onValueChange = { reviewNote = it },
                        label = { Text("Catatan Pemeriksaan Admin") }
                    )
                }
            },
            confirmButton = {
                Button(onClick = {
                    scope.launch {
                        onReviewClosing(t.id, "verified", reviewNote)
                        reviewTarget = null
                    }
                }) { Text("Setujui / Verifikasi") }
            },
            dismissButton = {
                TextButton(onClick = {
                    scope.launch {
                        onReviewClosing(t.id, "flagged", reviewNote)
                        reviewTarget = null
                    }
                }) { Text("Tandai Selisih") }
            }
        )
    }
}
