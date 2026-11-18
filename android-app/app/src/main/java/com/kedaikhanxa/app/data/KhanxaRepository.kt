package com.kedaikhanxa.app.data

import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import com.kedaikhanxa.app.config.FirebaseModule
import com.kedaikhanxa.app.model.Account
import com.kedaikhanxa.app.model.CashierClosing
import com.kedaikhanxa.app.model.CashierClosingBreakdown
import com.kedaikhanxa.app.model.Customer
import com.kedaikhanxa.app.model.MiniAtmTransaction
import com.kedaikhanxa.app.model.PpobTransaction
import com.kedaikhanxa.app.model.Product
import com.kedaikhanxa.app.model.Receivable
import com.kedaikhanxa.app.model.Sale
import com.kedaikhanxa.app.model.SaleCartItem
import com.kedaikhanxa.app.model.SellUnit
import com.kedaikhanxa.app.model.StoreSetting
import com.kedaikhanxa.app.utils.ClosingMath
import com.kedaikhanxa.app.utils.Formatters
import kotlinx.coroutines.tasks.await
import kotlin.math.max

class KhanxaRepository {
    private val db = FirebaseModule.db

    fun observeStoreSettings(onUpdate: (StoreSetting) -> Unit): ListenerRegistration {
        return db.collection("store_settings").document("main")
            .addSnapshotListener { snap, _ ->
                if (snap != null && snap.exists()) {
                    onUpdate(
                        StoreSetting(
                            storeName = snap.getString("storeName") ?: "KEDAI KHANXA",
                            ownerName = snap.getString("ownerName") ?: "Admin",
                            address = snap.getString("address") ?: "",
                            phone = snap.getString("phone") ?: "",
                            receiptFooter = snap.getString("receiptFooter")
                                ?: "Terima kasih telah berbelanja di Kedai Khanxa",
                            qrisFeePercent = snap.getDouble("qrisFeePercent") ?: 0.7
                        )
                    )
                }
            }
    }

    fun observeAccounts(onUpdate: (List<Account>) -> Unit): ListenerRegistration {
        return db.collection("accounts")
            .limit(50)
            .addSnapshotListener { snap, _ ->
                if (snap == null) return@addSnapshotListener
                val items = snap.documents.map { d ->
                    Account(
                        id = d.id,
                        name = d.getString("name") ?: "",
                        type = d.getString("type") ?: "cash",
                        accountNumber = d.getString("accountNumber"),
                        balance = d.getDouble("balance") ?: 0.0,
                        isActive = d.getBoolean("isActive") ?: true
                    )
                }.sortedBy { it.name }
                onUpdate(items)
            }
    }

    fun observeProducts(onUpdate: (List<Product>) -> Unit): ListenerRegistration {
        return db.collection("products")
            .limit(400)
            .addSnapshotListener { snap, _ ->
                if (snap == null) return@addSnapshotListener
                val items = snap.documents.map { d ->
                    @Suppress("UNCHECKED_CAST")
                    val rawUnits = (d.get("sellUnits") as? List<Map<String, Any?>>).orEmpty()
                    val sellUnits = rawUnits.map { u ->
                        SellUnit(
                            unitName = (u["unitName"] as? String) ?: "",
                            conversion = (u["conversion"] as? Number)?.toDouble() ?: 1.0,
                            buyPrice = (u["buyPrice"] as? Number)?.toDouble(),
                            sellPrice = (u["sellPrice"] as? Number)?.toDouble() ?: 0.0,
                            wholesalePrice = (u["wholesalePrice"] as? Number)?.toDouble(),
                            wholesaleMinQty = (u["wholesaleMinQty"] as? Number)?.toDouble(),
                            canBuy = u["canBuy"] as? Boolean,
                            canSell = u["canSell"] as? Boolean,
                            conversionMode = u["conversionMode"] as? String,
                            perBaseQty = (u["perBaseQty"] as? Number)?.toDouble()
                        )
                    }
                    Product(
                        id = d.id,
                        sku = d.getString("sku") ?: "",
                        barcode = d.getString("barcode"),
                        name = d.getString("name") ?: "",
                        brand = d.getString("brand"),
                        variant = d.getString("variant"),
                        categoryId = d.getString("categoryId") ?: "",
                        categoryName = d.getString("categoryName") ?: "",
                        unit = d.getString("unit") ?: "PCS",
                        baseCanSell = d.getBoolean("baseCanSell") ?: true,
                        costPrice = d.getDouble("costPrice") ?: 0.0,
                        sellPrice = d.getDouble("sellPrice") ?: 0.0,
                        wholesalePrice = d.getDouble("wholesalePrice"),
                        wholesaleMinQty = d.getDouble("wholesaleMinQty"),
                        sellUnits = sellUnits,
                        stock = d.getDouble("stock") ?: 0.0,
                        minStock = d.getDouble("minStock") ?: 0.0,
                        isActive = d.getBoolean("isActive") ?: true
                    )
                }.sortedBy { it.name.lowercase() }
                onUpdate(items)
            }
    }

