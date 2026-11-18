package com.kedaikhanxa.app.utils

import com.kedaikhanxa.app.model.Account
import com.kedaikhanxa.app.model.CashierClosingBreakdown
import com.kedaikhanxa.app.model.MiniAtmTransaction
import com.kedaikhanxa.app.model.PpobTransaction
import com.kedaikhanxa.app.model.Receivable
import com.kedaikhanxa.app.model.Sale
import kotlin.math.abs
import kotlin.math.max

data class ClosingVarianceResult(
    val expectedCash: Double,
    val actualCash: Double,
    val varianceAmount: Double,
    val status: String, // balance | short | over
    val statusLabel: String
)

object ClosingMath {
    fun statusLabel(status: String): String = when (status) {
        "balance" -> "Sesuai / Balance"
        "short" -> "Kurang / Short"
        "over" -> "Lebih / Over"
        else -> status
    }

    fun evaluateVariance(expectedCash: Double, actualCash: Double): ClosingVarianceResult {
        val safeExpected = Formatters.roundMoney(expectedCash)
        val safeActual = Formatters.roundMoney(max(0.0, actualCash))
        val variance = Formatters.roundMoney(safeActual - safeExpected)
        val status = when {
            abs(variance) < 1.0 -> "balance"
            variance < 0.0 -> "short"
            else -> "over"
        }
        return ClosingVarianceResult(
            expectedCash = safeExpected,
            actualCash = safeActual,
            varianceAmount = if (abs(variance) < 1.0) 0.0 else variance,
            status = status,
            statusLabel = statusLabel(status)
        )
    }

