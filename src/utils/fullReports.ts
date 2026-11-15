import type {
  Account,
  CashLedger,
  Category,
  Expense,
  HppMethod,
  Loan,
  LoanPayment,
  MiniAtmTransaction,
  PpobTransaction,
  Product,
  Purchase,
  PurchaseItem,
  PurchaseReturn,
  Sale,
  SaleItem,
  StoreSetting,
  SupplierPayment,
} from '../types/database';
import { getTodayDateString } from './formatters';
import { getLoanDisplayStatus, getPeriodDateRange, type ReportPeriodType } from './qrisFee';
import { roundMoney, roundQty } from './unitConversion';

export type ExtendedReportPeriodType = ReportPeriodType | 'range';
export type TrendGranularity = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ResolvedReportPeriod {
  periodType: ExtendedReportPeriodType;
  startDate: string;
  endDate: string;
  label: string;
  prevStartDate: string;
  prevEndDate: string;
  prevLabel: string;
}

function parseYmd(dateStr: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function formatYmd(dateObj: Date): string {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr: string, deltaDays: number): string {
  const d = parseYmd(dateStr);
  d.setDate(d.getDate() + deltaDays);
  return formatYmd(d);
}

function diffDaysInclusive(startStr: string, endStr: string): number {
  const s = parseYmd(startStr).getTime();
  const e = parseYmd(endStr).getTime();
  return Math.max(1, Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1);
}

export function getEffectiveHppMethod(setting?: StoreSetting | null): HppMethod {
  return setting?.hppMethod === 'fifo' ? 'fifo' : 'moving_average';
}

export function getHppMethodLabel(method: HppMethod): string {
  return method === 'fifo' ? 'FIFO (First In, First Out)' : 'Moving Average (Rata-rata Tertimbang)';
}

export function resolveReportPeriod(params: {
  periodType: ExtendedReportPeriodType;
  anchorDateStr: string;
  customStartDate?: string;
  customEndDate?: string;
}): ResolvedReportPeriod {
  const { periodType, anchorDateStr } = params;

  if (periodType === 'range') {
    const rawStart = params.customStartDate || anchorDateStr;
    const rawEnd = params.customEndDate || anchorDateStr;
    const startDate = rawStart <= rawEnd ? rawStart : rawEnd;
    const endDate = rawStart <= rawEnd ? rawEnd : rawStart;
    const spanDays = diffDaysInclusive(startDate, endDate);
    const prevEndDate = addDays(startDate, -1);
    const prevStartDate = addDays(prevEndDate, -(spanDays - 1));
    return {
      periodType,
      startDate,
      endDate,
      label: `Rentang (${startDate} s.d. ${endDate})`,
      prevStartDate,
      prevEndDate,
      prevLabel: `Sebelumnya (${prevStartDate} s.d. ${prevEndDate})`,
    };
  }

  const current = getPeriodDateRange(periodType, anchorDateStr);

  if (periodType === 'daily') {
    const prevDate = addDays(current.startDate, -1);
    return {
      periodType,
      ...current,
      prevStartDate: prevDate,
      prevEndDate: prevDate,
      prevLabel: `Hari sebelumnya (${prevDate})`,
    };
  }

  if (periodType === 'weekly') {
    const prevStartDate = addDays(current.startDate, -7);
    const prevEndDate = addDays(current.endDate, -7);
    return {
      periodType,
      ...current,
      prevStartDate,
      prevEndDate,
      prevLabel: `Minggu sebelumnya (${prevStartDate} s.d. ${prevEndDate})`,
    };
  }

  if (periodType === 'monthly') {
    const base = parseYmd(current.startDate);
    const prevFirst = new Date(base.getFullYear(), base.getMonth() - 1, 1);
    const prevLast = new Date(base.getFullYear(), base.getMonth(), 0);
    const monthLabel = new Intl.DateTimeFormat('id-ID', {
      month: 'long',
      year: 'numeric',
    }).format(prevFirst);
    return {
      periodType,
      ...current,
      prevStartDate: formatYmd(prevFirst),
      prevEndDate: formatYmd(prevLast),
      prevLabel: `Bulan sebelumnya (${monthLabel})`,
    };
  }

  const baseYear = parseYmd(current.startDate).getFullYear() - 1;
  return {
    periodType,
    ...current,
    prevStartDate: `${baseYear}-01-01`,
    prevEndDate: `${baseYear}-12-31`,
    prevLabel: `Tahun sebelumnya (${baseYear})`,
  };
}

// ---------------------------------------------------------------------------
// 1. LAPORAN PERGERAKAN SALDO
// ---------------------------------------------------------------------------

export type BalanceBucketKey = 'cash' | 'dana' | 'bank' | 'ppob_deposit';

export const BALANCE_BUCKETS: { key: BalanceBucketKey; label: string; shortLabel: string }[] = [
  { key: 'cash', label: 'Laci Kas', shortLabel: 'Laci Kas' },
  { key: 'dana', label: 'DANA / E-Wallet', shortLabel: 'DANA' },
  { key: 'bank', label: 'Rekening Bank', shortLabel: 'Bank' },
  { key: 'ppob_deposit', label: 'Deposit PPOB', shortLabel: 'Deposit PPOB' },
];

export type LedgerCategoryKey =
  | 'penjualan_retail'
  | 'penjualan_qris'
  | 'pembayaran_kasbon'
  | 'pembelian'
  | 'pembayaran_utang'
  | 'retur_pembelian'
  | 'pinjaman_pelanggan'
  | 'cicilan_pinjaman'
  | 'biaya_operasional'
  | 'mini_atm'
  | 'ppob'
  | 'mutasi_rekening'
  | 'modal';

export const LEDGER_CATEGORY_LABELS: Record<LedgerCategoryKey, string> = {
  penjualan_retail: 'Penjualan Retail',
  penjualan_qris: 'QRIS (Bersih Penjualan)',
  pembayaran_kasbon: 'Pembayaran Kasbon',
  pembelian: 'Pembelian Barang',
  pembayaran_utang: 'Pembayaran Utang Pemasok',
  retur_pembelian: 'Retur Pembelian',
  pinjaman_pelanggan: 'Pinjaman Pelanggan',
  cicilan_pinjaman: 'Cicilan Pinjaman',
  biaya_operasional: 'Biaya Operasional',
  mini_atm: 'Mini ATM',
  ppob: 'PPOB',
  mutasi_rekening: 'Mutasi Antar Rekening',
  modal: 'Modal / Prive',
};

export function resolveAccountBucket(
  account: Pick<Account, 'type' | 'name'> | undefined | null,
  fallbackAccountName?: string
): BalanceBucketKey {
  if (account) {
    if (account.type === 'cash') return 'cash';
    if (account.type === 'ewallet') return 'dana';
    if (account.type === 'bank') return 'bank';
    if (account.type === 'ppob_deposit') return 'ppob_deposit';
  }
  const lower = (fallbackAccountName || account?.name || '').toLowerCase();
  if (lower.includes('ppob') || lower.includes('deposit')) return 'ppob_deposit';
  if (lower.includes('dana') || lower.includes('ovo') || lower.includes('gopay') || lower.includes('qris')) {
    return 'dana';
  }
  if (
    lower.includes('bank') ||
    lower.includes('bca') ||
    lower.includes('bri') ||
    lower.includes('bni') ||
    lower.includes('mandiri') ||
    lower.includes('bsi') ||
    lower.includes('seabank')
  ) {
    return 'bank';
  }
  return 'cash';
}

export function classifyCashLedgerRow(row: CashLedger): {
  categoryKey: LedgerCategoryKey;
  categoryLabel: string;
} {
  const trxNo = (row.transactionNumber || '').toUpperCase();
  const desc = (row.description || '').toLowerCase();

  let categoryKey: LedgerCategoryKey = 'modal';
  switch (row.sourceModule) {
    case 'sale':
      categoryKey =
        trxNo.endsWith('-Q') || desc.includes('qris') ? 'penjualan_qris' : 'penjualan_retail';
      break;
    case 'receivable':
      categoryKey = 'pembayaran_kasbon';
      break;
    case 'purchase':
      if (trxNo.startsWith('BPM-') || desc.includes('bayar utang pemasok')) {
        categoryKey = 'pembayaran_utang';
      } else if (trxNo.startsWith('RTR-') || desc.includes('retur pembelian')) {
        categoryKey = 'retur_pembelian';
      } else {
        categoryKey = 'pembelian';
      }
      break;
    case 'loan':
      categoryKey =
        row.direction === 'out' || trxNo.startsWith('PJM-')
          ? 'pinjaman_pelanggan'
          : 'cicilan_pinjaman';
      break;
    case 'expense':
      categoryKey = 'biaya_operasional';
      break;
    case 'mini_atm':
      categoryKey = 'mini_atm';
      break;
    case 'ppob':
      categoryKey = 'ppob';
      break;
    case 'transfer':
      categoryKey = 'mutasi_rekening';
      break;
    case 'capital':
    default:
      categoryKey = 'modal';
      break;
  }

  return {
    categoryKey,
    categoryLabel: LEDGER_CATEGORY_LABELS[categoryKey],
  };
}

export interface AccountBalanceMovementRow {
  accountId: string;
  accountName: string;
  accountType: Account['type'];
  bucket: BalanceBucketKey;
  bucketLabel: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  transferIn: number;
  transferOut: number;
  closingBalance: number;
  currentLiveBalance: number;
  transactionCount: number;
}

export interface BucketBalanceSummary {
  key: BalanceBucketKey;
  label: string;
  accountCount: number;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  transferIn: number;
  transferOut: number;
  closingBalance: number;
}

export interface InterAccountTransferEvent {
  id: string;
  referenceNumber: string;
  transactionDate: string;
  transactionTime: string;
  fromAccountName: string;
  toAccountName: string;
  amount: number;
  description: string;
  recordedByName: string;
}

export interface LedgerTypeBreakdownRow {
  categoryKey: LedgerCategoryKey;
  categoryLabel: string;
  count: number;
  totalIn: number;
  totalOut: number;
  netFlow: number;
}

export interface ClassifiedLedgerRow extends CashLedger {
  bucket: BalanceBucketKey;
  bucketLabel: string;
  categoryKey: LedgerCategoryKey;
  categoryLabel: string;
}

export interface BalanceMovementReport {
  startDate: string;
  endDate: string;
  bucketSummaries: BucketBalanceSummary[];
  accountRows: AccountBalanceMovementRow[];
  totalOpeningBalance: number;
  totalIn: number;
  totalOut: number;
  totalClosingBalance: number;
  transferEvents: InterAccountTransferEvent[];
  totalTransferVolume: number;
  typeBreakdown: LedgerTypeBreakdownRow[];
  periodLedgerRows: ClassifiedLedgerRow[];
}

export function computeAccountBalanceMovements(params: {
  accounts: Account[];
  cashLedger: CashLedger[];
  startDate: string;
  endDate: string;
}): BalanceMovementReport {
  const { accounts, cashLedger, startDate, endDate } = params;
  const accountMap = new Map<string, Account>();
  accounts.forEach((a) => accountMap.set(a.id, a));

  const bucketLabelMap = new Map<BalanceBucketKey, string>(
    BALANCE_BUCKETS.map((b) => [b.key, b.label])
  );

  // Per-account computations
  const rowsByAcc = new Map<string, CashLedger[]>();
  cashLedger.forEach((row) => {
    const list = rowsByAcc.get(row.accountId) || [];
    list.push(row);
    rowsByAcc.set(row.accountId, list);
  });

  const accountRows: AccountBalanceMovementRow[] = accounts.map((acc) => {
    const accRows = rowsByAcc.get(acc.id) || [];
    let deltaAfterEnd = 0;
    let totalIn = 0;
    let totalOut = 0;
    let transferIn = 0;
    let transferOut = 0;
    let txCount = 0;

    for (const r of accRows) {
      const amt = roundMoney(Math.max(0, Number(r.amount) || 0));
      const d = r.transactionDate || '';
      if (d > endDate) {
        deltaAfterEnd = roundMoney(deltaAfterEnd + (r.direction === 'in' ? amt : -amt));
      } else if (d >= startDate && d <= endDate) {
        txCount += 1;
        if (r.direction === 'in') {
          totalIn = roundMoney(totalIn + amt);
          if (r.sourceModule === 'transfer') {
            transferIn = roundMoney(transferIn + amt);
          }
        } else {
          totalOut = roundMoney(totalOut + amt);
          if (r.sourceModule === 'transfer') {
            transferOut = roundMoney(transferOut + amt);
          }
        }
      }
    }

    const currentLiveBalance = roundMoney(Number(acc.balance) || 0);
    const closingBalance = roundMoney(currentLiveBalance - deltaAfterEnd);
    const openingBalance = roundMoney(closingBalance - totalIn + totalOut);
    const bucket = resolveAccountBucket(acc, acc.name);

    return {
      accountId: acc.id,
      accountName: acc.name,
      accountType: acc.type,
      bucket,
      bucketLabel: bucketLabelMap.get(bucket) || 'Lainnya',
      openingBalance,
      totalIn,
      totalOut,
      transferIn,
      transferOut,
      closingBalance,
      currentLiveBalance,
      transactionCount: txCount,
    };
  });

  const bucketSummaries: BucketBalanceSummary[] = BALANCE_BUCKETS.map((b) => {
    const members = accountRows.filter((r) => r.bucket === b.key);
    return {
      key: b.key,
      label: b.label,
      accountCount: members.length,
      openingBalance: roundMoney(members.reduce((s, r) => s + r.openingBalance, 0)),
      totalIn: roundMoney(members.reduce((s, r) => s + r.totalIn, 0)),
      totalOut: roundMoney(members.reduce((s, r) => s + r.totalOut, 0)),
      transferIn: roundMoney(members.reduce((s, r) => s + r.transferIn, 0)),
      transferOut: roundMoney(members.reduce((s, r) => s + r.transferOut, 0)),
      closingBalance: roundMoney(members.reduce((s, r) => s + r.closingBalance, 0)),
    };
  });

  const periodRowsRaw = cashLedger
    .filter((r) => r.transactionDate >= startDate && r.transactionDate <= endDate)
    .sort((a, b) =>
      `${b.transactionDate} ${b.transactionTime}`.localeCompare(
        `${a.transactionDate} ${a.transactionTime}`
      )
    );

  const periodLedgerRows: ClassifiedLedgerRow[] = periodRowsRaw.map((r) => {
    const acc = accountMap.get(r.accountId);
    const bucket = resolveAccountBucket(acc, r.accountName);
    const { categoryKey, categoryLabel } = classifyCashLedgerRow(r);
    return {
      ...r,
      bucket,
      bucketLabel: bucketLabelMap.get(bucket) || 'Laci Kas',
      categoryKey,
      categoryLabel,
    };
  });

  // Group inter-account transfers
  const transferGroups = new Map<
    string,
    { outRow?: ClassifiedLedgerRow; inRow?: ClassifiedLedgerRow }
  >();
  periodLedgerRows
    .filter((r) => r.sourceModule === 'transfer')
    .forEach((r) => {
      const baseRef = (
        r.referenceId ||
        r.transactionNumber.replace(/-(OUT|IN)$/i, '') ||
        r.id
      ).trim();
      const entry = transferGroups.get(baseRef) || {};
      if (r.direction === 'out') entry.outRow = r;
      else entry.inRow = r;
      transferGroups.set(baseRef, entry);
    });

  const transferEvents: InterAccountTransferEvent[] = Array.from(transferGroups.entries()).map(
    ([refNo, g]) => {
      const primary = g.outRow || g.inRow!;
      return {
        id: refNo,
        referenceNumber: refNo,
        transactionDate: primary.transactionDate,
        transactionTime: primary.transactionTime,
        fromAccountName: g.outRow?.accountName || '-',
        toAccountName: g.inRow?.accountName || '-',
        amount: roundMoney(Number(primary.amount) || 0),
        description: primary.description,
        recordedByName: primary.recordedByName,
      };
    }
  );
  transferEvents.sort((a, b) =>
    `${b.transactionDate} ${b.transactionTime}`.localeCompare(
      `${a.transactionDate} ${a.transactionTime}`
    )
  );
  const totalTransferVolume = roundMoney(transferEvents.reduce((s, e) => s + e.amount, 0));

  // Breakdown by transaction type
  const breakdownMap = new Map<LedgerCategoryKey, LedgerTypeBreakdownRow>();
  Object.entries(LEDGER_CATEGORY_LABELS).forEach(([key, label]) => {
    breakdownMap.set(key as LedgerCategoryKey, {
      categoryKey: key as LedgerCategoryKey,
      categoryLabel: label,
      count: 0,
      totalIn: 0,
      totalOut: 0,
      netFlow: 0,
    });
  });

  for (const r of periodLedgerRows) {
    const slot = breakdownMap.get(r.categoryKey)!;
    const amt = roundMoney(Math.max(0, Number(r.amount) || 0));
    slot.count += 1;
    if (r.direction === 'in') {
      slot.totalIn = roundMoney(slot.totalIn + amt);
    } else {
      slot.totalOut = roundMoney(slot.totalOut + amt);
    }
    slot.netFlow = roundMoney(slot.totalIn - slot.totalOut);
  }

  const typeBreakdown = Array.from(breakdownMap.values()).filter((row) => row.count > 0);

  const totalOpeningBalance = roundMoney(accountRows.reduce((s, r) => s + r.openingBalance, 0));
  const totalIn = roundMoney(accountRows.reduce((s, r) => s + r.totalIn, 0));
  const totalOut = roundMoney(accountRows.reduce((s, r) => s + r.totalOut, 0));
  const totalClosingBalance = roundMoney(accountRows.reduce((s, r) => s + r.closingBalance, 0));

  return {
    startDate,
    endDate,
    bucketSummaries,
    accountRows,
    totalOpeningBalance,
    totalIn,
    totalOut,
    totalClosingBalance,
    transferEvents,
    totalTransferVolume,
    typeBreakdown,
    periodLedgerRows,
  };
}

// ---------------------------------------------------------------------------
// 2. MESIN HPP (FIFO vs MOVING AVERAGE) & LAPORAN LABA
// ---------------------------------------------------------------------------

interface FifoBatch {
  qty: number;
  unitCost: number;
}

export interface ComputedSaleItemCost {
  saleId: string;
  itemId: string;
  productId: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  transactionDate: string;
  baseUnit: string;
  baseQty: number;
  netRevenue: number;
  cogsMovingAverage: number;
  cogsFifo: number;
  cogsActive: number;
  profitActive: number;
}

export interface ComputedSaleValuation {
  sale: Sale;
  revenue: number;
  cogsMovingAverage: number;
  cogsFifo: number;
  cogsActive: number;
  grossProfitActive: number;
  items: ComputedSaleItemCost[];
}

export interface ProfitLossReport {
  hppMethod: HppMethod;
  hppMethodLabel: string;
  startDate: string;
  endDate: string;
  salesCount: number;
  salesRevenue: number;
  salesCogsActive: number;
  salesCogsMovingAverage: number;
  salesCogsFifo: number;
  salesGrossProfit: number;
  salesGrossProfitMovingAverage: number;
  salesGrossProfitFifo: number;
  miniAtmCount: number;
  miniAtmVolume: number;
  miniAtmProfit: number;
  ppobCount: number;
  ppobVolume: number;
  ppobProfit: number;
  serviceProfitTotal: number;
  qrisTransactionCount: number;
  qrisGrossVolume: number;
  qrisFeeTotal: number;
  qrisNetReceived: number;
  expensesCount: number;
  expensesTotal: number;
  netOperatingProfit: number;
  // Pos Non-Laba (dipisahkan tegas & tidak dihitung sebagai laba/rugi)
  nonProfitFlows: {
    loansDisbursedCount: number;
    loansDisbursedAmount: number;
    loanPaymentsCount: number;
    loanPaymentsAmount: number;
    kasbonPaymentsAmount: number;
    capitalInAmount: number;
    capitalOutAmount: number;
    transferVolumeAmount: number;
    purchasesPaidAmount: number;
    supplierDebtPaymentsAmount: number;
    totalLoansRemainingAllTime: number;
    totalCustomerKasbonRemaining: number;
    overdueLoansCount: number;
  };
  valuationsBySaleId: Map<string, ComputedSaleValuation>;
  allComputedItems: ComputedSaleItemCost[];
  periodSales: Sale[];
  qrisSalesRows: Sale[];
  periodMiniAtms: MiniAtmTransaction[];
  periodPpobs: PpobTransaction[];
  periodExpenses: Expense[];
}

function getSaleItemBaseQty(item: SaleItem): number {
  if (item.baseQuantity !== undefined && Number.isFinite(Number(item.baseQuantity))) {
    return roundQty(Math.max(0, Number(item.baseQuantity)));
  }
  const rawConv = Number(item.conversion);
  const conv = Number.isFinite(rawConv) && rawConv > 0 ? rawConv : 1;
  return roundQty(Math.max(0, (Number(item.quantity) || 0) * conv));
}

function getPurchaseItemBaseQty(item: PurchaseItem): number {
  if (item.baseQuantity !== undefined && Number.isFinite(Number(item.baseQuantity))) {
    return roundQty(Math.max(0, Number(item.baseQuantity)));
  }
  const rawConv = Number(item.conversion);
  const conv = Number.isFinite(rawConv) && rawConv > 0 ? rawConv : 1;
  return roundQty(Math.max(0, (Number(item.quantity) || 0) * conv));
}

function getPurchaseItemUnitCost(item: PurchaseItem, baseQty: number): number {
  if (
    item.effectiveBaseUnitCost !== undefined &&
    Number.isFinite(Number(item.effectiveBaseUnitCost)) &&
    Number(item.effectiveBaseUnitCost) >= 0
  ) {
    return Number(item.effectiveBaseUnitCost);
  }
  if (
    item.netLineTotal !== undefined &&
    Number.isFinite(Number(item.netLineTotal)) &&
    baseQty > 0
  ) {
    return Number(item.netLineTotal) / baseQty;
  }
  const conv = Math.max(0.0001, Number(item.conversion) || 1);
  return Math.max(0, Number(item.unitCost) || 0) / conv;
}

export function computeProfitAndLossReport(params: {
  hppMethod: HppMethod;
  startDate: string;
  endDate: string;
  todayDateStr?: string;
  products: Product[];
  sales: Sale[];
  saleItemsMap: Record<string, SaleItem[]>;
  purchases: Purchase[];
  purchaseItemsMap: Record<string, PurchaseItem[]>;
  purchaseReturns: PurchaseReturn[];
  miniAtms: MiniAtmTransaction[];
  ppobs: PpobTransaction[];
  expenses: Expense[];
  cashLedger: CashLedger[];
  loans: Loan[];
  loanPayments: LoanPayment[];
  customers: { totalDebt: number }[];
  supplierPayments?: SupplierPayment[];
}): ProfitLossReport {
  const {
    hppMethod,
    startDate,
    endDate,
    products,
    sales,
    saleItemsMap,
    purchases,
    purchaseItemsMap,
    purchaseReturns,
    miniAtms,
    ppobs,
    expenses,
    cashLedger,
    loans,
    loanPayments,
    customers,
    supplierPayments = [],
  } = params;

  const todayStr = params.todayDateStr || getTodayDateString();
  const productMap = new Map<string, Product>();
  products.forEach((p) => productMap.set(p.id, p));

  const completedSalesChrono = sales
    .filter((s) => s.status === 'completed')
    .slice()
    .sort((a, b) =>
      `${a.transactionDate} ${a.transactionTime}`.localeCompare(
        `${b.transactionDate} ${b.transactionTime}`
      )
    );

  const completedPurchasesChrono = purchases
    .filter((p) => p.status === 'completed')
    .slice()
    .sort((a, b) =>
      `${a.transactionDate} ${a.transactionTime}`.localeCompare(
        `${b.transactionDate} ${b.transactionTime}`
      )
    );

  // Hitung retur per (purchaseId, productId) untuk mengurangi batch pembelian FIFO
  const returnQtyByPurchaseProduct = new Map<string, number>();
  purchaseReturns.forEach((ret) => {
    const key = `${ret.purchaseId}__${ret.productId}`;
    const prev = returnQtyByPurchaseProduct.get(key) || 0;
    returnQtyByPurchaseProduct.set(key, roundQty(prev + Math.max(0, Number(ret.returnBaseQty) || 0)));
  });

  // Hitung total beli neto & total terjual per produk untuk mendeteksi stok awal sebelum pembelian tercatat
  const netPurchasedByProduct = new Map<string, number>();
  const firstPurchaseBeforeHppByProduct = new Map<string, number>();

  for (const pur of completedPurchasesChrono) {
    const items = purchaseItemsMap[pur.id] || [];
    const remainingReturnMap = new Map<string, number>();
    items.forEach((it) => {
      const k = `${pur.id}__${it.productId}`;
      if (!remainingReturnMap.has(it.productId)) {
        remainingReturnMap.set(it.productId, returnQtyByPurchaseProduct.get(k) || 0);
      }
    });

    for (const it of items) {
      if (it.hppBefore !== undefined && !firstPurchaseBeforeHppByProduct.has(it.productId)) {
        firstPurchaseBeforeHppByProduct.set(it.productId, Math.max(0, Number(it.hppBefore) || 0));
      }
      const baseQty = getPurchaseItemBaseQty(it);
      const remRet = remainingReturnMap.get(it.productId) || 0;
      const deducted = Math.min(baseQty, remRet);
      remainingReturnMap.set(it.productId, roundQty(remRet - deducted));
      const netQty = roundQty(Math.max(0, baseQty - deducted));
      netPurchasedByProduct.set(
        it.productId,
        roundQty((netPurchasedByProduct.get(it.productId) || 0) + netQty)
      );
    }
  }

  const totalSoldByProduct = new Map<string, number>();
  const earliestSaleCostByProduct = new Map<string, number>();
  for (const s of completedSalesChrono) {
    const sItems = saleItemsMap[s.id] || [];
    for (const it of sItems) {
      const baseQty = getSaleItemBaseQty(it);
      totalSoldByProduct.set(
        it.productId,
        roundQty((totalSoldByProduct.get(it.productId) || 0) + baseQty)
      );
      if (!earliestSaleCostByProduct.has(it.productId) && Number(it.costPrice) >= 0) {
        earliestSaleCostByProduct.set(it.productId, Number(it.costPrice) || 0);
      }
    }
  }

  // Bangun antrean FIFO per produk dimulai dari estimasi stok awal historis
  const fifoQueues = new Map<string, FifoBatch[]>();
  const allProdIds = new Set<string>([
    ...products.map((p) => p.id),
    ...netPurchasedByProduct.keys(),
    ...totalSoldByProduct.keys(),
  ]);

  allProdIds.forEach((pid) => {
    const prod = productMap.get(pid);
    const liveStock = Math.max(0, Number(prod?.stock) || 0);
    const sold = totalSoldByProduct.get(pid) || 0;
    const netPur = netPurchasedByProduct.get(pid) || 0;
    const impliedOpeningQty = roundQty(Math.max(0, liveStock + sold - netPur));
    const queue: FifoBatch[] = [];
    if (impliedOpeningQty > 0) {
      const openCost =
        firstPurchaseBeforeHppByProduct.get(pid) ??
        earliestSaleCostByProduct.get(pid) ??
        Math.max(0, Number(prod?.costPrice) || 0);
      queue.push({ qty: impliedOpeningQty, unitCost: openCost });
    }
    fifoQueues.set(pid, queue);
  });

  // Gabungkan kronologi batch pembelian & penjualan agar FIFO konsumsi akurat di setiap waktu
  type TimelineEvent =
    | { kind: 'purchase'; sortKey: string; purchase: Purchase }
    | { kind: 'sale'; sortKey: string; sale: Sale };

  const timeline: TimelineEvent[] = [
    ...completedPurchasesChrono.map((purchase) => ({
      kind: 'purchase' as const,
      sortKey: `${purchase.transactionDate} ${purchase.transactionTime || '00:00:00'} 0`,
      purchase,
    })),
    ...completedSalesChrono.map((sale) => ({
      kind: 'sale' as const,
      sortKey: `${sale.transactionDate} ${sale.transactionTime || '23:59:59'} 1`,
      sale,
    })),
  ];
  timeline.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const valuationsBySaleId = new Map<string, ComputedSaleValuation>();
  const allComputedItems: ComputedSaleItemCost[] = [];

  for (const ev of timeline) {
    if (ev.kind === 'purchase') {
      const pur = ev.purchase;
      const items = purchaseItemsMap[pur.id] || [];
      const remReturn = new Map<string, number>();
      items.forEach((it) => {
        if (!remReturn.has(it.productId)) {
          remReturn.set(it.productId, returnQtyByPurchaseProduct.get(`${pur.id}__${it.productId}`) || 0);
        }
      });

      for (const it of items) {
        const baseQty = getPurchaseItemBaseQty(it);
        const rQty = remReturn.get(it.productId) || 0;
        const deduct = Math.min(baseQty, rQty);
        remReturn.set(it.productId, roundQty(rQty - deduct));
        const netBatchQty = roundQty(Math.max(0, baseQty - deduct));
        if (netBatchQty <= 0) continue;

        const unitCost = getPurchaseItemUnitCost(it, baseQty);
        const queue = fifoQueues.get(it.productId) || [];
        queue.push({ qty: netBatchQty, unitCost });
        fifoQueues.set(it.productId, queue);
      }
      continue;
    }

    // Event penjualan
    const sale = ev.sale;
    const rawItems = saleItemsMap[sale.id] || [];
    const saleRevenue = roundMoney(Math.max(0, Number(sale.totalAmount) || 0));

    if (rawItems.length === 0) {
      // Fallback bila subcollection items belum/tidak tersedia
      const fallbackCogs = roundMoney(Math.max(0, Number(sale.totalCost) || 0));
      const grossProfit = roundMoney(saleRevenue - fallbackCogs);
      valuationsBySaleId.set(sale.id, {
        sale,
        revenue: saleRevenue,
        cogsMovingAverage: fallbackCogs,
        cogsFifo: fallbackCogs,
        cogsActive: fallbackCogs,
        grossProfitActive: grossProfit,
        items: [],
      });
      continue;
    }

    const itemsSubtotalSum = roundMoney(
      rawItems.reduce((sum, it) => sum + Math.max(0, Number(it.subtotal) || 0), 0)
    );
    const saleDiscount = roundMoney(Math.max(0, itemsSubtotalSum - saleRevenue));

    let discountAllocated = 0;
    let saleMaCogs = 0;
    let saleFifoCogs = 0;
    const computedItems: ComputedSaleItemCost[] = [];

    rawItems.forEach((it, idx) => {
      const prod = productMap.get(it.productId);
      const baseQty = getSaleItemBaseQty(it);
      const rawItemSub = roundMoney(Math.max(0, Number(it.subtotal) || 0));

      let itemDisc = 0;
      if (saleDiscount > 0 && itemsSubtotalSum > 0) {
        if (idx === rawItems.length - 1) {
          itemDisc = roundMoney(saleDiscount - discountAllocated);
        } else {
          itemDisc = roundMoney((rawItemSub / itemsSubtotalSum) * saleDiscount);
          discountAllocated = roundMoney(discountAllocated + itemDisc);
        }
      }
      const netRevenue = roundMoney(Math.max(0, rawItemSub - itemDisc));

      // 1. Moving Average COGS: berasal dari HPP rata-rata tertimbang saat penjualan terjadi
      const maUnitCost = Math.max(
        0,
        it.costPrice !== undefined ? Number(it.costPrice) : Number(prod?.costPrice || 0)
      );
      const cogsMovingAverage = roundMoney(maUnitCost * baseQty);

      // 2. FIFO COGS: konsumsi lapisan pembelian tertua terlebih dahulu
      const queue = fifoQueues.get(it.productId) || [];
      let qtyLeftToConsume = baseQty;
      let fifoRawCost = 0;
      while (qtyLeftToConsume > 0.00001 && queue.length > 0) {
        const front = queue[0];
        const take = Math.min(qtyLeftToConsume, front.qty);
        fifoRawCost += take * front.unitCost;
        front.qty = roundQty(front.qty - take);
        qtyLeftToConsume = roundQty(qtyLeftToConsume - take);
        if (front.qty <= 0.00001) {
          queue.shift();
        }
      }
      if (qtyLeftToConsume > 0.00001) {
        fifoRawCost += qtyLeftToConsume * maUnitCost;
      }
      const cogsFifo = roundMoney(fifoRawCost);

      const cogsActive = hppMethod === 'fifo' ? cogsFifo : cogsMovingAverage;
      const profitActive = roundMoney(netRevenue - cogsActive);

      saleMaCogs = roundMoney(saleMaCogs + cogsMovingAverage);
      saleFifoCogs = roundMoney(saleFifoCogs + cogsFifo);

      const itemCostRow: ComputedSaleItemCost = {
        saleId: sale.id,
        itemId: it.id,
        productId: it.productId,
        productName: it.productName || prod?.name || 'Produk',
        categoryId: prod?.categoryId || 'uncategorized',
        categoryName: prod?.categoryName || 'Lainnya',
        transactionDate: sale.transactionDate,
        baseUnit: prod?.unit || it.unitName || 'PCS',
        baseQty,
        netRevenue,
        cogsMovingAverage,
        cogsFifo,
        cogsActive,
        profitActive,
      };
      computedItems.push(itemCostRow);
      allComputedItems.push(itemCostRow);
    });

    const saleCogsActive = hppMethod === 'fifo' ? saleFifoCogs : saleMaCogs;
    valuationsBySaleId.set(sale.id, {
      sale,
      revenue: saleRevenue,
      cogsMovingAverage: saleMaCogs,
      cogsFifo: saleFifoCogs,
      cogsActive: saleCogsActive,
      grossProfitActive: roundMoney(saleRevenue - saleCogsActive),
      items: computedItems,
    });
  }

  // Agregasi untuk periode aktif [startDate..endDate]
  const inRange = (d?: string) => Boolean(d && d >= startDate && d <= endDate);

  const periodSales = completedSalesChrono
    .filter((s) => inRange(s.transactionDate))
    .slice()
    .sort((a, b) =>
      `${b.transactionDate} ${b.transactionTime}`.localeCompare(
        `${a.transactionDate} ${a.transactionTime}`
      )
    );

  let salesRevenue = 0;
  let salesCogsMovingAverage = 0;
  let salesCogsFifo = 0;
  let qrisTransactionCount = 0;
  let qrisGrossVolume = 0;
  let qrisFeeTotal = 0;
  const qrisSalesRows: Sale[] = [];

  for (const s of periodSales) {
    const val = valuationsBySaleId.get(s.id);
    const rev = val ? val.revenue : roundMoney(Number(s.totalAmount) || 0);
    const cMa = val ? val.cogsMovingAverage : roundMoney(Number(s.totalCost) || 0);
    const cFifo = val ? val.cogsFifo : roundMoney(Number(s.totalCost) || 0);

    salesRevenue = roundMoney(salesRevenue + rev);
    salesCogsMovingAverage = roundMoney(salesCogsMovingAverage + cMa);
    salesCogsFifo = roundMoney(salesCogsFifo + cFifo);

    const qAmt = roundMoney(Number(s.qrisAmount) || 0);
    const qFee = roundMoney(Number(s.qrisFeeAmount) || 0);
    if (qAmt > 0 || s.paymentMethod === 'qris' || s.paymentMethod === 'mixed') {
      qrisTransactionCount += 1;
      qrisGrossVolume = roundMoney(qrisGrossVolume + qAmt);
      qrisFeeTotal = roundMoney(qrisFeeTotal + qFee);
      qrisSalesRows.push(s);
    }
  }

  const salesCogsActive = hppMethod === 'fifo' ? salesCogsFifo : salesCogsMovingAverage;
  const salesGrossProfitMovingAverage = roundMoney(salesRevenue - salesCogsMovingAverage);
  const salesGrossProfitFifo = roundMoney(salesRevenue - salesCogsFifo);
  const salesGrossProfit = hppMethod === 'fifo' ? salesGrossProfitFifo : salesGrossProfitMovingAverage;
  const qrisNetReceived = roundMoney(Math.max(0, qrisGrossVolume - qrisFeeTotal));

  const periodMiniAtms = miniAtms.filter(
    (t) => t.status === 'completed' && inRange(t.transactionDate)
  );
  const miniAtmVolume = roundMoney(
    periodMiniAtms.reduce((s, t) => s + (Number(t.principalAmount) || 0), 0)
  );
  const miniAtmProfit = roundMoney(
    periodMiniAtms.reduce((s, t) => s + (Number(t.netProfit) || 0), 0)
  );

  const periodPpobs = ppobs.filter(
    (t) => t.status === 'completed' && inRange(t.transactionDate)
  );
  const ppobVolume = roundMoney(
    periodPpobs.reduce((s, t) => s + (Number(t.sellPrice) || 0) + (Number(t.adminFee) || 0), 0)
  );
  const ppobProfit = roundMoney(
    periodPpobs.reduce((s, t) => s + (Number(t.netProfit) || 0), 0)
  );

  const serviceProfitTotal = roundMoney(miniAtmProfit + ppobProfit);

  const periodExpenses = expenses.filter((e) => inRange(e.transactionDate));
  const expensesTotal = roundMoney(
    periodExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0)
  );

  // Laba Bersih = (Laba Kotor + Komisi Jasa Mini ATM & PPOB) - Biaya QRIS - Biaya Operasional
  const netOperatingProfit = roundMoney(
    salesGrossProfit + serviceProfitTotal - qrisFeeTotal - expensesTotal
  );

  // Pos Non-Laba (Dipisahkan total agar tidak dihitung sebagai laba atau biaya)
  const periodLoans = loans.filter((l) => inRange(l.loanDate || l.transactionDate));
  const loansDisbursedAmount = roundMoney(
    periodLoans.reduce((s, l) => s + (Number(l.principalAmount) || 0), 0)
  );

  const periodLoanPayments = loanPayments.filter((p) => inRange(p.transactionDate));
  const loanPaymentsAmount = roundMoney(
    periodLoanPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  );

  const periodLedger = cashLedger.filter((l) => inRange(l.transactionDate));
  const kasbonPaymentsAmount = roundMoney(
    periodLedger
      .filter((l) => l.sourceModule === 'receivable' && l.direction === 'in')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0)
  );
  const capitalInAmount = roundMoney(
    periodLedger
      .filter((l) => l.sourceModule === 'capital' && l.direction === 'in')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0)
  );
  const capitalOutAmount = roundMoney(
    periodLedger
      .filter((l) => l.sourceModule === 'capital' && l.direction === 'out')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0)
  );
  const transferVolumeAmount = roundMoney(
    periodLedger
      .filter((l) => l.sourceModule === 'transfer' && l.direction === 'out')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0)
  );
  const purchasesPaidAmount = roundMoney(
    completedPurchasesChrono
      .filter((p) => inRange(p.transactionDate))
      .reduce((s, p) => s + (Number(p.paidAmount) || 0), 0)
  );
  const supplierDebtPaymentsAmount = roundMoney(
    supplierPayments
      .filter((sp) => inRange(sp.transactionDate))
      .reduce((s, sp) => s + (Number(sp.amount) || 0), 0)
  );

  const totalLoansRemainingAllTime = roundMoney(
    loans.reduce((s, l) => s + Math.max(0, Number(l.remainingAmount) || 0), 0)
  );
  const totalCustomerKasbonRemaining = roundMoney(
    customers.reduce((s, c) => s + Math.max(0, Number(c.totalDebt) || 0), 0)
  );
  const overdueLoansCount = loans.filter(
    (l) => getLoanDisplayStatus(l, todayStr) === 'Terlambat'
  ).length;

  return {
    hppMethod,
    hppMethodLabel: getHppMethodLabel(hppMethod),
    startDate,
    endDate,
    salesCount: periodSales.length,
    salesRevenue,
    salesCogsActive,
    salesCogsMovingAverage,
    salesCogsFifo,
    salesGrossProfit,
    salesGrossProfitMovingAverage,
    salesGrossProfitFifo,
    miniAtmCount: periodMiniAtms.length,
    miniAtmVolume,
    miniAtmProfit,
    ppobCount: periodPpobs.length,
    ppobVolume,
    ppobProfit,
    serviceProfitTotal,
    qrisTransactionCount,
    qrisGrossVolume,
    qrisFeeTotal,
    qrisNetReceived,
    expensesCount: periodExpenses.length,
    expensesTotal,
    netOperatingProfit,
    nonProfitFlows: {
      loansDisbursedCount: periodLoans.length,
      loansDisbursedAmount,
      loanPaymentsCount: periodLoanPayments.length,
      loanPaymentsAmount,
      kasbonPaymentsAmount,
      capitalInAmount,
      capitalOutAmount,
      transferVolumeAmount,
      purchasesPaidAmount,
      supplierDebtPaymentsAmount,
      totalLoansRemainingAllTime,
      totalCustomerKasbonRemaining,
      overdueLoansCount,
    },
    valuationsBySaleId,
    allComputedItems,
    periodSales,
    qrisSalesRows,
    periodMiniAtms,
    periodPpobs,
    periodExpenses,
  };
}