    fun observeCustomers(onUpdate: (List<Customer>) -> Unit): ListenerRegistration {
        return db.collection("customers")
            .limit(300)
            .addSnapshotListener { snap, _ ->
                if (snap == null) return@addSnapshotListener
                val items = snap.documents.map { d ->
                    Customer(
                        id = d.id,
                        name = d.getString("name") ?: "",
                        phone = d.getString("phone") ?: "",
                        address = d.getString("address") ?: "",
                        totalDebt = d.getDouble("totalDebt") ?: 0.0,
                        notes = d.getString("notes") ?: ""
                    )
                }.sortedBy { it.name.lowercase() }
                onUpdate(items)
            }
    }

    fun observeSales(isAdmin: Boolean, userUid: String, onUpdate: (List<Sale>) -> Unit): ListenerRegistration {
        val q: Query = if (isAdmin) {
            db.collection("sales").orderBy("createdAt", Query.Direction.DESCENDING).limit(200)
        } else {
            db.collection("sales").whereEqualTo("recordedByUid", userUid).limit(150)
        }
        return q.addSnapshotListener { snap, _ ->
            if (snap == null) return@addSnapshotListener
            val list = snap.documents.map { d ->
                Sale(
                    id = d.id,
                    transactionNumber = d.getString("transactionNumber") ?: "",
                    transactionDate = d.getString("transactionDate") ?: "",
                    transactionTime = d.getString("transactionTime") ?: "",
                    customerId = d.getString("customerId"),
                    customerName = d.getString("customerName"),
                    totalItems = (d.getLong("totalItems") ?: 0L).toInt(),
                    subtotal = d.getDouble("subtotal") ?: 0.0,
                    discount = d.getDouble("discount") ?: 0.0,
                    totalAmount = d.getDouble("totalAmount") ?: 0.0,
                    totalCost = d.getDouble("totalCost") ?: 0.0,
                    totalProfit = d.getDouble("totalProfit") ?: 0.0,
                    paidAmount = d.getDouble("paidAmount") ?: 0.0,
                    changeAmount = d.getDouble("changeAmount") ?: 0.0,
                    debtAmount = d.getDouble("debtAmount") ?: 0.0,
                    paymentMethod = d.getString("paymentMethod") ?: "cash",
                    cashPaidPart = d.getDouble("cashPaidPart"),
                    qrisAmount = d.getDouble("qrisAmount"),
                    accountId = d.getString("accountId"),
                    qrisAccountId = d.getString("qrisAccountId"),
                    status = d.getString("status") ?: "completed",
                    recordedByUid = d.getString("recordedByUid") ?: "",
                    recordedByName = d.getString("recordedByName") ?: ""
                )
            }.sortedByDescending { "${it.transactionDate} ${it.transactionTime}" }
            onUpdate(list)
        }
    }

    fun observeMiniAtm(isAdmin: Boolean, userUid: String, onUpdate: (List<MiniAtmTransaction>) -> Unit): ListenerRegistration {
        val q = if (isAdmin) {
            db.collection("mini_atm_transactions").orderBy("createdAt", Query.Direction.DESCENDING).limit(150)
        } else {
            db.collection("mini_atm_transactions").whereEqualTo("recordedByUid", userUid).limit(120)
        }
        return q.addSnapshotListener { snap, _ ->
            if (snap == null) return@addSnapshotListener
            val list = snap.documents.map { d ->
                MiniAtmTransaction(
                    id = d.id,
                    transactionNumber = d.getString("transactionNumber") ?: "",
                    transactionDate = d.getString("transactionDate") ?: "",
                    transactionTime = d.getString("transactionTime") ?: "",
                    serviceType = d.getString("serviceType") ?: "tarik_tunai",
                    paymentChannel = d.getString("paymentChannel") ?: "bank_transfer",
                    bankName = d.getString("bankName") ?: "",
                    targetAccountNumber = d.getString("targetAccountNumber") ?: "",
                    customerName = d.getString("customerName") ?: "",
                    principalAmount = d.getDouble("principalAmount") ?: 0.0,
                    adminFee = d.getDouble("adminFee") ?: 0.0,
                    bankFee = d.getDouble("bankFee") ?: 0.0,
                    internalExtraFee = d.getDouble("internalExtraFee") ?: 0.0,
                    netProfit = d.getDouble("netProfit") ?: 0.0,
                    cashAccountId = d.getString("cashAccountId") ?: "",
                    bankAccountId = d.getString("bankAccountId") ?: "",
                    status = d.getString("status") ?: "completed",
                    recordedByUid = d.getString("recordedByUid") ?: "",
                    recordedByName = d.getString("recordedByName") ?: ""
                )
            }.sortedByDescending { "${it.transactionDate} ${it.transactionTime}" }
            onUpdate(list)
        }
    }

