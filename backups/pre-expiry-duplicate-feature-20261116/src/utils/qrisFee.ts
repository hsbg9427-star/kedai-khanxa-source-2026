import type {
  Account,
  Customer,
  Expense,
  Loan,
  LoanPayment,
  MiniAtmTransaction,
  PpobTransaction,
  Sale,
  StoreSetting,
} from '../types/database';
import { getTodayDateString } from './formatters';
import { roundMoney } from './unitConversion';

export const DEFAULT_QRIS_FEE_PERCENT = 0.3;

export type RetailPaymentMethod = 'cash' | 'transfer' | 'qris' | 'mixed' | 'debt';

export function getEffectiveQrisFeePercent(setting?: StoreSetting | null): number {
  const raw = setting?.qrisFeePercent;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 10) {
    return Number(raw.toFixed(4));
  }
  return DEFAULT_QRIS_FEE_PERCENT;
}

export interface SaleSettlementInput {
  totalAmount: number;
  paymentMethod: RetailPaymentMethod;
  paidAmount: number;
  cashPart?: number;
  qrisPart?: number;
  qrisFeePercent: number;
}

export interface SaleSettlementResult {
  paymentMethod: RetailPaymentMethod;
  paidAmount: number;
  changeAmount: number;
  debtAmount: number;
  cashPaidPart: number;
  qrisAmount: number;
  qrisFeeRate: number;
  qrisFeeAmount: number;
  netReceivedAmount: number;
  cashDepositAmount: number;
  qrisNetDepositAmount: number;
}

export function calculateSaleSettlement(input: SaleSettlementInput): SaleSettlementResult {
  const totalAmount = roundMoney(Math.max(0, Number(input.totalAmount) || 0));
  const feeRateRaw = Number(input.qrisFeePercent);
  const qrisFeeRateInput = Number.isFinite(feeRateRaw)
    ? Math.max(0, Math.min(10, Number(feeRateRaw.toFixed(4))))
    : DEFAULT_QRIS_FEE_PERCENT;

  if (input.paymentMethod === 'debt') {
    const rawPaid = roundMoney(Math.max(0, Number(input.paidAmount) || 0));
    if (rawPaid >= totalAmount && totalAmount > 0) {
      throw new Error(
        'Nominal DP sama dengan atau melebihi total tagihan. Pilih metode Tunai/Transfer/QRIS jika dibayar lunas.'
      );
    }
    const debtAmount = roundMoney(Math.max(0, totalAmount - rawPaid));
    return {
      paymentMethod: 'debt',
      paidAmount: rawPaid,
      changeAmount: 0,
      debtAmount,
      cashPaidPart: rawPaid,
      qrisAmount: 0,
      qrisFeeRate: 0,
      qrisFeeAmount: 0,
      netReceivedAmount: rawPaid,
      cashDepositAmount: rawPaid,
      qrisNetDepositAmount: 0,
    };
  }

  if (input.paymentMethod === 'mixed') {
    const cleanQris = roundMoney(Math.max(0, Number(input.qrisPart) || 0));
    const cleanCash = roundMoney(Math.max(0, Number(input.cashPart) || 0));

    if (cleanQris <= 0) {
      throw new Error('Nominal bagian QRIS harus lebih dari Rp0 untuk pembayaran gabungan.');
    }
    if (cleanCash <= 0) {
      throw new Error('Nominal bagian Tunai harus lebih dari Rp0 untuk pembayaran gabungan.');
    }
    if (cleanQris > totalAmount) {
      throw new Error('Nominal bagian QRIS tidak boleh melebihi total tagihan.');
    }

    const paidAmount = roundMoney(cleanCash + cleanQris);
    if (paidAmount < totalAmount) {
      throw new Error('Total gabungan Tunai + QRIS kurang dari total belanja.');
    }

    const changeAmount = roundMoney(Math.max(0, paidAmount - totalAmount));
    const effectiveCashIn = roundMoney(Math.max(0, totalAmount - cleanQris));
    const qrisFeeAmount = roundMoney(cleanQris * (qrisFeeRateInput / 100));
    const qrisNetDepositAmount = roundMoney(Math.max(0, cleanQris - qrisFeeAmount));
    const netReceivedAmount = roundMoney(effectiveCashIn + qrisNetDepositAmount);

    return {
      paymentMethod: 'mixed',
      paidAmount,
      changeAmount,
      debtAmount: 0,
      cashPaidPart: effectiveCashIn,
      qrisAmount: cleanQris,
      qrisFeeRate: qrisFeeRateInput,
      qrisFeeAmount,
      netReceivedAmount,
      cashDepositAmount: effectiveCashIn,
      qrisNetDepositAmount,
    };
  }

  const paidAmount = roundMoney(Math.max(0, Number(input.paidAmount) || 0));
  if (paidAmount < totalAmount) {
    throw new Error('Nominal pembayaran kurang dari total belanja.');
  }
  const changeAmount = roundMoney(Math.max(0, paidAmount - totalAmount));

  if (input.paymentMethod === 'qris') {
    const qrisAmount = totalAmount;
    const qrisFeeAmount = roundMoney(qrisAmount * (qrisFeeRateInput / 100));
    const qrisNetDepositAmount = roundMoney(Math.max(0, qrisAmount - qrisFeeAmount));

    return {
      paymentMethod: 'qris',
      paidAmount,
      changeAmount,
      debtAmount: 0,
      cashPaidPart: 0,
      qrisAmount,
      qrisFeeRate: qrisFeeRateInput,
      qrisFeeAmount,
      netReceivedAmount: qrisNetDepositAmount,
      cashDepositAmount: 0,
      qrisNetDepositAmount,
    };
  }

  // cash or transfer -> zero QRIS fee
  return {
    paymentMethod: input.paymentMethod,
    paidAmount,
    changeAmount,
    debtAmount: 0,
    cashPaidPart: input.paymentMethod === 'cash' ? totalAmount : 0,
    qrisAmount: 0,
    qrisFeeRate: 0,
    qrisFeeAmount: 0,
    netReceivedAmount: totalAmount,
    cashDepositAmount: totalAmount,
    qrisNetDepositAmount: 0,
  };
}

