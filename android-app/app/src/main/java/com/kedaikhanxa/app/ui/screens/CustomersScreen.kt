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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.kedaikhanxa.app.model.Customer
import com.kedaikhanxa.app.utils.Formatters
import kotlinx.coroutines.launch

@Composable
fun CustomersScreen(
    customers: List<Customer>,
    accounts: List<Account>,
    onCreateCustomer: suspend (name: String, phone: String, address: String, notes: String) -> Result<Unit>,
    onUpdateCustomer: suspend (id: String, name: String, phone: String, address: String, notes: String) -> Result<Unit>,
    onPayDebt: suspend (customer: Customer, amount: Double, account: Account, notes: String) -> Result<Unit>
) {
    val scope = rememberCoroutineScope()
    var search by remember { mutableStateOf("") }
    var feedback by remember { mutableStateOf<String?>(null) }

    var editingCustomer by remember { mutableStateOf<Customer?>(null) }
    var showCustomerForm by remember { mutableStateOf(false) }
    var formName by remember { mutableStateOf("") }
    var formPhone by remember { mutableStateOf("") }
    var formAddress by remember { mutableStateOf("") }
    var formNotes by remember { mutableStateOf("") }

    var payingCustomer by remember { mutableStateOf<Customer?>(null) }
    var payAmount by remember { mutableStateOf("") }
    var payAccountId by remember(accounts) {
        mutableStateOf(accounts.firstOrNull { it.isActive && it.type == "cash" }?.id ?: accounts.firstOrNull()?.id ?: "")
    }
    var payNotes by remember { mutableStateOf("") }

    val filtered = remember(customers, search) {
        val q = search.trim().lowercase()
        customers.filter { q.isEmpty() || it.name.lowercase().contains(q) || it.phone.contains(q) }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = search,
                    onValueChange = { search = it },
                    label = { Text("Cari nama / HP pelanggan") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
                Button(onClick = {
                    editingCustomer = null
                    formName = ""
                    formPhone = ""
                    formAddress = ""
                    formNotes = ""
                    showCustomerForm = true
                }) {
                    Icon(Icons.Default.Add, contentDescription = null)
                    Text(" Baru")
                }
            }
        }

        if (!feedback.isNullOrBlank()) {
            item {
                Text(feedback ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
        }

        items(filtered, key = { it.id }) { c ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(c.name, fontWeight = FontWeight.Bold)
                            if (c.phone.isNotBlank()) {
                                Text(c.phone, style = MaterialTheme.typography.labelSmall)
                            }
                            if (c.address.isNotBlank()) {
                                Text(c.address, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        IconButton(onClick = {
                            editingCustomer = c
                            formName = c.name
                            formPhone = c.phone
                            formAddress = c.address
                            formNotes = c.notes
                            showCustomerForm = true
                        }) {
                            Icon(Icons.Default.Edit, contentDescription = "Edit Profil")
                        }
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "Piutang: ${Formatters.formatRupiah(c.totalDebt)}",
                            fontWeight = FontWeight.SemiBold,
                            color = if (c.totalDebt > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
                        )
                        if (c.totalDebt > 0) {
                            OutlinedButton(onClick = {
                                payingCustomer = c
                                payAmount = c.totalDebt.toLong().toString()
                                payNotes = ""
                            }) {
                                Text("Bayar Piutang")
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCustomerForm) {
        AlertDialog(
            onDismissRequest = { showCustomerForm = false },
            title = { Text(if (editingCustomer == null) "Tambah Pelanggan" else "Edit Profil Pelanggan") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = formName, onValueChange = { formName = it }, label = { Text("Nama*") }, singleLine = true)
                    OutlinedTextField(value = formPhone, onValueChange = { formPhone = it }, label = { Text("No. Telepon") }, singleLine = true)
                    OutlinedTextField(value = formAddress, onValueChange = { formAddress = it }, label = { Text("Alamat") })
                    OutlinedTextField(value = formNotes, onValueChange = { formNotes = it }, label = { Text("Catatan") })
                }
            },
            confirmButton = {
                Button(onClick = {
                    scope.launch {
                        val target = editingCustomer
                        val res = if (target == null) {
                            onCreateCustomer(formName, formPhone, formAddress, formNotes)
                        } else {
                            onUpdateCustomer(target.id, formName, formPhone, formAddress, formNotes)
                        }
                        res.onSuccess {
                            feedback = if (target == null) "Pelanggan ditambahkan." else "Profil pelanggan diperbarui."
                            showCustomerForm = false
                        }.onFailure { err ->
                            feedback = err.message ?: "Gagal menyimpan pelanggan."
                        }
                    }
                }) {
                    Text("Simpan")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCustomerForm = false }) { Text("Batal") }
            }
        )
    }

    if (payingCustomer != null) {
        val cust = payingCustomer!!
        AlertDialog(
            onDismissRequest = { payingCustomer = null },
            title = { Text("Bayar Piutang · ${cust.name}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Sisa piutang: ${Formatters.formatRupiah(cust.totalDebt)}")
                    OutlinedTextField(
                        value = payAmount,
                        onValueChange = { payAmount = it.filter { ch -> ch.isDigit() } },
                        label = { Text("Nominal Bayar (Rp)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        accounts.filter { it.isActive }.take(3).forEach { acc ->
                            FilterChip(
                                selected = payAccountId == acc.id,
                                onClick = { payAccountId = acc.id },
                                label = { Text(acc.name) }
                            )
                        }
                    }
                    OutlinedTextField(value = payNotes, onValueChange = { payNotes = it }, label = { Text("Catatan") })
                }
            },
            confirmButton = {
                Button(onClick = {
                    scope.launch {
                        val acc = accounts.firstOrNull { it.id == payAccountId } ?: accounts.firstOrNull()
                        if (acc == null) return@launch
                        val res = onPayDebt(cust, payAmount.toDoubleOrNull() ?: 0.0, acc, payNotes)
                        res.onSuccess {
                            feedback = "Pembayaran piutang berhasil dicatat."
                            payingCustomer = null
                        }.onFailure { err ->
                            feedback = err.message ?: "Gagal mencatat pembayaran."
                        }
                    }
                }) {
                    Text("Simpan Pembayaran")
                }
            },
            dismissButton = {
                TextButton(onClick = { payingCustomer = null }) { Text("Batal") }
            }
        )
    }
}