    fun observePpob(isAdmin: Boolean, userUid: String, onUpdate: (List<PpobTransaction>) -> Unit): ListenerRegistration {
        val q = if (isAdmin) {
            db.collection("ppob_transactions").orderBy("createdAt", Query.Direction.DESCENDING).limit(150)
        } else {
            db.collection("ppob_transactions").whereEqualTo("recordedByUid", userUid).limit(120)
        }
        return q.addSnapshotListener { snap, _ ->
            if (snap == null) return@addSnapshotListener
            val list = snap.documents.map { d ->
                PpobTransaction(
                    id = d.id,
                    transactionNumber = d.getString("transactionNumber") ?: "",
                    transactionDate = d.getString("transactionDate") ?: "",
                    transactionTime = d.getString("transactionTime") ?: "",
                    category = d.getString("category") ?: "pulsa",
                    providerName = d.getString("providerName") ?: "",
                    targetNumber = d.getString("targetNumber") ?: "",
                    customerName = d.getString("customerName") ?: "",
                    capitalPrice = d.getDouble("capitalPrice") ?: 0.0,
                    sellPrice = d.getDouble("sellPrice") ?: 0.0,
                    adminFee = d.getDouble("adminFee") ?: 0.0,
                    netProfit = d.getDouble("netProfit") ?: 0.0,
                    accountId = d.getString("accountId") ?: "",
                    cashAccountId = d.getString("cashAccountId") ?: "",
                    serialNumber = d.getString("serialNumber") ?: "",
                    status = d.getString("status") ?: "completed",
                    recordedByUid = d.getString("recordedByUid") ?: "",
                    recordedByName = d.getString("recordedByName") ?: ""
                )
            }.sortedByDescending { "${it.transactionDate} ${it.transactionTime}" }
            onUpdate(list)
        }
    }

    fun observeReceivables(isAdmin: Boolean, userUid: String, onUpdate: (List<Receivable>) -> Unit): ListenerRegistration {
        val q = if (isAdmin) {
            db.collection("receivables").orderBy("createdAt", Query.Direction.DESCENDING).limit(200)
        } else {
            db.collection("receivables").whereEqualTo("recordedByUid", userUid).limit(150)
        }
        return q.addSnapshotListener { snap, _ ->
            if (snap == null) return@addSnapshotListener
            val list = snap.documents.map { d ->
                Receivable(
                    id = d.id,
                    transactionNumber = d.getString("transactionNumber") ?: "",
                    transactionDate = d.getString("transactionDate") ?: "",
                    transactionTime = d.getString("transactionTime") ?: "",
                    customerId = d.getString("customerId") ?: "",
                    customerName = d.getString("customerName") ?: "",
                    type = d.getString("type") ?: "debt",
                    amount = d.getDouble("amount") ?: 0.0,
                    balanceAfter = d.getDouble("balanceAfter") ?: 0.0,
                    saleId = d.getString("saleId"),
                    accountId = d.getString("accountId"),
                    notes = d.getString("notes") ?: "",
                    recordedByUid = d.getString("recordedByUid") ?: "",
                    recordedByName = d.getString("recordedByName") ?: ""
                )
            }.sortedByDescending { "${it.transactionDate} ${it.transactionTime}" }
            onUpdate(list)
        }
    }

    fun observeCashierClosings(isAdmin: Boolean, userUid: String, onUpdate: (List<CashierClosing>) -> Unit): ListenerRegistration {
        val q = if (isAdmin) {
            db.collection("cashier_closings").orderBy("createdAt", Query.Direction.DESCENDING).limit(150)
        } else {
            db.collection("cashier_closings").whereEqualTo("recordedByUid", userUid).limit(100)
        }
        return q.addSnapshotListener { snap, _ ->
            if (snap == null) return@addSnapshotListener
            val list = snap.documents.map { d ->
                CashierClosing(
                    id = d.id,
                    transactionNumber = d.getString("transactionNumber") ?: "",
                    transactionDate = d.getString("transactionDate") ?: "",
                    transactionTime = d.getString("transactionTime") ?: "",
                    shiftLabel = d.getString("shiftLabel") ?: "",
                    periodStartDate = d.getString("periodStartDate") ?: "",
                    periodEndDate = d.getString("periodEndDate") ?: "",
                    openingCash = d.getDouble("openingCash") ?: 0.0,
                    totalSalesAmount = d.getDouble("totalSalesAmount") ?: 0.0,
                    retailTxCount = (d.getLong("retailTxCount") ?: 0L).toInt(),
                    retailCashIn = d.getDouble("retailCashIn") ?: 0.0,
                    retailQrisTotal = d.getDouble("retailQrisTotal") ?: 0.0,
                    retailTransferTotal = d.getDouble("retailTransferTotal") ?: 0.0,
                    retailDebtCreatedTotal = d.getDouble("retailDebtCreatedTotal") ?: 0.0,
                    miniAtmTxCount = (d.getLong("miniAtmTxCount") ?: 0L).toInt(),
                    miniAtmCashIn = d.getDouble("miniAtmCashIn") ?: 0.0,
                    miniAtmCashOut = d.getDouble("miniAtmCashOut") ?: 0.0,
                    miniAtmNonCashTotal = d.getDouble("miniAtmNonCashTotal") ?: 0.0,
                    ppobTxCount = (d.getLong("ppobTxCount") ?: 0L).toInt(),
                    ppobCashIn = d.getDouble("ppobCashIn") ?: 0.0,
                    ppobNonCashTotal = d.getDouble("ppobNonCashTotal") ?: 0.0,
                    receivablePaymentCount = (d.getLong("receivablePaymentCount") ?: 0L).toInt(),
                    receivableCashIn = d.getDouble("receivableCashIn") ?: 0.0,
                    receivableNonCashIn = d.getDouble("receivableNonCashIn") ?: 0.0,
                    expectedCash = d.getDouble("expectedCash") ?: 0.0,
                    actualCash = d.getDouble("actualCash") ?: 0.0,
                    varianceAmount = d.getDouble("varianceAmount") ?: 0.0,
                    status = d.getString("status") ?: "balance",
                    notes = d.getString("notes") ?: "",
                    isFinalized = d.getBoolean("isFinalized") ?: true,
                    reviewStatus = d.getString("reviewStatus") ?: "pending",
                    reviewNote = d.getString("reviewNote") ?: "",
                    reviewedByUid = d.getString("reviewedByUid") ?: "",
                    reviewedByName = d.getString("reviewedByName") ?: "",
                    reviewedAtDate = d.getString("reviewedAtDate") ?: "",
                    recordedByUid = d.getString("recordedByUid") ?: "",
                    recordedByName = d.getString("recordedByName") ?: ""
                )
            }.sortedByDescending { "${it.transactionDate} ${it.transactionTime}" }
            onUpdate(list)
        }
    }

