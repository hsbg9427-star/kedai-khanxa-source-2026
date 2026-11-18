package com.kedaikhanxa.app.utils

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.kedaikhanxa.app.model.Sale
import com.kedaikhanxa.app.model.SaleCartItem
import com.kedaikhanxa.app.model.StoreSetting
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.charset.Charset
import java.util.UUID

object BluetoothPrinterHelper {
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    fun hasBluetoothPermission(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    @SuppressLint("MissingPermission")
    fun getPairedPrinters(context: Context): List<BluetoothDevice> {
        if (!hasBluetoothPermission(context)) return emptyList()
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter = manager?.adapter ?: return emptyList()
        if (!adapter.isEnabled) return emptyList()
        return adapter.bondedDevices?.toList().orEmpty()
    }

    fun buildReceiptEscPosText(
        store: StoreSetting,
        sale: Sale,
        items: List<SaleCartItem>
    ): String {
        val line = "--------------------------------"
        val sb = StringBuilder()
        sb.appendLine(store.storeName.ifBlank { "KEDAI KHANXA" })
        if (store.address.isNotBlank()) sb.appendLine(store.address)
        if (store.phone.isNotBlank()) sb.appendLine("Telp: ${store.phone}")
        sb.appendLine(line)
        sb.appendLine("No    : ${sale.transactionNumber}")
        sb.appendLine("Tgl   : ${sale.transactionDate} ${sale.transactionTime}")
        sb.appendLine("Kasir : ${sale.recordedByName}")
        if (!sale.customerName.isNullOrBlank()) {
            sb.appendLine("Plg   : ${sale.customerName}")
        }
        sb.appendLine(line)
        for (item in items) {
            sb.appendLine(item.product.name)
            sb.appendLine(
                "  ${item.quantity.toInt()} ${item.unitName} x ${Formatters.formatRupiah(item.unitPrice)} = ${Formatters.formatRupiah(item.subtotal)}"
            )
        }
        sb.appendLine(line)
        sb.appendLine("Total   : ${Formatters.formatRupiah(sale.totalAmount)}")
        sb.appendLine("Metode  : ${Formatters.paymentMethodLabel(sale.paymentMethod)}")
        sb.appendLine("Dibayar : ${Formatters.formatRupiah(sale.paidAmount)}")
        if (sale.changeAmount > 0) {
            sb.appendLine("Kembali : ${Formatters.formatRupiah(sale.changeAmount)}")
        }
        if (sale.debtAmount > 0) {
            sb.appendLine("Piutang : ${Formatters.formatRupiah(sale.debtAmount)}")
        }
        sb.appendLine(line)
        sb.appendLine(store.receiptFooter.ifBlank { "Terima kasih telah berbelanja" })
        sb.appendLine("\n\n")
        return sb.toString()
    }

    @SuppressLint("MissingPermission")
    suspend fun printText(
        context: Context,
        device: BluetoothDevice,
        text: String
    ): Result<Unit> = withContext(Dispatchers.IO) {
        if (!hasBluetoothPermission(context)) {
            return@withContext Result.failure(Exception("Izin Bluetooth belum diberikan."))
        }
        runCatching {
            val socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
            socket.use { sock ->
                sock.connect()
                val initCmd = byteArrayOf(0x1B, 0x40) // ESC @ Initialize printer
                val cutFeed = byteArrayOf(0x0A, 0x0A, 0x0A)
                val out = sock.outputStream
                out.write(initCmd)
                out.write(text.toByteArray(Charset.forName("UTF-8")))
                out.write(cutFeed)
                out.flush()
            }
        }
    }
}
