package com.kedaikhanxa.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.kedaikhanxa.app.model.Account
import com.kedaikhanxa.app.model.Customer
import com.kedaikhanxa.app.model.Product
import com.kedaikhanxa.app.model.Sale
import com.kedaikhanxa.app.model.SaleCartItem
import com.kedaikhanxa.app.model.StoreSetting
import com.kedaikhanxa.app.ui.components.BarcodeScannerDialog
import com.kedaikhanxa.app.utils.BluetoothPrinterHelper
import com.kedaikhanxa.app.utils.Formatters
import kotlinx.coroutines.launch

@Composable
fun PosScreen(
    isAdmin: Boolean,
    products: List<Product>,
    accounts: List<Account>,
    customers: List<Customer>,
    storeSetting: StoreSetting,
    onSubmitSale: suspend (
        cart: List<SaleCartItem>,
        discount: Double,
        paymentMethod: String,
        paidAmount: Double,
        account: Account?,
        customer: Customer?
    ) -> Result<Sale>
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var searchQuery by remember { mutableStateOf("") }
    var showScanner by remember { mutableStateOf(false) }
    var cart by remember { mutableStateOf<List<SaleCartItem>>(emptyList()) }
    var paymentMethod by remember { mutableStateOf("cash") }
    var paidInput by remember { mutableStateOf("") }
    var discountInput by remember { mutableStateOf("0") }
    var selectedAccountId by remember(accounts) {
        mutableStateOf(accounts.firstOrNull { it.isActive && it.type == "cash" }?.id ?: accounts.firstOrNull()?.id)
    }
    var selectedCustomerId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var lastCompletedSale by remember { mutableStateOf<Pair<Sale, List<SaleCartItem>>?>(null) }
    var showPrintDialog by remember { mutableStateOf(false) }

    val filteredProducts = remember(products, searchQuery) {
        val q = searchQuery.trim().lowercase()
        products.filter { it.isActive && it.stock > 0 }.filter { p ->
            q.isEmpty() ||
                p.name.lowercase().contains(q) ||
                p.sku.lowercase().contains(q) ||
                (p.barcode ?: "").lowercase().contains(q)
        }.take(40)
    }

    val subtotal = cart.sumOf { it.subtotal }
    val discount = (discountInput.toDoubleOrNull() ?: 0.0).coerceIn(0.0, subtotal)
    val totalAmount = (subtotal - discount).coerceAtLeast(0.0)
    val estProfit = cart.sumOf { it.profit } - discount

    val addToCart: (Product) -> Unit = { product ->
        val idx = cart.indexOfFirst { it.product.id == product.id && it.unitName == product.unit }
        if (idx >= 0) {
            val existing = cart[idx]
            if (existing.baseQuantity + 1.0 <= product.stock) {
                cart = cart.toMutableList().also {
                    it[idx] = existing.copy(quantity = existing.quantity + 1.0)
                }
            } else {
                feedback = "Stok ${product.name} tidak mencukupi."
            }
        } else {
            cart = cart + SaleCartItem(
                product = product,
                unitName = product.unit,
                conversion = 1.0,
                quantity = 1.0,
                unitPrice = product.sellPrice
            )
        }
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    label = { Text("Cari nama produk / SKU / barcode") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
                OutlinedButton(
                    onClick = { showScanner = true },
                    modifier = Modifier.height(54.dp)
                ) {
                    Icon(Icons.Default.QrCodeScanner, contentDescription = "Scan")
                }
            }
        }

        if (!feedback.isNullOrBlank()) {
            item {
                Card {
                    Text(
                        text = feedback ?: "",
                        modifier = Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }
        }

        // Daftar Produk Aktif
        items(filteredProducts, key = { it.id }) { p ->
            Card(
                onClick = { addToCart(p) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(p.name, fontWeight = FontWeight.SemiBold)
                        Text(
                            "Stok: ${p.stock.toInt()} ${p.unit} · ${p.categoryName}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            Formatters.formatRupiah(p.sellPrice),
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )
                        // HPP hanya terlihat oleh Admin, TIDAK PERNAH ditampilkan ke Kasir
                        if (isAdmin) {
                            Text(
                                "HPP ${Formatters.formatRupiah(p.costPrice)}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }

        // Keranjang & Checkout
        if (cart.isNotEmpty()) {
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Keranjang (${cart.size} item)", fontWeight = FontWeight.Bold)
                        HorizontalDivider()

                        cart.forEachIndexed { idx, item ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(item.product.name, style = MaterialTheme.typography.bodyMedium)
                                    Text(
                                        "${item.quantity.toInt()} ${item.unitName} x ${Formatters.formatRupiah(item.unitPrice)}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                IconButton(onClick = {
                                    cart = if (item.quantity <= 1.0) {
                                        cart.filterIndexed { i, _ -> i != idx }
                                    } else {
                                        cart.toMutableList().also {
                                            it[idx] = item.copy(quantity = item.quantity - 1.0)
                                        }
                                    }
                                }) {
                                    Icon(Icons.Default.Remove, contentDescription = "Kurangi")
                                }
                                IconButton(onClick = { addToCart(item.product) }) {
                                    Icon(Icons.Default.Add, contentDescription = "Tambah")
                                }
                                IconButton(onClick = {
                                    cart = cart.filterIndexed { i, _ -> i != idx }
                                }) {
                                    Icon(Icons.Default.Delete, contentDescription = "Hapus")
                                }
                            }
                        }

                        HorizontalDivider()
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Total Tagihan", fontWeight = FontWeight.Bold)
                            Text(
                                Formatters.formatRupiah(totalAmount),
                                fontWeight = FontWeight.Bold,
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                        if (isAdmin) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Estimasi Laba (Admin)", style = MaterialTheme.typography.labelSmall)
                                Text(Formatters.formatRupiah(estProfit), style = MaterialTheme.typography.labelSmall)
                            }
                        }

                        Text("Metode Pembayaran", style = MaterialTheme.typography.labelMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf("cash" to "Tunai", "qris" to "QRIS", "transfer" to "Transfer", "debt" to "Kasbon")
                                .forEach { (code, label) ->
                                    FilterChip(
                                        selected = paymentMethod == code,
                                        onClick = { paymentMethod = code },
                                        label = { Text(label) }
                                    )
                                }
                        }

                        if (paymentMethod == "debt") {
                            Text("Pilih Pelanggan Kasbon:", style = MaterialTheme.typography.labelSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                customers.take(6).forEach { c ->
                                    FilterChip(
                                        selected = selectedCustomerId == c.id,
                                        onClick = { selectedCustomerId = c.id },
                                        label = { Text(c.name) }
                                    )
                                }
                            }
                        }

                        OutlinedTextField(
                            value = paidInput,
                            onValueChange = { paidInput = it.filter { ch -> ch.isDigit() } },
                            label = {
                                Text(
                                    if (paymentMethod == "debt") "DP Tunai (opsional)"
                                    else "Uang Diterima"
                                )
                            },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )

                        Text("Akun Penerima:", style = MaterialTheme.typography.labelSmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            accounts.filter { it.isActive }.take(4).forEach { acc ->
                                FilterChip(
                                    selected = selectedAccountId == acc.id,
                                    onClick = { selectedAccountId = acc.id },
                                    label = { Text(acc.name) }
                                )
                            }
                        }

                        Button(
                            onClick = {
                                scope.launch {
                                    busy = true
                                    val acc = accounts.firstOrNull { it.id == selectedAccountId }
                                    val cust = customers.firstOrNull { it.id == selectedCustomerId }
                                    val paidVal = if (paymentMethod == "qris" || paymentMethod == "transfer") {
                                        totalAmount
                                    } else {
                                        paidInput.toDoubleOrNull() ?: if (paymentMethod == "cash") totalAmount else 0.0
                                    }
                                    val snapshotCart = cart.toList()
                                    val res = onSubmitSale(snapshotCart, discount, paymentMethod, paidVal, acc, cust)
                                    res.onSuccess { savedSale ->
                                        lastCompletedSale = savedSale to snapshotCart
                                        cart = emptyList()
                                        paidInput = ""
                                        feedback = "Transaksi ${savedSale.transactionNumber} tersimpan (${Formatters.formatRupiah(savedSale.totalAmount)})."
                                    }.onFailure { err ->
                                        feedback = err.message ?: "Gagal menyimpan penjualan."
                                    }
                                    busy = false
                                }
                            },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(if (busy) "Menyimpan..." else "Simpan & Selesaikan Transaksi")
                        }
                    }
                }
            }
        }

        if (lastCompletedSale != null) {
            item {
                OutlinedButton(
                    onClick = { showPrintDialog = true },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.Print, contentDescription = null)
                    Text(" Cetak Struk Terakhir (${lastCompletedSale!!.first.transactionNumber})")
                }
            }
        }
    }

    if (showScanner) {
        BarcodeScannerDialog(
            onScanned = { code ->
                showScanner = false
                val matched = products.firstOrNull {
                    (it.barcode ?: "").equals(code, ignoreCase = true) || it.sku.equals(code, ignoreCase = true)
                }
                if (matched != null && matched.stock > 0) {
                    addToCart(matched)
                    feedback = "Barcode $code ditambahkan: ${matched.name}"
                } else {
                    searchQuery = code
                    feedback = "Produk dengan barcode $code tidak ditemukan atau stok habis."
                }
            },
            onDismiss = { showScanner = false }
        )
    }

    if (showPrintDialog && lastCompletedSale != null) {
        val (saleObj, itemsObj) = lastCompletedSale!!
        val pairedPrinters = remember { BluetoothPrinterHelper.getPairedPrinters(context) }
        AlertDialog(
            onDismissRequest = { showPrintDialog = false },
            title = { Text("Cetak Struk Bluetooth") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (pairedPrinters.isEmpty()) {
                        Text("Tidak ada printer Bluetooth ter-pair atau izin Bluetooth belum aktif.")
                    } else {
                        pairedPrinters.forEach { dev ->
                            OutlinedButton(
                                onClick = {
                                    scope.launch {
                                        val txt = BluetoothPrinterHelper.buildReceiptEscPosText(
                                            storeSetting,
                                            saleObj,
                                            itemsObj
                                        )
                                        val r = BluetoothPrinterHelper.printText(context, dev, txt)
                                        feedback = if (r.isSuccess) "Struk berhasil dicetak ke printer."
                                        else "Gagal cetak: ${r.exceptionOrNull()?.message}"
                                        showPrintDialog = false
                                    }
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text(dev.name ?: dev.address)
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showPrintDialog = false }) { Text("Tutup") }
            }
        )
    }
}