    suspend fun submitPosSale(
        cart: List<SaleCartItem>,
        discount: Double,
        paymentMethod: String, // cash | qris | transfer | debt
        paidAmountInput: Double,
        primaryAccount: Account?,
        customer: Customer?,
        userUid: String,
        userName: String
    ): Result<Sale> = runCatching {
        if (cart.isEmpty()) error("Keranjang belanja masih kosong.")
        val subtotal = Formatters.roundMoney(cart.sumOf { it.subtotal })
        val cleanDiscount = Formatters.roundMoney(max(0.0, minOf(discount, subtotal)))
        val totalAmount = Formatters.roundMoney(max(0.0, subtotal - cleanDiscount))
        val totalCost = Formatters.roundMoney(cart.sumOf { it.costTotal })
        val totalProfit = Formatters.roundMoney(totalAmount - totalCost)

        val paidAmount: Double
        val changeAmount: Double
        val debtAmount: Double
        when (paymentMethod) {
            "debt" -> {
                if (customer == null) error("Pelanggan wajib dipilih untuk transaksi Kasbon / Piutang.")
                paidAmount = Formatters.roundMoney(max(0.0, minOf(paidAmountInput, totalAmount)))
                changeAmount = 0.0
                debtAmount = Formatters.roundMoney(max(0.0, totalAmount - paidAmount))
            }
            "cash" -> {
                if (paidAmountInput < totalAmount) error("Nominal bayar tunai kurang dari total belanja.")
                paidAmount = totalAmount
                changeAmount = Formatters.roundMoney(max(0.0, paidAmountInput - totalAmount))
                debtAmount = 0.0
            }
            else -> {
                paidAmount = totalAmount
                changeAmount = 0.0
                debtAmount = 0.0
            }
        }

        if (paidAmount > 0 && primaryAccount == null) {
            error("Pilih akun kas / rekening penerima pembayaran terlebih dahulu.")
        }

        val saleId = Formatters.generateSafeId("sale")
        val meta = Formatters.createTransactionMetadata("POS", userUid, userName)

        db.runTransaction { tx ->
            // Reads first (Firestore transaction invariant)
            val productSnaps = cart.map { item ->
                val ref = db.collection("products").document(item.product.id)
                Triple(item, ref, tx.get(ref))
            }
            val accRef = primaryAccount?.let { db.collection("accounts").document(it.id) }
            val accSnap = accRef?.let { tx.get(it) }
            val custRef = customer?.let { db.collection("customers").document(it.id) }
            val custSnap = custRef?.let { tx.get(it) }

            // Validate stocks
            for ((item, _, pSnap) in productSnaps) {
                val curStock = pSnap.getDouble("stock") ?: 0.0
                if (curStock < item.baseQuantity) {
                    error("Stok ${item.product.name} tidak cukup (tersisa $curStock ${item.product.unit}).")
                }
            }

            // Writes
            val saleDoc = mutableMapOf<String, Any>(
                "transactionNumber" to meta.transactionNumber,
                "transactionDate" to meta.transactionDate,
                "transactionTime" to meta.transactionTime,
                "totalItems" to cart.size,
                "subtotal" to subtotal,
                "discount" to cleanDiscount,
                "totalAmount" to totalAmount,
                "totalCost" to totalCost,
                "totalProfit" to totalProfit,
                "paidAmount" to paidAmount,
                "changeAmount" to changeAmount,
                "debtAmount" to debtAmount,
                "paymentMethod" to paymentMethod,
                "status" to "completed",
                "recordedByUid" to meta.recordedByUid,
                "recordedByName" to meta.recordedByName,
                "createdAt" to FieldValue.serverTimestamp(),
                "updatedAt" to FieldValue.serverTimestamp()
            )
            if (customer != null) {
                saleDoc["customerId"] = customer.id
                saleDoc["customerName"] = customer.name.take(100)
            }
            if (primaryAccount != null) {
                if (paymentMethod == "qris") {
                    saleDoc["qrisAccountId"] = primaryAccount.id
                    saleDoc["qrisAmount"] = paidAmount
                } else {
                    saleDoc["accountId"] = primaryAccount.id
                }
            }
            val saleRef = db.collection("sales").document(saleId)
            tx.set(saleRef, saleDoc)

            productSnaps.forEachIndexed { idx, (item, pRef, pSnap) ->
                val curStock = pSnap.getDouble("stock") ?: 0.0
                val newStock = Formatters.roundMoney(max(0.0, curStock - item.baseQuantity))
                tx.update(pRef, mapOf("stock" to newStock, "updatedAt" to FieldValue.serverTimestamp()))

                val itemId = Formatters.generateSafeId("itm$idx")
                tx.set(
                    saleRef.collection("items").document(itemId),
                    mapOf(
                        "saleId" to saleId,
                        "productId" to item.product.id,
                        "productName" to item.product.name.take(120),
                        "unitName" to item.unitName.take(24),
                        "conversion" to item.conversion,
                        "baseQuantity" to item.baseQuantity,
                        "priceTier" to item.priceTier,
                        "quantity" to item.quantity,
                        "costPrice" to item.product.costPrice,
                        "unitPrice" to item.unitPrice,
                        "subtotal" to item.subtotal,
                        "profit" to item.profit,
                        "recordedByUid" to meta.recordedByUid,
                        "createdAt" to FieldValue.serverTimestamp()
                    )
                )

                val moveId = Formatters.generateSafeId("stk$idx")
                tx.set(
                    db.collection("stock_movements").document(moveId),
                    mapOf(
                        "transactionNumber" to meta.transactionNumber,
                        "transactionDate" to meta.transactionDate,
                        "transactionTime" to meta.transactionTime,
                        "productId" to item.product.id,
                        "productName" to item.product.name.take(120),
                        "baseUnit" to item.product.unit.take(24),
                        "unitName" to item.unitName.take(24),
                        "unitQuantity" to item.quantity,
                        "conversion" to item.conversion,
                        "type" to "out",
                        "quantity" to item.baseQuantity,
                        "stockBefore" to curStock,
                        "stockAfter" to newStock,
                        "referenceId" to saleId,
                        "notes" to "Penjualan POS ${meta.transactionNumber}",
                        "recordedByUid" to meta.recordedByUid,
                        "recordedByName" to meta.recordedByName,
                        "createdAt" to FieldValue.serverTimestamp()
                    )
                )
            }

            if (paidAmount > 0 && accRef != null && accSnap != null && primaryAccount != null) {
                val balBefore = accSnap.getDouble("balance") ?: 0.0
                val balAfter = Formatters.roundMoney(balBefore + paidAmount)
                tx.update(
                    accRef,
                    mapOf(
                        "balance" to balAfter,
                        "updatedByUid" to meta.recordedByUid,
                        "updatedAt" to FieldValue.serverTimestamp()
                    )
                )
                tx.set(
                    db.collection("cash_ledger").document(Formatters.generateSafeId("ldg")),
                    mapOf(
                        "transactionNumber" to meta.transactionNumber,
                        "transactionDate" to meta.transactionDate,
                        "transactionTime" to meta.transactionTime,
                        "accountId" to primaryAccount.id,
                        "accountName" to primaryAccount.name.take(80),
                        "direction" to "in",
                        "amount" to paidAmount,
                        "balanceBefore" to balBefore,
                        "balanceAfter" to balAfter,
                        "sourceModule" to "sale",
                        "referenceId" to saleId,
                        "description" to "Penjualan POS ${meta.transactionNumber}",
                        "recordedByUid" to meta.recordedByUid,
                        "recordedByName" to meta.recordedByName,
                        "createdAt" to FieldValue.serverTimestamp()
                    )
                )
            }

            if (debtAmount > 0 && custRef != null && custSnap != null && customer != null) {
                val prevDebt = custSnap.getDouble("totalDebt") ?: 0.0
                val newDebt = Formatters.roundMoney(prevDebt + debtAmount)
                tx.update(custRef, mapOf("totalDebt" to newDebt, "updatedAt" to FieldValue.serverTimestamp()))
                val recMeta = Formatters.createTransactionMetadata("KBN", userUid, userName)
                val recData = mutableMapOf<String, Any>(
                    "transactionNumber" to recMeta.transactionNumber,
                    "transactionDate" to recMeta.transactionDate,
                    "transactionTime" to recMeta.transactionTime,
                    "customerId" to customer.id,
                    "customerName" to customer.name.take(100),
                    "type" to "debt",
                    "amount" to debtAmount,
                    "balanceAfter" to newDebt,
                    "saleId" to saleId,
                    "notes" to "Kasbon dari POS ${meta.transactionNumber}",
                    "recordedByUid" to recMeta.recordedByUid,
                    "recordedByName" to recMeta.recordedByName,
                    "createdAt" to FieldValue.serverTimestamp()
                )
                tx.set(db.collection("receivables").document(Formatters.generateSafeId("rec")), recData)
            }
        }.await()

        Sale(
            id = saleId,
            transactionNumber = meta.transactionNumber,
            transactionDate = meta.transactionDate,
            transactionTime = meta.transactionTime,
            customerId = customer?.id,
            customerName = customer?.name,
            totalItems = cart.size,
            subtotal = subtotal,
            discount = cleanDiscount,
            totalAmount = totalAmount,
            paidAmount = paidAmount,
            changeAmount = changeAmount,
            debtAmount = debtAmount,
            paymentMethod = paymentMethod,
            recordedByUid = meta.recordedByUid,
            recordedByName = meta.recordedByName
        )
    }

