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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.kedaikhanxa.app.model.Account
import com.kedaikhanxa.app.model.MiniAtmTransaction
import com.kedaikhanxa.app.model.PpobTransaction
import com.kedaikhanxa.app.utils.Formatters
import kotlinx.coroutines.launch

@Composable
fun MiniAtmScreen(
    isAdmin: Boolean,
    accounts: List<Account>,
    transactions: List<MiniAtmTransaction>,
    onSubmitMiniAtm: suspend (
        serviceType: String,
        bankName: String,
        customerName: String,
        targetAccNo: String,
        principal: Double,
        adminFee: Double,
        bankFee: Double,
        cashAcc: Account,
        bankAcc: Account
    ) -> Result<String>
) {
    val scope = rememberCoroutineScope()
    val cashAccounts = remember(accounts) { accounts.filter { it.isActive && it.type == "cash" } }
    val bankAccounts = remember(accounts) { accounts.filter { it.isActive && (it.type == "bank" || it.type == "ewallet") } }

    var serviceType by remember { mutableStateOf("tarik_tunai") }
    var bankName by remember { mutableStateOf("BRI") }
    var customerName by remember { mutableStateOf("") }
    var targetAccountNo by remember { mutableStateOf("") }
    var principalInput by remember { mutableStateOf("") }
    var adminFeeInput by remember { mutableStateOf("5000") }
    var bankFeeInput by remember { mutableStateOf("0") }
    var cashAccId by remember(cashAccounts) { mutableStateOf(cashAccounts.firstOrNull()?.id ?: "") }
    var bankAccId by remember(bankAccounts) { mutableStateOf(bankAccounts.firstOrNull()?.id ?: "") }
    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Catat Transaksi Mini ATM", fontWeight = FontWeight.Bold)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = serviceType == "tarik_tunai",
                            onClick = { serviceType = "tarik_tunai" },
                            label = { Text("Tarik Tunai") }
                        )
                        FilterChip(
                            selected = serviceType == "transfer",
                            onClick = { serviceType = "transfer" },
                            label = { Text("Transfer Bank") }
                        )
                    }
                    OutlinedTextField(
                        value = bankName,
                        onValueChange = { bankName = it },
                        label = { Text("Bank Tujuan / Asal") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = customerName,
                        onValueChange = { customerName = it },
                        label = { Text("Nama Pelanggan / Penerima") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (serviceType == "transfer") {
                        OutlinedTextField(
                            value = targetAccountNo,
                            onValueChange = { targetAccountNo = it },
                            label = { Text("No. Rekening Tujuan") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                    OutlinedTextField(
                        value = principalInput,
                        onValueChange = { principalInput = it.filter { ch -> ch.isDigit() } },
                        label = { Text("Nominal Pokok (Rp)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = adminFeeInput,
                            onValueChange = { adminFeeInput = it.filter { ch -> ch.isDigit() } },
                            label = { Text("Biaya Jasa") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = bankFeeInput,
                            onValueChange = { bankFeeInput = it.filter { ch -> ch.isDigit() } },
                            label = { Text("Biaya Bank") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }
                    if (!feedback.isNullOrBlank()) {
                        Text(feedback ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                busy = true
                                val cashAcc = cashAccounts.firstOrNull { it.id == cashAccId } ?: cashAccounts.firstOrNull()
                                val bankAcc = bankAccounts.firstOrNull { it.id == bankAccId } ?: bankAccounts.firstOrNull()
                                if (cashAcc == null || bankAcc == null) {
                                    feedback = "Akun Laci Kas dan Rekening Bank aktif wajib tersedia."
                                    busy = false
                                    return@launch
                                }
                                val res = onSubmitMiniAtm(
                                    serviceType,
                                    bankName,
                                    customerName,
                                    targetAccountNo,
                                    principalInput.toDoubleOrNull() ?: 0.0,
                                    adminFeeInput.toDoubleOrNull() ?: 0.0,
                                    bankFeeInput.toDoubleOrNull() ?: 0.0,
                                    cashAcc,
                                    bankAcc
                                )
                                res.onSuccess { trxNo ->
                                    feedback = "Transaksi Mini ATM $trxNo berhasil dicatat."
                                    principalInput = ""
                                    customerName = ""
                                    targetAccountNo = ""
                                }.onFailure { err ->
                                    feedback = err.message ?: "Gagal menyimpan Mini ATM."
                                }
                                busy = false
                            }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(if (busy) "Menyimpan..." else "Simpan Transaksi Mini ATM")
                    }
                }
            }
        }

        item {
            Text(
                text = if (isAdmin) "Riwayat Mini ATM Toko" else "Riwayat Mini ATM Saya",
                fontWeight = FontWeight.Bold
            )
        }
        items(transactions.take(25), key = { it.id }) { tx ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column {
                        Text("${tx.transactionNumber} · ${tx.bankName}", fontWeight = FontWeight.SemiBold)
                        Text("${tx.transactionDate} ${tx.transactionTime}", style = MaterialTheme.typography.labelSmall)
                    }
                    Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                        Text(Formatters.formatRupiah(tx.principalAmount), fontWeight = FontWeight.Bold)
                        Text("Jasa ${Formatters.formatRupiah(tx.adminFee)}", style = MaterialTheme.typography.labelSmall)
                        // Laba bersih hanya ditampilkan ke Admin
                        if (isAdmin) {
                            Text(
                                "Laba ${Formatters.formatRupiah(tx.netProfit)}",
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

@Composable
fun PpobScreen(
    isAdmin: Boolean,
    accounts: List<Account>,
    transactions: List<PpobTransaction>,
    onSubmitPpob: suspend (
        category: String,
        providerName: String,
        targetNumber: String,
        capitalPrice: Double,
        sellPrice: Double,
        adminFee: Double,
        depositAcc: Account,
        cashAcc: Account
    ) -> Result<String>
) {
    val scope = rememberCoroutineScope()
    val depositAccounts = remember(accounts) {
        accounts.filter { it.isActive && (it.type == "ppob_deposit" || it.type == "bank" || it.type == "ewallet") }
    }
    val receiptAccounts = remember(accounts) { accounts.filter { it.isActive } }

    var category by remember { mutableStateOf("pulsa") }
    var providerName by remember { mutableStateOf("Telkomsel") }
    var targetNumber by remember { mutableStateOf("") }
    var capitalInput by remember { mutableStateOf("") }
    var sellInput by remember { mutableStateOf("") }
    var adminFeeInput by remember { mutableStateOf("0") }
    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Catat Transaksi PPOB", fontWeight = FontWeight.Bold)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("pulsa" to "Pulsa", "paket_data" to "Data", "pln" to "PLN", "ewallet" to "E-Wallet")
                            .forEach { (id, label) ->
                                FilterChip(
                                    selected = category == id,
                                    onClick = { category = id },
                                    label = { Text(label) }
                                )
                            }
                    }
                    OutlinedTextField(
                        value = providerName,
                        onValueChange = { providerName = it },
                        label = { Text("Provider / Produk") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = targetNumber,
                        onValueChange = { targetNumber = it },
                        label = { Text("Nomor Tujuan / ID Pelanggan") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = capitalInput,
                            onValueChange = { capitalInput = it.filter { ch -> ch.isDigit() } },
                            label = { Text("Modal Deposit") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        OutlinedTextField(
                            value = sellInput,
                            onValueChange = { sellInput = it.filter { ch -> ch.isDigit() } },
                            label = { Text("Harga Jual") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                    }
                    OutlinedTextField(
                        value = adminFeeInput,
                        onValueChange = { adminFeeInput = it.filter { ch -> ch.isDigit() } },
                        label = { Text("Biaya Admin") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (!feedback.isNullOrBlank()) {
                        Text(feedback ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                busy = true
                                val dep = depositAccounts.firstOrNull()
                                val cash = receiptAccounts.firstOrNull { it.type == "cash" } ?: receiptAccounts.firstOrNull()
                                if (dep == null || cash == null) {
                                    feedback = "Akun deposit PPOB & akun penerima bayar aktif harus tersedia."
                                    busy = false
                                    return@launch
                                }
                                val res = onSubmitPpob(
                                    category,
                                    providerName,
                                    targetNumber,
                                    capitalInput.toDoubleOrNull() ?: 0.0,
                                    sellInput.toDoubleOrNull() ?: 0.0,
                                    adminFeeInput.toDoubleOrNull() ?: 0.0,
                                    dep,
                                    cash
                                )
                                res.onSuccess { trxNo ->
                                    feedback = "Transaksi PPOB $trxNo berhasil dicatat."
                                    targetNumber = ""
                                    capitalInput = ""
                                    sellInput = ""
                                }.onFailure { err ->
                                    feedback = err.message ?: "Gagal menyimpan PPOB."
                                }
                                busy = false
                            }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(if (busy) "Menyimpan..." else "Simpan Transaksi PPOB")
                    }
                }
            }
        }

        item {
            Text(
                text = if (isAdmin) "Riwayat PPOB Toko" else "Riwayat PPOB Saya",
                fontWeight = FontWeight.Bold
            )
        }
        items(transactions.take(25), key = { it.id }) { tx ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column {
                        Text("${tx.transactionNumber} · ${tx.providerName}", fontWeight = FontWeight.SemiBold)
                        Text(tx.targetNumber, style = MaterialTheme.typography.labelSmall)
                    }
                    Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                        Text(Formatters.formatRupiah(tx.sellPrice + tx.adminFee), fontWeight = FontWeight.Bold)
                        // Modal & laba hanya terlihat oleh Admin
                        if (isAdmin) {
                            Text(
                                "Laba ${Formatters.formatRupiah(tx.netProfit)}",
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