    fun computeBreakdown(
        sales: List<Sale>,
        miniAtm: List<MiniAtmTransaction>,
        ppob: List<PpobTransaction>,
        receivables: List<Receivable>,
        accounts: List<Account>,
        targetCashierUid: String,
        periodStartDate: String,
        periodEndDate: String,
        openingCash: Double
    ): CashierClosingBreakdown {
        val safeOpening = Formatters.roundMoney(max(0.0, openingCash))
        val accountMap = accounts.associateBy { it.id }

        fun isCashAccount(accountId: String?, fallback: Boolean): Boolean {
            if (accountId.isNullOrBlank()) return fallback
            val acc = accountMap[accountId] ?: return fallback
            return acc.type == "cash"
        }

        fun inRange(dateStr: String): Boolean =
            dateStr.isNotBlank() && dateStr >= periodStartDate && dateStr <= periodEndDate

        var totalSalesAmount = 0.0
        var retailTxCount = 0
        var retailCashIn = 0.0
        var retailQrisTotal = 0.0
        var retailTransferTotal = 0.0
        var retailDebtCreatedTotal = 0.0

        for (s in sales) {
            if (s.recordedByUid != targetCashierUid) continue
            if (s.status != "completed") continue
            if (!inRange(s.transactionDate)) continue

            retailTxCount += 1
            val total = Formatters.roundMoney(max(0.0, s.totalAmount))
            totalSalesAmount = Formatters.roundMoney(totalSalesAmount + total)

            when (s.paymentMethod) {
                "cash" -> {
                    if (isCashAccount(s.accountId, true)) {
                        retailCashIn = Formatters.roundMoney(retailCashIn + total)
                    } else {
                        retailTransferTotal = Formatters.roundMoney(retailTransferTotal + total)
                    }
                }
                "qris" -> retailQrisTotal = Formatters.roundMoney(retailQrisTotal + total)
                "mixed" -> {
                    val cashPart = Formatters.roundMoney(max(0.0, s.cashPaidPart ?: 0.0))
                    val qrisPart = Formatters.roundMoney(
                        max(0.0, s.qrisAmount ?: max(0.0, total - cashPart))
                    )
                    if (isCashAccount(s.accountId, true)) {
                        retailCashIn = Formatters.roundMoney(retailCashIn + cashPart)
                    } else {
                        retailTransferTotal = Formatters.roundMoney(retailTransferTotal + cashPart)
                    }
                    retailQrisTotal = Formatters.roundMoney(retailQrisTotal + qrisPart)
                }
                "transfer" -> retailTransferTotal = Formatters.roundMoney(retailTransferTotal + total)
                "debt" -> {
                    val dp = Formatters.roundMoney(max(0.0, s.paidAmount))
                    val debt = Formatters.roundMoney(
                        max(0.0, if (s.debtAmount > 0) s.debtAmount else max(0.0, total - dp))
                    )
                    retailDebtCreatedTotal = Formatters.roundMoney(retailDebtCreatedTotal + debt)
                    if (dp > 0.0) {
                        if (isCashAccount(s.accountId, true)) {
                            retailCashIn = Formatters.roundMoney(retailCashIn + dp)
                        } else {
                            retailTransferTotal = Formatters.roundMoney(retailTransferTotal + dp)
                        }
                    }
                }
            }
        }

        var miniAtmTxCount = 0
        var miniAtmCashIn = 0.0
        var miniAtmCashOut = 0.0
        var miniAtmNonCashTotal = 0.0

        for (tx in miniAtm) {
            if (tx.recordedByUid != targetCashierUid) continue
            if (tx.status != "completed") continue
            if (!inRange(tx.transactionDate)) continue

            miniAtmTxCount += 1
            val principal = Formatters.roundMoney(max(0.0, tx.principalAmount))
            val adminFee = Formatters.roundMoney(max(0.0, tx.adminFee))
            val bankFee = Formatters.roundMoney(max(0.0, tx.bankFee))
            val internalExtra = Formatters.roundMoney(max(0.0, tx.internalExtraFee))
            val drawerUsed = isCashAccount(tx.cashAccountId, true)

            if (tx.serviceType == "tarik_tunai") {
                val cashDelta = Formatters.roundMoney(-(principal - internalExtra) + adminFee)
                if (drawerUsed) {
                    if (cashDelta >= 0.0) {
                        miniAtmCashIn = Formatters.roundMoney(miniAtmCashIn + cashDelta)
                    } else {
                        miniAtmCashOut = Formatters.roundMoney(miniAtmCashOut + abs(cashDelta))
                    }
                }
                miniAtmNonCashTotal = Formatters.roundMoney(miniAtmNonCashTotal + principal)
            } else {
                val cashIn = Formatters.roundMoney(principal + adminFee)
                if (drawerUsed) {
                    miniAtmCashIn = Formatters.roundMoney(miniAtmCashIn + cashIn)
                } else {
                    miniAtmNonCashTotal = Formatters.roundMoney(miniAtmNonCashTotal + cashIn)
                }
                miniAtmNonCashTotal = Formatters.roundMoney(miniAtmNonCashTotal + principal + bankFee)
            }
        }

        var ppobTxCount = 0
        var ppobCashIn = 0.0
        var ppobCashOut = 0.0
        var ppobNonCashTotal = 0.0

        for (tx in ppob) {
            if (tx.recordedByUid != targetCashierUid) continue
            if (tx.status == "failed") continue
            if (!inRange(tx.transactionDate)) continue

            ppobTxCount += 1
            val customerTotal = Formatters.roundMoney(max(0.0, tx.sellPrice) + max(0.0, tx.adminFee))
            val capital = Formatters.roundMoney(max(0.0, tx.capitalPrice))
            if (isCashAccount(tx.cashAccountId, true)) {
                ppobCashIn = Formatters.roundMoney(ppobCashIn + customerTotal)
            } else {
                ppobNonCashTotal = Formatters.roundMoney(ppobNonCashTotal + customerTotal)
            }
            if (isCashAccount(tx.accountId, false)) {
                ppobCashOut = Formatters.roundMoney(ppobCashOut + capital)
            }
        }

        var receivablePaymentCount = 0
        var receivableCashIn = 0.0
        var receivableNonCashIn = 0.0

        for (r in receivables) {
            if (r.recordedByUid != targetCashierUid) continue
            if (r.type != "payment") continue
            if (!inRange(r.transactionDate)) continue

            receivablePaymentCount += 1
            val amount = Formatters.roundMoney(max(0.0, r.amount))
            if (isCashAccount(r.accountId, true)) {
                receivableCashIn = Formatters.roundMoney(receivableCashIn + amount)
            } else {
                receivableNonCashIn = Formatters.roundMoney(receivableNonCashIn + amount)
            }
        }

        val totalCashIn = Formatters.roundMoney(retailCashIn + miniAtmCashIn + ppobCashIn + receivableCashIn)
        val totalCashOut = Formatters.roundMoney(miniAtmCashOut + ppobCashOut)
        val expectedCash = Formatters.roundMoney(safeOpening + totalCashIn - totalCashOut)
        val totalNonCashAmount = Formatters.roundMoney(
            retailQrisTotal + retailTransferTotal + ppobNonCashTotal + receivableNonCashIn
        )

        return CashierClosingBreakdown(
            periodStartDate = periodStartDate,
            periodEndDate = periodEndDate,
            openingCash = safeOpening,
            totalSalesAmount = totalSalesAmount,
            retailTxCount = retailTxCount,
            retailCashIn = retailCashIn,
            retailQrisTotal = retailQrisTotal,
            retailTransferTotal = retailTransferTotal,
            retailDebtCreatedTotal = retailDebtCreatedTotal,
            miniAtmTxCount = miniAtmTxCount,
            miniAtmCashIn = miniAtmCashIn,
            miniAtmCashOut = miniAtmCashOut,
            miniAtmNonCashTotal = miniAtmNonCashTotal,
            ppobTxCount = ppobTxCount,
            ppobCashIn = ppobCashIn,
            ppobCashOut = ppobCashOut,
            ppobNonCashTotal = ppobNonCashTotal,
            receivablePaymentCount = receivablePaymentCount,
            receivableCashIn = receivableCashIn,
            receivableNonCashIn = receivableNonCashIn,
            totalNonCashAmount = totalNonCashAmount,
            totalCashIn = totalCashIn,
            totalCashOut = totalCashOut,
            expectedCash = expectedCash
        )
    }
}