    suspend fun createCustomer(
        name: String,
        phone: String,
        address: String,
        notes: String,
        userUid: String
    ): Result<Unit> = runCatching {
        val cleanName = name.trim().take(100)
        if (cleanName.isEmpty()) error("Nama pelanggan wajib diisi.")
        val id = Formatters.generateSafeId("cst")
        val payload = mutableMapOf<String, Any>(
            "name" to cleanName,
            "totalDebt" to 0.0,
            "createdByUid" to userUid,
            "createdAt" to FieldValue.serverTimestamp(),
            "updatedAt" to FieldValue.serverTimestamp()
        )
        if (phone.isNotBlank()) payload["phone"] = phone.trim().take(24)
        if (address.isNotBlank()) payload["address"] = address.trim().take(200)
        if (notes.isNotBlank()) payload["notes"] = notes.trim().take(200)
        db.collection("customers").document(id).set(payload).await()
    }

    suspend fun updateCustomerProfile(
        customerId: String,
        name: String,
        phone: String,
        address: String,
        notes: String
    ): Result<Unit> = runCatching {
        val cleanName = name.trim().take(100)
        if (cleanName.isEmpty()) error("Nama pelanggan wajib diisi.")
        db.collection("customers").document(customerId).update(
            mapOf(
                "name" to cleanName,
                "phone" to phone.trim().take(24),
                "address" to address.trim().take(200),
                "notes" to notes.trim().take(200),
                "updatedAt" to FieldValue.serverTimestamp()
            )
        ).await()
    }

