import type {
  Account,
  CashierClosingStatus,
  MiniAtmTransaction,
  PpobTransaction,
  Receivable,
  Sale,
} from '../types/database';
import { roundMoney } from './unitConversion';

export interface ComputeCashierClosingInput {
  sales: Sale[];
  miniAtmTransactions: MiniAtmTransaction[];
  ppobTransactions: PpobTransaction[];
  receivables: Receivable[];
  accounts: Account[];
  targetCashierUid: string;
  periodStartDate: string; // YYYY-MM-DD
  periodEndDate: string; // YYYY-MM-DD
  openingCash?: number;
}

export interface CashierClosingBreakdown {
  periodStartDate: string;
  periodEndDate: string;
  openingCash: number;
  // Penjualan Retail (Omzet total dipisahkan dari arus kas fisik!)
  totalSalesAmount: number;
  retailTxCount: number;
  retailCashIn: number;
  retailQrisTotal: number;
  retailTransferTotal: number;
  retailDebtCreatedTotal: number;
  // Mini ATM
  miniAtmTxCount: number;
  miniAtmCashIn: number;
  miniAtmCashOut: number;
  miniAtmNonCashTotal: number;
  // PPOB
  ppobTxCount: number;
  ppobCashIn: number;
  ppobCashOut: number;
  ppobNonCashTotal: number;
  // Piutang / Pembayaran Piutang
  receivablePaymentCount: number;
  receivableCashIn: number;
  receivableNonCashIn: number;
  // Total & Rekonsiliasi Laci Tunai
  totalNonCashAmount: number;
  totalCashIn: number;
  totalCashOut: number;
  expectedCash: number;
}

export interface ClosingVarianceEvaluation {
  expectedCash: number;
  actualCash: number;
  varianceAmount: number;
  status: CashierClosingStatus;
  statusLabel: string;
}

export function getClosingStatusLabel(status: CashierClosingStatus): string {
  switch (status) {
    case 'balance':
      return 'Sesuai / Balance';
    case 'short':
      return 'Kurang / Short';
    case 'over':
      return 'Lebih / Over';
    default:
      return status;
  }
}

export function evaluateClosingVariance(
  expectedCash: number,
  actualCash: number
): ClosingVarianceEvaluation {
  const safeExpected = roundMoney(Number(expectedCash) || 0);
  const safeActual = roundMoney(Math.max(0, Number(actualCash) || 0));
  const varianceAmount = roundMoney(safeActual - safeExpected);

  let status: CashierClosingStatus = 'balance';
  if (Math.abs(varianceAmount) < 1) {
    status = 'balance';
  } else if (varianceAmount < 0) {
    status = 'short';
  } else {
    status = 'over';
  }

  return {
    expectedCash: safeExpected,
    actualCash: safeActual,
    varianceAmount: Math.abs(varianceAmount) < 1 ? 0 : varianceAmount,
    status,
    statusLabel: getClosingStatusLabel(status),
  };
}

function isInDateRange(dateStr: string | undefined, startDate: string, endDate: string): boolean {
  if (!dateStr) return false;
  return dateStr >= startDate && dateStr <= endDate;
}

