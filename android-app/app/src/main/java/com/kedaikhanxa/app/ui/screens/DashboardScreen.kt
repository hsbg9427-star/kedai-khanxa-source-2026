package com.kedaikhanxa.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kedaikhanxa.app.model.Account
import com.kedaikhanxa.app.model.CashierClosing
import com.kedaikhanxa.app.model.Sale
import com.kedaikhanxa.app.utils.ClosingMath
import com.kedaikhanxa.app.utils.Formatters

@Composable
fun DashboardScreen(
    isAdmin: Boolean,
    displayName: String,
    accounts: List<Account>,
    sales: List<Sale>,
    closings: List<CashierClosing>,
    onNavigateTab: (String) -> Unit
) {
    val today = Formatters.todayDateStr()
    val todaySales = sales.filter { it.transactionDate == today && it.status == "completed" }
    val totalTodayRevenue = todaySales.sumOf { it.totalAmount }
    val totalProfitToday = todaySales.sumOf { it.totalProfit }
    val totalAccountBalance = accounts.filter { it.isActive }.sumOf { it.balance }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = if (isAdmin) "Halo Admin, $displayName" else "Shift Kasir · $displayName",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = if (isAdmin)
                            "Akses penuh ke seluruh transaksi, saldo rekening, dan verifikasi closing kasir."
                        else
                            "Mode Operasional Kasir: POS, Mini ATM, PPOB, Pelanggan, Closing Kasir, & Saldo Hanya Baca.",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        }

        // KPI Utama (Tanpa menampilkan HPP/Laba kepada Kasir!)
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Card(modifier = Modifier.weight(1f)) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Text(
                            text = if (isAdmin) "Penjualan Hari Ini" else "Penjualan Saya",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = Formatters.formatRupiah(totalTodayRevenue),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "${todaySales.size} transaksi selesai",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Card(modifier = Modifier.weight(1f)) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        if (isAdmin) {
                            Text(
                                text = "Estimasi Laba Toko",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = Formatters.formatRupiah(totalProfitToday),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary
                            )
                            Text(
                                text = "Khusus Admin",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        } else {
                            Text(
                                text = "Closing Kasir Saya",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "${closings.size} riwayat",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = closings.firstOrNull()?.let {
                                    ClosingMath.statusLabel(it.status)
                                } ?: "Belum closing hari ini",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                }
            }
        }

        // Aksi Cepat Operasional
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    onClick = { onNavigateTab("pos") },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.PointOfSale, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text(" POS", maxLines = 1)
                }
                OutlinedButton(
                    onClick = { onNavigateTab("closing") },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.ReceiptLong, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text(" Closing", maxLines = 1)
                }
            }
        }

        // Saldo SELURUH Rekening & Akun Usaha (Read-Only untuk Kasir)
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(
                                Icons.Default.AccountBalanceWallet,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(18.dp)
                            )
                            Text(
                                text = "Saldo Seluruh Rekening Usaha",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        if (!isAdmin) {
                            AssistChip(
                                onClick = {},
                                label = { Text("Hanya Baca", style = MaterialTheme.typography.labelSmall) },
                                leadingIcon = {
                                    Icon(Icons.Default.Lock, contentDescription = null, modifier = Modifier.size(14.dp))
                                }
                            )
                        }
                    }

                    HorizontalDivider()

                    accounts.filter { it.isActive }.forEach { acc ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column {
                                Text(acc.name, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    Formatters.accountTypeLabel(acc.type),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Text(
                                text = Formatters.formatRupiah(acc.balance),
                                fontWeight = FontWeight.Bold,
                                style = MaterialTheme.typography.bodyMedium
                            )
                        }
                    }

                    HorizontalDivider()
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Total Keseluruhan Saldo Usaha",
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = Formatters.formatRupiah(totalAccountBalance),
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.bodyLarge
                        )
                    }
                }
            }
        }

        // Riwayat Closing Terbaru
        item {
            Text(
                text = if (isAdmin) "Riwayat Closing Semua Kasir" else "Riwayat Closing Saya",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold
            )
        }
        if (closings.isEmpty()) {
            item {
                Text(
                    text = "Belum ada riwayat closing kasir.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        } else {
            items(closings.take(5), key = { it.id }) { c ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column {
                            Text(c.transactionNumber, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                "${c.transactionDate} · ${c.recordedByName}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text(
                                text = Formatters.formatRupiah(c.actualCash),
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = ClosingMath.statusLabel(c.status),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                }
            }
        }
    }
}
