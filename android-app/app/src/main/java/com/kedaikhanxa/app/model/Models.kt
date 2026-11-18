package com.kedaikhanxa.app.model

data class UserProfile(
    val uid: String = "",
    val email: String = "",
    val displayName: String = "",
    val photoURL: String? = null,
    val role: String = "pending", // admin | kasir | pending
    val status: String = "pending", // active | inactive | pending
    val shiftLabel: String? = null,
    val phone: String? = null,
    val isPrimaryAdmin: Boolean = false
)

data class Account(
    val id: String = "",
    val name: String = "",
    val type: String = "cash", // cash | bank | ewallet | ppob_deposit
    val accountNumber: String? = null,
    val balance: Double = 0.0,
    val isActive: Boolean = true
)

data class SellUnit(
    val unitName: String = "",
    val conversion: Double = 1.0,
    val buyPrice: Double? = null,
    val sellPrice: Double = 0.0,
    val wholesalePrice: Double? = null,
    val wholesaleMinQty: Double? = null,
    val canBuy: Boolean? = null,
    val canSell: Boolean? = null,
    val conversionMode: String? = null,
    val perBaseQty: Double? = null
)

data class Product(
    val id: String = "",
    val sku: String = "",
    val barcode: String? = null,
    val name: String = "",
    val brand: String? = null,
    val variant: String? = null,
    val categoryId: String = "",
    val categoryName: String = "",
    val unit: String = "PCS",
    val baseCanSell: Boolean = true,
    val costPrice: Double = 0.0,
    val sellPrice: Double = 0.0,
    val wholesalePrice: Double? = null,
    val wholesaleMinQty: Double? = null,
    val sellUnits: List<SellUnit> = emptyList(),
    val stock: Double = 0.0,
    val minStock: Double = 0.0,
    val isActive: Boolean = true
)

data class Customer(
    val id: String = "",
    val name: String = "",
    val phone: String = "",
    val address: String = "",
    val totalDebt: Double = 0.0,
    val notes: String = ""
)

data class SaleCartItem(
    val product: Product,
    val unitName: String,
    val conversion: Double,
    val quantity: Double,
    val unitPrice: Double,
    val priceTier: String = "retail" // retail | wholesale
) {
    val baseQuantity: Double get() = quantity * conversion
    val subtotal: Double get() = quantity * unitPrice
    val costTotal: Double get() = baseQuantity * product.costPrice
    val profit: Double get() = subtotal - costTotal
}

data class Sale(
    val id: String = "",
    val transactionNumber: String = "",
    val transactionDate: String = "",
    val transactionTime: String = "",
    val customerId: String? = null,
    val customerName: String? = null,
    val totalItems: Int = 0,
    val subtotal: Double = 0.0,
    val discount: Double = 0.0,
    val totalAmount: Double = 0.0,
    val totalCost: Double = 0.0,
    val totalProfit: Double = 0.0,
    val paidAmount: Double = 0.0,
    val changeAmount: Double = 0.0,
    val debtAmount: Double = 0.0,
    val paymentMethod: String = "cash", // cash | transfer | qris | mixed | debt
    val cashPaidPart: Double? = null,
    val qrisAmount: Double? = null,
    val accountId: String? = null,
    val qrisAccountId: String? = null,
    val status: String = "completed", // completed | void
    val recordedByUid: String = "",
    val recordedByName: String = ""
)

data class MiniAtmTransaction(
    val id: String = "",
    val transactionNumber: String = "",
    val transactionDate: String = "",
    val transactionTime: String = "",
    val serviceType: String = "tarik_tunai", // tarik_tunai | transfer | setor_tunai
    val paymentChannel: String = "bank_transfer", // bank_transfer | qris
    val bankName: String = "",
    val targetAccountNumber: String = "",
    val customerName: String = "",
    val principalAmount: Double = 0.0,
    val adminFee: Double = 0.0,
    val bankFee: Double = 0.0,
    val internalExtraFee: Double = 0.0,
    val netProfit: Double = 0.0,
    val cashAccountId: String = "",
    val bankAccountId: String = "",
    val status: String = "completed",
    val recordedByUid: String = "",
    val recordedByName: String = ""
)