    suspend fun recordReceivablePayment(
        customer: Customer,
        amount: Double,
        account: Account,
        notes: String,
        userUid: String,
        userName: String
    ): Result<Unit> = runCatching {
        val cleanAmount = Formatters.roundMoney(amount)
        if (cleanAmount <= 0.0) error("Nominal bayar harus lebih dari Rp0.")
        val recId = Formatters.generateSafeId("rec")
        val meta = Formatters.createTransactionMetadata("BYR", userUid, userName)

        db.runTransaction { tx ->
            val custRef = db.collection("customers").document(customer.id)
            val accRef = db.collection("accounts").document(account.id)
            val cSnap = tx.get(custRef)
            val aSnap = tx.get(accRef)

            val curDebt = cSnap.getDouble("totalDebt") ?: 0.0
            if (cleanAmount > curDebt) error("Pembayaran melebihi sisa piutang pelanggan.")
            val newDebt = Formatters.roundMoney(max(0.0, curDebt - cleanAmount))
            val balBefore = aSnap.getDouble("balance") ?: 0.0
            val balAfter = Formatters.roundMoney(balBefore + cleanAmount)

            tx.update(custRef, mapOf("totalDebt" to newDebt, "updatedAt" to FieldValue.serverTimestamp()))
            tx.update(
                accRef,
                mapOf(
                    "balance" to balAfter,
                    "updatedByUid" to userUid,
                    "updatedAt" to FieldValue.serverTimestamp()
                )
            )
            tx.set(
                db.collection("receivables").document(recId),
                mapOf(
                    "transactionNumber" to meta.transactionNumber,
                    "transactionDate" to meta.transactionDate,
                    "transactionTime" to meta.transactionTime,
                    "customerId" to customer.id,
                    "customerName" to customer.name.take(100),
                    "type" to "payment",
                    "amount" to cleanAmount,
                    "balanceAfter" to newDebt,
                    "accountId" to account.id,
                    "notes" to notes.trim().ifEmpty { "Pembayaran piutang" }.take(240),
                    "recordedByUid" to meta.recordedByUid,
                    "recordedByName" to meta.recordedByName,
                    "createdAt" to FieldValue.serverTimestamp()
                )
            )
            tx.set(
                db.collection("cash_ledger").document(Formatters.generateSafeId("ldg")),
                mapOf(
                    "transactionNumber" to meta.transactionNumber,
                    "transactionDate" to meta.transactionDate,
                    "transactionTime" to meta.transactionTime,
                    "accountId" to account.id,
                    "accountName" to account.name.take(80),
                    "direction" to "in",
                    "amount" to cleanAmount,
                    "balanceBefore" to balBefore,
                    "balanceAfter" to balAfter,
                    "sourceModule" to "receivable",
                    "referenceId" to recId,
                    "description" to "Pelunasan piutang ${customer.name}",
                    "recordedByUid" to meta.recordedByUid,
                    "recordedByName" to meta.recordedByName,
                    "createdAt" to FieldValue.serverTimestamp()
                )
            )
        }.await()
    }