export type LoanDisplayStatus = 'Lunas' | 'Terlambat' | 'Cicilan' | 'Belum Bayar';

export function getLoanDisplayStatus(
  loan: Pick<Loan, 'remainingAmount' | 'paidAmount' | 'dueDate'>,
  todayDateStr: string = getTodayDateString()
): LoanDisplayStatus {
  const remaining = roundMoney(Number(loan.remainingAmount) || 0);
  const paid = roundMoney(Number(loan.paidAmount) || 0);
  if (remaining <= 0) {
    return 'Lunas';
  }
  if (loan.dueDate && loan.dueDate < todayDateStr) {
    return 'Terlambat';
  }
  if (paid > 0) {
    return 'Cicilan';
  }
  return 'Belum Bayar';
}

export type ReportPeriodType = 'daily' | 'weekly' | 'monthly' | 'yearly';

function parseDateParts(dateStr: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateParts(dateObj: Date): string {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getPeriodDateRange(
  periodType: ReportPeriodType,
  anchorDateStr: string
): { startDate: string; endDate: string; label: string } {
  const base = parseDateParts(anchorDateStr);

  if (periodType === 'daily') {
    const dStr = formatDateParts(base);
    return {
      startDate: dStr,
      endDate: dStr,
      label: `Harian (${dStr})`,
    };
  }

  if (periodType === 'weekly') {
    const day = base.getDay(); // 0=Min, 1=Sen, ...
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(base.getFullYear(), base.getMonth(), base.getDate() + diffToMonday);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const startDate = formatDateParts(monday);
    const endDate = formatDateParts(sunday);
    return {
      startDate,
      endDate,
      label: `Mingguan (${startDate} s.d. ${endDate})`,
    };
  }

  if (periodType === 'monthly') {
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    const monthLabel = new Intl.DateTimeFormat('id-ID', {
      month: 'long',
      year: 'numeric',
    }).format(first);
    return {
      startDate: formatDateParts(first),
      endDate: formatDateParts(last),
      label: `Bulanan (${monthLabel})`,
    };
  }

  const year = base.getFullYear();
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    label: `Tahunan (${year})`,
  };
}

export interface FinancialAndQrisReportSummary {
  periodLabel: string;
  startDate: string;
  endDate: string;
  salesCount: number;
  salesRevenue: number; // Omzet kotor penjualan retail (sebelum biaya QRIS)
  salesCogs: number; // HPP total penjualan retail
  salesGrossProfit: number; // Laba retail (omzet - HPP)
  qrisTransactionCount: number;
  qrisGrossVolume: number; // Total nominal pembayaran lewat QRIS
  qrisFeeTotal: number; // Total biaya potongan QRIS (biaya transaksi pembayaran)
  qrisNetReceived: number; // Penerimaan bersih dari nominal QRIS (qrisGrossVolume - qrisFeeTotal)
  salesNetCashEquivalent: number; // Penerimaan bersih dari penjualan lunas/DP setelah potong QRIS
  miniAtmCount: number;
  miniAtmVolume: number;
  miniAtmProfit: number;
  ppobCount: number;
  ppobVolume: number;
  ppobProfit: number;
  expensesCount: number;
  expensesTotal: number;
  netOperatingProfit: number; // (salesGrossProfit + miniAtmProfit + ppobProfit) - qrisFeeTotal - expensesTotal
  loansDisbursedCountInPeriod: number;
  loansDisbursedInPeriod: number;
  loanPaymentsCountInPeriod: number;
  loanPaymentsInPeriod: number;
  totalLoansPrincipalAllTime: number;
  totalLoansPaidAllTime: number;
  totalLoansRemainingAllTime: number;
  overdueLoansCount: number;
  totalCustomerKasbonRemaining: number;
  totalActiveAccountBalance: number;
  qrisSalesRows: Sale[];
  periodSales: Sale[];
  periodMiniAtms: MiniAtmTransaction[];
  periodPpobs: PpobTransaction[];
  periodExpenses: Expense[];
}

export function buildFinancialAndQrisReport(params: {
  periodType: ReportPeriodType;
  anchorDateStr: string;
  todayDateStr?: string;
  sales: Sale[];
  loans: Loan[];
  loanPayments: LoanPayment[];
  customers: Customer[];
  accounts: Account[];
  expenses?: Expense[];
  miniAtmTransactions?: MiniAtmTransaction[];
  ppobTransactions?: PpobTransaction[];
}): FinancialAndQrisReportSummary {
  const { startDate, endDate, label } = getPeriodDateRange(params.periodType, params.anchorDateStr);
  const todayStr = params.todayDateStr || getTodayDateString();
  const inRange = (d?: string) => Boolean(d && d >= startDate && d <= endDate);

  const periodSales = params.sales.filter(
    (s) => s.status === 'completed' && inRange(s.transactionDate)
  );

  let salesRevenue = 0;
  let salesCogs = 0;
  let salesGrossProfit = 0;
  let qrisTransactionCount = 0;
  let qrisGrossVolume = 0;
  let qrisFeeTotal = 0;
  let salesNetCashEquivalent = 0;
  const qrisSalesRows: Sale[] = [];

  for (const s of periodSales) {
    const rev = roundMoney(Number(s.totalAmount) || 0);
    const cost = roundMoney(Number(s.totalCost) || 0);
    const profit =
      s.totalProfit !== undefined ? roundMoney(Number(s.totalProfit) || 0) : roundMoney(rev - cost);

    salesRevenue = roundMoney(salesRevenue + rev);
    salesCogs = roundMoney(salesCogs + cost);
    salesGrossProfit = roundMoney(salesGrossProfit + profit);

    const qAmt = roundMoney(Number(s.qrisAmount) || 0);
    const qFee = roundMoney(Number(s.qrisFeeAmount) || 0);
    if (qAmt > 0 || s.paymentMethod === 'qris' || s.paymentMethod === 'mixed') {
      qrisTransactionCount += 1;
      qrisGrossVolume = roundMoney(qrisGrossVolume + qAmt);
      qrisFeeTotal = roundMoney(qrisFeeTotal + qFee);
      qrisSalesRows.push(s);
    }

    if (s.netReceivedAmount !== undefined) {
      salesNetCashEquivalent = roundMoney(salesNetCashEquivalent + Number(s.netReceivedAmount));
    } else if (s.paymentMethod === 'debt') {
      salesNetCashEquivalent = roundMoney(salesNetCashEquivalent + Number(s.paidAmount || 0));
    } else {
      salesNetCashEquivalent = roundMoney(salesNetCashEquivalent + Math.max(0, rev - qFee));
    }
  }

  const qrisNetReceived = roundMoney(Math.max(0, qrisGrossVolume - qrisFeeTotal));

  const periodMiniAtms = (params.miniAtmTransactions || []).filter(
    (t) => t.status === 'completed' && inRange(t.transactionDate)
  );
  const miniAtmVolume = roundMoney(
    periodMiniAtms.reduce((sum, t) => sum + (Number(t.principalAmount) || 0), 0)
  );
  const miniAtmProfit = roundMoney(
    periodMiniAtms.reduce((sum, t) => sum + (Number(t.netProfit) || 0), 0)
  );

  const periodPpobs = (params.ppobTransactions || []).filter(
    (t) => t.status === 'completed' && inRange(t.transactionDate)
  );
  const ppobVolume = roundMoney(
    periodPpobs.reduce(
      (sum, t) => sum + (Number(t.sellPrice) || 0) + (Number(t.adminFee) || 0),
      0
    )
  );
  const ppobProfit = roundMoney(
    periodPpobs.reduce((sum, t) => sum + (Number(t.netProfit) || 0), 0)
  );

  const periodExpenses = (params.expenses || []).filter((e) => inRange(e.transactionDate));
  const expensesTotal = roundMoney(
    periodExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
  );

  const netOperatingProfit = roundMoney(
    salesGrossProfit + miniAtmProfit + ppobProfit - qrisFeeTotal - expensesTotal
  );

  const periodLoans = params.loans.filter((l) => inRange(l.loanDate || l.transactionDate));
  const loansDisbursedInPeriod = roundMoney(
    periodLoans.reduce((sum, l) => sum + (Number(l.principalAmount) || 0), 0)
  );

  const periodLoanPayments = params.loanPayments.filter((p) => inRange(p.transactionDate));
  const loanPaymentsInPeriod = roundMoney(
    periodLoanPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
  );

  const totalLoansPrincipalAllTime = roundMoney(
    params.loans.reduce((sum, l) => sum + (Number(l.principalAmount) || 0), 0)
  );
  const totalLoansPaidAllTime = roundMoney(
    params.loans.reduce((sum, l) => sum + (Number(l.paidAmount) || 0), 0)
  );
  const totalLoansRemainingAllTime = roundMoney(
    params.loans.reduce((sum, l) => sum + Math.max(0, Number(l.remainingAmount) || 0), 0)
  );
  const overdueLoansCount = params.loans.filter(
    (l) => getLoanDisplayStatus(l, todayStr) === 'Terlambat'
  ).length;

  const totalCustomerKasbonRemaining = roundMoney(
    params.customers.reduce((sum, c) => sum + Math.max(0, Number(c.totalDebt) || 0), 0)
  );

  const totalActiveAccountBalance = roundMoney(
    params.accounts
      .filter((a) => a.isActive)
      .reduce((sum, a) => sum + (Number(a.balance) || 0), 0)
  );

  return {
    periodLabel: label,
    startDate,
    endDate,
    salesCount: periodSales.length,
    salesRevenue,
    salesCogs,
    salesGrossProfit,
    qrisTransactionCount,
    qrisGrossVolume,
    qrisFeeTotal,
    qrisNetReceived,
    salesNetCashEquivalent,
    miniAtmCount: periodMiniAtms.length,
    miniAtmVolume,
    miniAtmProfit,
    ppobCount: periodPpobs.length,
    ppobVolume,
    ppobProfit,
    expensesCount: periodExpenses.length,
    expensesTotal,
    netOperatingProfit,
    loansDisbursedCountInPeriod: periodLoans.length,
    loansDisbursedInPeriod,
    loanPaymentsCountInPeriod: periodLoanPayments.length,
    loanPaymentsInPeriod,
    totalLoansPrincipalAllTime,
    totalLoansPaidAllTime,
    totalLoansRemainingAllTime,
    overdueLoansCount,
    totalCustomerKasbonRemaining,
    totalActiveAccountBalance,
    qrisSalesRows,
    periodSales,
    periodMiniAtms,
    periodPpobs,
    periodExpenses,
  };
}