export function computeCashierClosingBreakdown(
  input: ComputeCashierClosingInput
): CashierClosingBreakdown {
  const openingCash = roundMoney(Math.max(0, Number(input.openingCash) || 0));
  const accountMap = new Map<string, Account>();
  for (const acc of input.accounts) {
    accountMap.set(acc.id, acc);
  }

  const isCashAccount = (accountId: string | undefined, fallbackIfMissing: boolean): boolean => {
    if (!accountId) return fallbackIfMissing;
    const acc = accountMap.get(accountId);
    if (!acc) return fallbackIfMissing;
    return acc.type === 'cash';
  };

  let totalSalesAmount = 0;
  let retailTxCount = 0;
  let retailCashIn = 0;
  let retailQrisTotal = 0;
  let retailTransferTotal = 0;
  let retailDebtCreatedTotal = 0;

  for (const s of input.sales) {
    if (s.recordedByUid !== input.targetCashierUid) continue;
    if (s.status !== 'completed') continue;
    if (!isInDateRange(s.transactionDate, input.periodStartDate, input.periodEndDate)) continue;

    retailTxCount += 1;
    const saleTotal = roundMoney(Math.max(0, Number(s.totalAmount) || 0));
    totalSalesAmount = roundMoney(totalSalesAmount + saleTotal);

    if (s.paymentMethod === 'cash') {
      if (isCashAccount(s.accountId, true)) {
        retailCashIn = roundMoney(retailCashIn + saleTotal);
      } else {
        retailTransferTotal = roundMoney(retailTransferTotal + saleTotal);
      }
    } else if (s.paymentMethod === 'qris') {
      retailQrisTotal = roundMoney(retailQrisTotal + saleTotal);
    } else if (s.paymentMethod === 'mixed') {
      const cashPart = roundMoney(Math.max(0, Number(s.cashPaidPart) || 0));
      const qrisPart = roundMoney(
        Math.max(0, Number(s.qrisAmount) || Math.max(0, saleTotal - cashPart))
      );
      if (isCashAccount(s.accountId, true)) {
        retailCashIn = roundMoney(retailCashIn + cashPart);
      } else {
        retailTransferTotal = roundMoney(retailTransferTotal + cashPart);
      }
      retailQrisTotal = roundMoney(retailQrisTotal + qrisPart);
    } else if (s.paymentMethod === 'transfer') {
      retailTransferTotal = roundMoney(retailTransferTotal + saleTotal);
    } else if (s.paymentMethod === 'debt') {
      const dpAmount = roundMoney(Math.max(0, Number(s.paidAmount) || 0));
      const debtAdded = roundMoney(Math.max(0, Number(s.debtAmount) || Math.max(0, saleTotal - dpAmount)));
      retailDebtCreatedTotal = roundMoney(retailDebtCreatedTotal + debtAdded);
      if (dpAmount > 0) {
        if (isCashAccount(s.accountId, true)) {
          retailCashIn = roundMoney(retailCashIn + dpAmount);
        } else {
          retailTransferTotal = roundMoney(retailTransferTotal + dpAmount);
        }
      }
    }
  }

  let miniAtmTxCount = 0;
  let miniAtmCashIn = 0;
  let miniAtmCashOut = 0;
  let miniAtmNonCashTotal = 0;

  for (const tx of input.miniAtmTransactions) {
    if (tx.recordedByUid !== input.targetCashierUid) continue;
    if (tx.status !== 'completed') continue;
    if (!isInDateRange(tx.transactionDate, input.periodStartDate, input.periodEndDate)) continue;

    miniAtmTxCount += 1;
    const principal = roundMoney(Math.max(0, Number(tx.principalAmount) || 0));
    const adminFee = roundMoney(Math.max(0, Number(tx.adminFee) || 0));
    const bankFee = roundMoney(Math.max(0, Number(tx.bankFee) || 0));
    const internalExtra = roundMoney(Math.max(0, Number(tx.internalExtraFee) || 0));
    const cashDrawerUsed = isCashAccount(tx.cashAccountId, true);

    if (tx.serviceType === 'tarik_tunai') {
      // Customer bayar via QRIS/kartu ke rekening bank warung (non-tunai); warung serahkan uang tunai ke customer.
      // Cash delta laci = -(principal - internalExtra) + adminFee
      const cashDelta = roundMoney(-(principal - internalExtra) + adminFee);
      if (cashDrawerUsed) {
        if (cashDelta >= 0) {
          miniAtmCashIn = roundMoney(miniAtmCashIn + cashDelta);
        } else {
          miniAtmCashOut = roundMoney(miniAtmCashOut + Math.abs(cashDelta));
        }
      }
      miniAtmNonCashTotal = roundMoney(miniAtmNonCashTotal + principal);
    } else {
      // Transfer Bank / Setor Tunai: pelanggan serahkan tunai (principal + adminFee) ke laci kas; bank transfer keluar.
      const cashIn = roundMoney(principal + adminFee);
      if (cashDrawerUsed) {
        miniAtmCashIn = roundMoney(miniAtmCashIn + cashIn);
      } else {
        miniAtmNonCashTotal = roundMoney(miniAtmNonCashTotal + cashIn);
      }
      miniAtmNonCashTotal = roundMoney(miniAtmNonCashTotal + principal + bankFee);
    }
  }

  let ppobTxCount = 0;
  let ppobCashIn = 0;
  let ppobCashOut = 0;
  let ppobNonCashTotal = 0;

  for (const tx of input.ppobTransactions) {
    if (tx.recordedByUid !== input.targetCashierUid) continue;
    if (tx.status === 'failed') continue;
    if (!isInDateRange(tx.transactionDate, input.periodStartDate, input.periodEndDate)) continue;

    ppobTxCount += 1;
    const customerTotal = roundMoney(
      Math.max(0, Number(tx.sellPrice) || 0) + Math.max(0, Number(tx.adminFee) || 0)
    );
    const capitalPrice = roundMoney(Math.max(0, Number(tx.capitalPrice) || 0));

    if (isCashAccount(tx.cashAccountId, true)) {
      ppobCashIn = roundMoney(ppobCashIn + customerTotal);
    } else {
      ppobNonCashTotal = roundMoney(ppobNonCashTotal + customerTotal);
    }

    // Jika sumber modal PPOB bukan akun deposit/bank melainkan secara tidak sengaja akun tunai, perhitungkan keluarnya
    if (isCashAccount(tx.accountId, false)) {
      ppobCashOut = roundMoney(ppobCashOut + capitalPrice);
    }
  }

  let receivablePaymentCount = 0;
  let receivableCashIn = 0;
  let receivableNonCashIn = 0;

  for (const r of input.receivables) {
    if (r.recordedByUid !== input.targetCashierUid) continue;
    if (r.type !== 'payment') continue;
    if (!isInDateRange(r.transactionDate, input.periodStartDate, input.periodEndDate)) continue;

    receivablePaymentCount += 1;
    const amount = roundMoney(Math.max(0, Number(r.amount) || 0));
    if (isCashAccount(r.accountId, true)) {
      receivableCashIn = roundMoney(receivableCashIn + amount);
    } else {
      receivableNonCashIn = roundMoney(receivableNonCashIn + amount);
    }
  }

  const totalCashIn = roundMoney(
    retailCashIn + miniAtmCashIn + ppobCashIn + receivableCashIn
  );
  const totalCashOut = roundMoney(miniAtmCashOut + ppobCashOut);
  const expectedCash = roundMoney(openingCash + totalCashIn - totalCashOut);
  const totalNonCashAmount = roundMoney(
    retailQrisTotal + retailTransferTotal + ppobNonCashTotal + receivableNonCashIn
  );

  return {
    periodStartDate: input.periodStartDate,
    periodEndDate: input.periodEndDate,
    openingCash,
    totalSalesAmount,
    retailTxCount,
    retailCashIn,
    retailQrisTotal,
    retailTransferTotal,
    retailDebtCreatedTotal,
    miniAtmTxCount,
    miniAtmCashIn,
    miniAtmCashOut,
    miniAtmNonCashTotal,
    ppobTxCount,
    ppobCashIn,
    ppobCashOut,
    ppobNonCashTotal,
    receivablePaymentCount,
    receivableCashIn,
    receivableNonCashIn,
    totalNonCashAmount,
    totalCashIn,
    totalCashOut,
    expectedCash,
  };
}