    suspend fun submitMiniAtm(
        serviceType: String, // tarik_tunai | transfer
        bankName: String,
        customerName: String,
        targetAccountNumber: String,
        principalAmount: Double,
        adminFee: Double,
        bankFee: Double,
        cashAccount: Account,
        bankAccount: Account,
        userUid: String,
        userName: String
    ): Result<String> = runCatching {
        if (bankName.trim().isEmpty()) error("Nama bank wajib diisi.")
        if (principalAmount <= 0) error("Nominal pokok wajib > Rp0.")
        if (cashAccount.id == bankAccount.id) error("Akun kas dan bank harus berbeda.")
        val netProfit = Formatters.roundMoney(adminFee - bankFee)
        val cashDelta = if (serviceType == "tarik_tunai") Formatters.roundMoney(-principalAmount + adminFee)
        else Formatters.roundMoney(principalAmount + adminFee)
        val bankDelta = if (serviceType == "tarik_tunai") Formatters.roundMoney(principalAmount - bankFee)
        else Formatters.roundMoney(-(principalAmount + bankFee))

        val txId = Formatters.generateSafeId("atm")
        val meta = Formatters.createTransactionMetadata("ATM", userUid, userName)

        db.runTransaction { tx ->
            val cashRef = db.collection("accounts").document(cashAccount.id)
            val bankRef = db.collection("accounts").document(bankAccount.id)
            val cSnap = tx.get(cashRef)
            val bSnap = tx.get(bankRef)
            val cBefore = cSnap.getDouble("balance") ?: 0.0
            val bBefore = bSnap.getDouble("balance") ?: 0.0
            val cAfter = Formatters.roundMoney(cBefore + cashDelta)
            val bAfter = Formatters.roundMoney(bBefore + bankDelta)
            if (cAfter < 0) error("Saldo ${cashAccount.name} tidak mencukupi.")
            if (bAfter < 0) error("Saldo ${bankAccount.name} tidak mencukupi.")

            tx.update(cashRef, mapOf("balance" to cAfter, "updatedByUid" to userUid, "updatedAt" to FieldValue.serverTimestamp()))
            tx.update(bankRef, mapOf("balance" to bAfter, "updatedByUid" to userUid, "updatedAt" to FieldValue.serverTimestamp()))
            tx.set(
                db.collection("mini_atm_transactions").document(txId),
                mapOf(
                    "transactionNumber" to meta.transactionNumber,
                    "transactionDate" to meta.transactionDate,
                    "transactionTime" to meta.transactionTime,
                    "serviceType" to serviceType,
                    "paymentChannel" to "bank_transfer",
                    "bankName" to bankName.trim().take(60),
                    "targetAccountNumber" to targetAccountNumber.trim().take(40),
                    "customerName" to customerName.trim().take(100),
                    "principalAmount" to principalAmount,
                    "adminFee" to adminFee,
                    "bankFee" to bankFee,
                    "transferVerified" to (serviceType == "transfer"),
                    "netProfit" to netProfit,
                    "cashAccountId" to cashAccount.id,
                    "bankAccountId" to bankAccount.id,
                    "status" to "completed",
                    "recordedByUid" to meta.recordedByUid,
                    "recordedByName" to meta.recordedByName,
                    "createdAt" to FieldValue.serverTimestamp(),
                    "updatedAt" to FieldValue.serverTimestamp()
                )
            )
        }.await()
        meta.transactionNumber
    }

    suspend fun submitPpob(
        category: String,
        providerName: String,
        targetNumber: String,
        capitalPrice: Double,
        sellPrice: Double,
        adminFee: Double,
        depositAccount: Account,
        cashAccount: Account,
        userUid: String,
        userName: String
    ): Result<String> = runCatching {
        if (providerName.trim().isEmpty()) error("Nama provider / produk PPOB wajib diisi.")
        if (targetNumber.trim().length < 3) error("Nomor tujuan minimal 3 karakter.")
        val customerTotal = Formatters.roundMoney(sellPrice + adminFee)
        val netProfit = Formatters.roundMoney(customerTotal - capitalPrice)
        val txId = Formatters.generateSafeId("ppb")
        val meta = Formatters.createTransactionMetadata("PPB", userUid, userName)

        db.runTransaction { tx ->
            val depRef = db.collection("accounts").document(depositAccount.id)
            val cashRef = db.collection("accounts").document(cashAccount.id)
            val dSnap = tx.get(depRef)
            val cSnap = tx.get(cashRef)
            val dBefore = dSnap.getDouble("balance") ?: 0.0
            val cBefore = cSnap.getDouble("balance") ?: 0.0
            if (dBefore < capitalPrice) error("Saldo ${depositAccount.name} tidak mencukupi.")
            if (depositAccount.id == cashAccount.id) {
                tx.update(
                    depRef,
                    mapOf(
                        "balance" to Formatters.roundMoney(dBefore - capitalPrice + customerTotal),
                        "updatedByUid" to userUid,
                        "updatedAt" to FieldValue.serverTimestamp()
                    )
                )
            } else {
                tx.update(
                    depRef,
                    mapOf(
                        "balance" to Formatters.roundMoney(dBefore - capitalPrice),
                        "updatedByUid" to userUid,
                        "updatedAt" to FieldValue.serverTimestamp()
                    )
                )
                tx.update(
                    cashRef,
                    mapOf(
                        "balance" to Formatters.roundMoney(cBefore + customerTotal),
                        "updatedByUid" to userUid,
                        "updatedAt" to FieldValue.serverTimestamp()
                    )
                )
            }
            tx.set(
                db.collection("ppob_transactions").document(txId),
                mapOf(
                    "transactionNumber" to meta.transactionNumber,
                    "transactionDate" to meta.transactionDate,
                    "transactionTime" to meta.transactionTime,
                    "category" to category,
                    "providerName" to providerName.trim().take(80),
                    "targetNumber" to targetNumber.trim().take(50),
                    "capitalPrice" to capitalPrice,
                    "sellPrice" to sellPrice,
                    "adminFee" to adminFee,
                    "netProfit" to netProfit,
                    "accountId" to depositAccount.id,
                    "cashAccountId" to cashAccount.id,
                    "status" to "completed",
                    "recordedByUid" to meta.recordedByUid,
                    "recordedByName" to meta.recordedByName,
                    "createdAt" to FieldValue.serverTimestamp(),
                    "updatedAt" to FieldValue.serverTimestamp()
                )
            )
        }.await()
        meta.transactionNumber
    }