data class PpobTransaction(
    val id: String = "",
    val transactionNumber: String = "",
    val transactionDate: String = "",
    val transactionTime: String = "",
    val category: String = "pulsa",
    val providerName: String = "",
    val targetNumber: String = "",
    val customerName: String = "",
    val capitalPrice: Double = 0.0,
    val sellPrice: Double = 0.0,
    val adminFee: Double = 0.0,
    val netProfit: Double = 0.0,
    val accountId: String = "",
    val cashAccountId: String = "",
    val serialNumber: String = "",
    val status: String = "completed", // completed | pending | failed
    val recordedByUid: String = "",
    val recordedByName: String = ""
)

data class Receivable(
    val id: String = "",
    val transactionNumber: String = "",
    val transactionDate: String = "",
    val transactionTime: String = "",
    val customerId: String = "",
    val customerName: String = "",
    val type: String = "debt", // debt | payment
    val amount: Double = 0.0,
    val balanceAfter: Double = 0.0,
    val saleId: String? = null,
    val accountId: String? = null,
    val notes: String = "",
    val recordedByUid: String = "",
    val recordedByName: String = ""
)

data class CashierClosingBreakdown(
    val periodStartDate: String,
    val periodEndDate: String,
    val openingCash: Double,
    val totalSalesAmount: Double,
    val retailTxCount: Int,
    val retailCashIn: Double,
    val retailQrisTotal: Double,
    val retailTransferTotal: Double,
    val retailDebtCreatedTotal: Double,
    val miniAtmTxCount: Int,
    val miniAtmCashIn: Double,
    val miniAtmCashOut: Double,
    val miniAtmNonCashTotal: Double,
    val ppobTxCount: Int,
    val ppobCashIn: Double,
    val ppobCashOut: Double,
    val ppobNonCashTotal: Double,
    val receivablePaymentCount: Int,
    val receivableCashIn: Double,
    val receivableNonCashIn: Double,
    val totalNonCashAmount: Double,
    val totalCashIn: Double,
    val totalCashOut: Double,
    val expectedCash: Double
)

data class CashierClosing(
    val id: String = "",
    val transactionNumber: String = "",
    val transactionDate: String = "",
    val transactionTime: String = "",
    val shiftLabel: String = "",
    val periodStartDate: String = "",
    val periodEndDate: String = "",
    val openingCash: Double = 0.0,
    val totalSalesAmount: Double = 0.0,
    val retailTxCount: Int = 0,
    val retailCashIn: Double = 0.0,
    val retailQrisTotal: Double = 0.0,
    val retailTransferTotal: Double = 0.0,
    val retailDebtCreatedTotal: Double = 0.0,
    val miniAtmTxCount: Int = 0,
    val miniAtmCashIn: Double = 0.0,
    val miniAtmCashOut: Double = 0.0,
    val miniAtmNonCashTotal: Double = 0.0,
    val ppobTxCount: Int = 0,
    val ppobCashIn: Double = 0.0,
    val ppobNonCashTotal: Double = 0.0,
    val receivablePaymentCount: Int = 0,
    val receivableCashIn: Double = 0.0,
    val receivableNonCashIn: Double = 0.0,
    val expectedCash: Double = 0.0,
    val actualCash: Double = 0.0,
    val varianceAmount: Double = 0.0,
    val status: String = "balance", // balance | short | over
    val notes: String = "",
    val isFinalized: Boolean = true,
    val reviewStatus: String = "pending", // pending | verified | flagged
    val reviewNote: String = "",
    val reviewedByUid: String = "",
    val reviewedByName: String = "",
    val reviewedAtDate: String = "",
    val recordedByUid: String = "",
    val recordedByName: String = ""
)

data class StoreSetting(
    val storeName: String = "KEDAI KHANXA",
    val ownerName: String = "Admin",
    val address: String = "",
    val phone: String = "",
    val receiptFooter: String = "Terima kasih telah berbelanja di Kedai Khanxa",
    val qrisFeePercent: Double = 0.7
)