// ---------------------------------------------------------------------------
// 3. LAPORAN TREN PENJUALAN
// ---------------------------------------------------------------------------

export interface PeriodSalesMetrics {
  revenue: number;
  cogs: number;
  grossProfit: number;
  transactionCount: number;
  avgTransactionValue: number;
}

export interface SalesTrendPoint {
  key: string;
  label: string;
  shortLabel: string;
  revenue: number;
  profit: number;
  transactionCount: number;
}

export interface TopProductPerformanceRow {
  productId: string;
  productName: string;
  categoryName: string;
  baseUnit: string;
  baseQtySold: number;
  transactionCount: number;
  revenue: number;
  cogs: number;
  profit: number;
}

export interface SalesTrendReport {
  granularity: TrendGranularity;
  categoryId: string;
  productId: string;
  current: PeriodSalesMetrics;
  previous: PeriodSalesMetrics;
  revenueChangePct: number | null;
  profitChangePct: number | null;
  trxCountChangePct: number | null;
  avgValueChangePct: number | null;
  trendPoints: SalesTrendPoint[];
  topSellingProducts: TopProductPerformanceRow[];
  topProfitProducts: TopProductPerformanceRow[];
}

function calcPercentChange(current: number, previous: number): number | null {
  if (previous === 0) {
    return current === 0 ? 0 : null;
  }
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

function getMondayOfDate(dateStr: string): string {
  const d = parseYmd(dateStr);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return formatYmd(d);
}

const SHORT_MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

export function buildSalesTrendReport(params: {
  period: ResolvedReportPeriod;
  granularity: TrendGranularity;
  categoryId: string; // 'all' or category ID
  productId: string; // 'all' or product ID
  products: Product[];
  categories: Category[];
  valuationsBySaleId: Map<string, ComputedSaleValuation>;
}): SalesTrendReport {
  const { period, granularity, categoryId, productId, valuationsBySaleId } = params;
  const hasFilter = categoryId !== 'all' || productId !== 'all';

  const evaluateWindow = (wStart: string, wEnd: string): PeriodSalesMetrics => {
    let revenue = 0;
    let cogs = 0;
    let trxCount = 0;

    for (const val of valuationsBySaleId.values()) {
      const d = val.sale.transactionDate;
      if (!d || d < wStart || d > wEnd) continue;

      if (!hasFilter) {
        revenue = roundMoney(revenue + val.revenue);
        cogs = roundMoney(cogs + val.cogsActive);
        trxCount += 1;
      } else {
        const matchedItems = val.items.filter((it) => {
          if (productId !== 'all' && it.productId !== productId) return false;
          if (categoryId !== 'all' && it.categoryId !== categoryId) return false;
          return true;
        });
        if (matchedItems.length > 0) {
          trxCount += 1;
          matchedItems.forEach((it) => {
            revenue = roundMoney(revenue + it.netRevenue);
            cogs = roundMoney(cogs + it.cogsActive);
          });
        }
      }
    }

    const grossProfit = roundMoney(revenue - cogs);
    const avgTransactionValue = trxCount > 0 ? roundMoney(revenue / trxCount) : 0;
    return {
      revenue,
      cogs,
      grossProfit,
      transactionCount: trxCount,
      avgTransactionValue,
    };
  };

  const current = evaluateWindow(period.startDate, period.endDate);
  const previous = evaluateWindow(period.prevStartDate, period.prevEndDate);

  // Bangun titik grafik tren berdasarkan granularity & filter
  const buckets: { key: string; label: string; shortLabel: string; start: string; end: string }[] =
    [];

  if (granularity === 'daily') {
    const span = diffDaysInclusive(period.startDate, period.endDate);
    // Jika filter hari tunggal, tampilkan tren 14 hari terakhir hingga endDate agar grafik tren terbaca
    const effectiveEnd = period.endDate;
    const effectiveStart =
      span <= 1 ? addDays(effectiveEnd, -13) : span > 31 ? addDays(effectiveEnd, -30) : period.startDate;
    let cursor = effectiveStart;
    while (cursor <= effectiveEnd) {
      const dt = parseYmd(cursor);
      const shortLabel = `${dt.getDate()}/${dt.getMonth() + 1}`;
      buckets.push({
        key: cursor,
        label: cursor,
        shortLabel,
        start: cursor,
        end: cursor,
      });
      cursor = addDays(cursor, 1);
    }
  } else if (granularity === 'weekly') {
    const lastMonday = getMondayOfDate(period.endDate);
    for (let w = 7; w >= 0; w--) {
      const start = addDays(lastMonday, -w * 7);
      const end = addDays(start, 6);
      const dt = parseYmd(start);
      const shortLabel = `${dt.getDate()} ${SHORT_MONTHS_ID[dt.getMonth()]}`;
      buckets.push({
        key: start,
        label: `${start} s.d. ${end}`,
        shortLabel,
        start,
        end,
      });
    }
  } else if (granularity === 'monthly') {
    const targetYear = parseYmd(period.endDate).getFullYear();
    for (let m = 0; m < 12; m++) {
      const first = new Date(targetYear, m, 1);
      const last = new Date(targetYear, m + 1, 0);
      const key = `${targetYear}-${String(m + 1).padStart(2, '0')}`;
      buckets.push({
        key,
        label: `${SHORT_MONTHS_ID[m]} ${targetYear}`,
        shortLabel: SHORT_MONTHS_ID[m],
        start: formatYmd(first),
        end: formatYmd(last),
      });
    }
  } else {
    const endYear = parseYmd(period.endDate).getFullYear();
    let minYear = endYear - 2;
    for (const val of valuationsBySaleId.values()) {
      const y = Number((val.sale.transactionDate || '').slice(0, 4));
      if (y >= 2000 && y < minYear) minYear = y;
    }
    const startYear = Math.max(endYear - 5, minYear);
    for (let y = startYear; y <= endYear; y++) {
      buckets.push({
        key: String(y),
        label: `Tahun ${y}`,
        shortLabel: String(y),
        start: `${y}-01-01`,
        end: `${y}-12-31`,
      });
    }
  }

  const trendPoints: SalesTrendPoint[] = buckets.map((b) => {
    const metrics = evaluateWindow(b.start, b.end);
    return {
      key: b.key,
      label: b.label,
      shortLabel: b.shortLabel,
      revenue: metrics.revenue,
      profit: metrics.grossProfit,
      transactionCount: metrics.transactionCount,
    };
  });

  // Top produk paling laris & laba tertinggi pada periode aktif [period.startDate..period.endDate]
  const prodAggMap = new Map<
    string,
    TopProductPerformanceRow & { saleIdSet: Set<string> }
  >();

  for (const val of valuationsBySaleId.values()) {
    const d = val.sale.transactionDate;
    if (!d || d < period.startDate || d > period.endDate) continue;

    for (const it of val.items) {
      if (productId !== 'all' && it.productId !== productId) continue;
      if (categoryId !== 'all' && it.categoryId !== categoryId) continue;

      let agg = prodAggMap.get(it.productId);
      if (!agg) {
        agg = {
          productId: it.productId,
          productName: it.productName,
          categoryName: it.categoryName,
          baseUnit: it.baseUnit,
          baseQtySold: 0,
          transactionCount: 0,
          revenue: 0,
          cogs: 0,
          profit: 0,
          saleIdSet: new Set<string>(),
        };
        prodAggMap.set(it.productId, agg);
      }
      agg.baseQtySold = roundQty(agg.baseQtySold + it.baseQty);
      agg.revenue = roundMoney(agg.revenue + it.netRevenue);
      agg.cogs = roundMoney(agg.cogs + it.cogsActive);
      agg.profit = roundMoney(agg.profit + it.profitActive);
      agg.saleIdSet.add(it.saleId);
      agg.transactionCount = agg.saleIdSet.size;
    }
  }

  const allProductRows: TopProductPerformanceRow[] = Array.from(prodAggMap.values()).map(
    ({ saleIdSet: _omit, ...rest }) => rest
  );

  const topSellingProducts = allProductRows
    .slice()
    .sort((a, b) => b.baseQtySold - a.baseQtySold || b.revenue - a.revenue)
    .slice(0, 15);

  const topProfitProducts = allProductRows
    .slice()
    .sort((a, b) => b.profit - a.profit || b.revenue - a.revenue)
    .slice(0, 15);

  return {
    granularity,
    categoryId,
    productId,
    current,
    previous,
    revenueChangePct: calcPercentChange(current.revenue, previous.revenue),
    profitChangePct: calcPercentChange(current.grossProfit, previous.grossProfit),
    trxCountChangePct: calcPercentChange(current.transactionCount, previous.transactionCount),
    avgValueChangePct: calcPercentChange(
      current.avgTransactionValue,
      previous.avgTransactionValue
    ),
    trendPoints,
    topSellingProducts,
    topProfitProducts,
  };
}