    suspend fun finalizeCashierClosing(
        shiftLabel: String,
        periodStartDate: String,
        periodEndDate: String,
        openingCash: Double,
        actualCash: Double,
        notes: String,
        breakdown: CashierClosingBreakdown,
        userUid: String,
        userName: String
    ): Result<String> = runCatching {
        val variance = ClosingMath.evaluateVariance(breakdown.expectedCash, actualCash)
        val cleanNotes = notes.trim().take(300)
        if (variance.status != "balance" && cleanNotes.isEmpty()) {
            error("Terdapat selisih (${variance.statusLabel}). Masukkan catatan penjelasan sebelum finalisasi.")
        }
        val closingId = Formatters.generateSafeId("cls")
        val meta = Formatters.createTransactionMetadata("CLS", userUid, userName)

        val payload = mutableMapOf<String, Any>(
            "transactionNumber" to meta.transactionNumber,
            "transactionDate" to meta.transactionDate,
            "transactionTime" to meta.transactionTime,
            "periodStartDate" to periodStartDate,
            "periodEndDate" to periodEndDate,
            "openingCash" to Formatters.roundMoney(max(0.0, openingCash)),
            "totalSalesAmount" to breakdown.totalSalesAmount,
            "retailTxCount" to breakdown.retailTxCount,
            "retailCashIn" to breakdown.retailCashIn,
            "retailQrisTotal" to breakdown.retailQrisTotal,
            "retailTransferTotal" to breakdown.retailTransferTotal,
            "retailDebtCreatedTotal" to breakdown.retailDebtCreatedTotal,
            "miniAtmTxCount" to breakdown.miniAtmTxCount,
            "miniAtmCashIn" to breakdown.miniAtmCashIn,
            "miniAtmCashOut" to breakdown.miniAtmCashOut,
            "miniAtmNonCashTotal" to breakdown.miniAtmNonCashTotal,
            "ppobTxCount" to breakdown.ppobTxCount,
            "ppobCashIn" to breakdown.ppobCashIn,
            "ppobNonCashTotal" to breakdown.ppobNonCashTotal,
            "receivablePaymentCount" to breakdown.receivablePaymentCount,
            "receivableCashIn" to breakdown.receivableCashIn,
            "receivableNonCashIn" to breakdown.receivableNonCashIn,
            "expectedCash" to variance.expectedCash,
            "actualCash" to variance.actualCash,
            "varianceAmount" to variance.varianceAmount,
            "status" to variance.status,
            "isFinalized" to true,
            "reviewStatus" to "pending",
            "recordedByUid" to meta.recordedByUid,
            "recordedByName" to meta.recordedByName,
            "createdAt" to FieldValue.serverTimestamp(),
            "updatedAt" to FieldValue.serverTimestamp()
        )
        if (shiftLabel.isNotBlank()) payload["shiftLabel"] = shiftLabel.trim().take(60)
        if (cleanNotes.isNotEmpty()) payload["notes"] = cleanNotes

        db.collection("cashier_closings").document(closingId).set(payload).await()
        meta.transactionNumber
    }

    suspend fun reviewCashierClosing(
        closingId: String,
        reviewStatus: String,
        reviewNote: String,
        adminUid: String,
        adminName: String
    ): Result<Unit> = runCatching {
        db.collection("cashier_closings").document(closingId).update(
            mapOf(
                "reviewStatus" to reviewStatus,
                "reviewNote" to reviewNote.trim().take(300),
                "reviewedByUid" to adminUid,
                "reviewedByName" to adminName.trim().take(100).ifEmpty { "Admin" },
                "reviewedAtDate" to Formatters.todayDateStr(),
                "updatedAt" to FieldValue.serverTimestamp()
            )
        ).await()
    }
}
