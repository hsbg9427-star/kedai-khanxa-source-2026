import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  CheckCircle2,
  Download,
  FileBarChart2,
  FileSpreadsheet,
  FileText,
  HandCoins,
  Landmark,
  Layers,
  Plus,
  QrCode,
  Receipt,
  Scale,
  ShoppingBag,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import type {
  Account,
  CashLedger,
  Category,
  Customer,
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
import { saveStoreSettings, subscribeReportCollections } from '../services/warungService';
import { subscribeLoanPayments, subscribeLoans } from '../services/loanService';
import {
  deleteExpenseAndRestoreAccount,
  EXPENSE_CATEGORIES,
  recordExpense,
} from '../services/financeService';
import {
  fetchMissingPurchaseItems,
  fetchMissingSaleItems,
  subscribeFullReportExtras,
} from '../services/fullReportService';
import {
  formatQty,
  formatRupiah,
  getAccountTypeLabel,
  getTodayDateString,
} from '../utils/formatters';
import { getEffectiveQrisFeePercent } from '../utils/qrisFee';
import { getReadableFirestoreError } from '../utils/firestoreError';
import { getMiniAtmServiceLabel, getPpobCategoryLabel } from '../utils/serviceTransactions';
import {
  BALANCE_BUCKETS,
  buildSalesTrendReport,
  computeAccountBalanceMovements,
  computeProfitAndLossReport,
  getEffectiveHppMethod,
  getHppMethodLabel,
  LEDGER_CATEGORY_LABELS,
  resolveReportPeriod,
  type BalanceBucketKey,
  type ExtendedReportPeriodType,
  type LedgerCategoryKey,
  type TrendGranularity,
} from '../utils/fullReports';
import { exportFullReportExcel, exportFullReportPdf } from '../utils/reportExporter';
import { SalesTrendChart } from '../components/SalesTrendChart';

interface ReportsPageProps {
  accounts: Account[];
  customers: Customer[];
  storeSetting: StoreSetting | null;
  products?: Product[];
  categories?: Category[];
}

const PERIOD_OPTIONS: { id: ExtendedReportPeriodType; label: string }[] = [
  { id: 'daily', label: 'Harian' },
  { id: 'weekly', label: 'Mingguan' },
  { id: 'monthly', label: 'Bulanan' },
  { id: 'yearly', label: 'Tahunan' },
  { id: 'range', label: 'Rentang Tanggal' },
];

const TREND_GRANULARITY_OPTIONS: { id: TrendGranularity; label: string }[] = [
  { id: 'daily', label: 'Harian' },
  { id: 'weekly', label: 'Mingguan' },
  { id: 'monthly', label: 'Bulanan' },
  { id: 'yearly', label: 'Tahunan' },
];

type ReportSubTab = 'balance' | 'profit' | 'trends' | 'qris_expenses' | 'details';

function formatDeltaText(pct: number | null, previousFormatted: string): {
  text: string;
  tone: 'up' | 'down' | 'neutral';
} {
  if (pct === null) {
    return { text: `Baru vs ${previousFormatted}`, tone: 'up' };
  }
  if (pct > 0) {
    return { text: `+${pct}% vs ${previousFormatted}`, tone: 'up' };
  }
  if (pct < 0) {
    return { text: `${pct}% vs ${previousFormatted}`, tone: 'down' };
  }
  return { text: `0% vs ${previousFormatted}`, tone: 'neutral' };
}

export function ReportsPage({
  accounts,
  customers,
  storeSetting,
  products = [],
  categories = [],
}: ReportsPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const todayStr = getTodayDateString();

  const [subTab, setSubTab] = useState<ReportSubTab>('balance');
  const [periodType, setPeriodType] = useState<ExtendedReportPeriodType>('monthly');
  const [anchorDate, setAnchorDate] = useState(todayStr);
  const [customStartDate, setCustomStartDate] = useState(`${todayStr.slice(0, 7)}-01`);
  const [customEndDate, setCustomEndDate] = useState(todayStr);

  // Filter untuk Laporan Pergerakan Saldo
  const [ledgerBucketFilter, setLedgerBucketFilter] = useState<BalanceBucketKey | 'all'>('all');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<LedgerCategoryKey | 'all'>('all');

  // Filter untuk Laporan Tren Penjualan
  const [trendGranularity, setTrendGranularity] = useState<TrendGranularity>('daily');
  const [trendCategoryId, setTrendCategoryId] = useState<string>('all');
  const [trendProductId, setTrendProductId] = useState<string>('all');

  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);

  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [miniAtms, setMiniAtms] = useState<MiniAtmTransaction[]>([]);
  const [ppobs, setPpobs] = useState<PpobTransaction[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loanPayments, setLoanPayments] = useState<LoanPayment[]>([]);

  const [cashLedger, setCashLedger] = useState<CashLedger[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPayment[]>([]);

  const [saleItemsMap, setSaleItemsMap] = useState<Record<string, SaleItem[]>>({});
  const [purchaseItemsMap, setPurchaseItemsMap] = useState<Record<string, PurchaseItem[]>>({});
  const saleItemsMapRef = useRef<Record<string, SaleItem[]>>({});
  const purchaseItemsMapRef = useRef<Record<string, PurchaseItem[]>>({});

  // Pengeluaran Operasional Form
  const [expCategory, setExpCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [expDescription, setExpDescription] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expAccountId, setExpAccountId] = useState('');
  const [savingExp, setSavingExp] = useState(false);
  const [deletingExpId, setDeletingExpId] = useState<string | null>(null);
  const [switchingHpp, setSwitchingHpp] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const expLockRef = useRef(false);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);

  useEffect(() => {
    if (!expAccountId && activeAccounts.length > 0) {
      const cash = activeAccounts.find((a) => a.type === 'cash');
      setExpAccountId((cash || activeAccounts[0]).id);
    }
  }, [activeAccounts, expAccountId]);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubRep = subscribeReportCollections(
      (data) => {
        setSales(data.sales);
        setExpenses(data.expenses);
        setMiniAtms(data.miniAtms);
        setPpobs(data.ppobs);
        setLoading(false);
      },
      () => setLoading(false)
    );
    const unsubLoans = subscribeLoans(
      (list) => setLoans(list),
      () => {}
    );
    const unsubLoanPays = subscribeLoanPayments(
      (list) => setLoanPayments(list),
      () => {}
    );
    const unsubExtras = subscribeFullReportExtras(
      (extras) => {
        setCashLedger(extras.cashLedger);
        setPurchases(extras.purchases);
        setPurchaseReturns(extras.purchaseReturns);
        setSupplierPayments(extras.supplierPayments);
      },
      () => {}
    );

    return () => {
      unsubRep();
      unsubLoans();
      unsubLoanPays();
      unsubExtras();
    };
  }, [isAdmin]);

  // Fetch rincian item penjualan & pembelian secara incremental & di-cache di memori agar FIFO & Tren akurat
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;

    const missingSales = sales.filter(
      (s) => s.status === 'completed' && !saleItemsMapRef.current[s.id]
    );
    const missingPurchases = purchases.filter(
      (p) => p.status === 'completed' && !purchaseItemsMapRef.current[p.id]
    );

    if (missingSales.length === 0 && missingPurchases.length === 0) return;

    setLoadingItems(true);
    Promise.all([
      missingSales.length > 0
        ? fetchMissingSaleItems(sales, saleItemsMapRef.current)
        : Promise.resolve(saleItemsMapRef.current),
      missingPurchases.length > 0
        ? fetchMissingPurchaseItems(purchases, purchaseItemsMapRef.current)
        : Promise.resolve(purchaseItemsMapRef.current),
    ])
      .then(([nextSalesMap, nextPurchasesMap]) => {
        if (cancelled) return;
        saleItemsMapRef.current = nextSalesMap;
        purchaseItemsMapRef.current = nextPurchasesMap;
        setSaleItemsMap(nextSalesMap);
        setPurchaseItemsMap(nextPurchasesMap);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingItems(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, sales, purchases]);

  // Reset product filter when category changes if selected product is not in selected category
  useEffect(() => {
    if (trendCategoryId === 'all' || trendProductId === 'all') return;
    const selectedProd = products.find((p) => p.id === trendProductId);
    if (selectedProd && selectedProd.categoryId !== trendCategoryId) {
      setTrendProductId('all');
    }
  }, [trendCategoryId, trendProductId, products]);

  // Sinkronkan granularitas tren saat user ganti periode utama bila wajar
  const handleSelectPeriodType = (next: ExtendedReportPeriodType) => {
    setPeriodType(next);
    if (next === 'daily' || next === 'weekly' || next === 'monthly' || next === 'yearly') {
      setTrendGranularity(next);
    }
  };

  const activeHppMethod = getEffectiveHppMethod(storeSetting);
  const activeQrisRate = getEffectiveQrisFeePercent(storeSetting);
  const storeName = storeSetting?.storeName || 'KEDAI KHANXA';

  const resolvedPeriod = useMemo(
    () =>
      resolveReportPeriod({
        periodType,
        anchorDateStr: anchorDate,
        customStartDate,
        customEndDate,
      }),
    [periodType, anchorDate, customStartDate, customEndDate]
  );

  const balanceReport = useMemo(
    () =>
      computeAccountBalanceMovements({
        accounts,
        cashLedger,
        startDate: resolvedPeriod.startDate,
        endDate: resolvedPeriod.endDate,
      }),
    [accounts, cashLedger, resolvedPeriod.startDate, resolvedPeriod.endDate]
  );

  const profitReport = useMemo(
    () =>
      computeProfitAndLossReport({
        hppMethod: activeHppMethod,
        startDate: resolvedPeriod.startDate,
        endDate: resolvedPeriod.endDate,
        todayDateStr: todayStr,
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
        supplierPayments,
      }),
    [
      activeHppMethod,
      resolvedPeriod.startDate,
      resolvedPeriod.endDate,
      todayStr,
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
      supplierPayments,
    ]
  );

  const trendReport = useMemo(
    () =>
      buildSalesTrendReport({
        period: resolvedPeriod,
        granularity: trendGranularity,
        categoryId: trendCategoryId,
        productId: trendProductId,
        products,
        categories,
        valuationsBySaleId: profitReport.valuationsBySaleId,
      }),
    [
      resolvedPeriod,
      trendGranularity,
      trendCategoryId,
      trendProductId,
      products,
      categories,
      profitReport.valuationsBySaleId,
    ]
  );

  const filteredLedgerRows = useMemo(() => {
    return balanceReport.periodLedgerRows.filter((row) => {
      if (ledgerBucketFilter !== 'all' && row.bucket !== ledgerBucketFilter) return false;
      if (ledgerTypeFilter !== 'all' && row.categoryKey !== ledgerTypeFilter) return false;
      return true;
    });
  }, [balanceReport.periodLedgerRows, ledgerBucketFilter, ledgerTypeFilter]);

  const filterableProducts = useMemo(() => {
    const list =
      trendCategoryId === 'all'
        ? products
        : products.filter((p) => p.categoryId === trendCategoryId);
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [products, trendCategoryId]);

  if (!isAdmin) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>Akses ditolak. Modul Laporan Lengkap KEDAI KHANXA hanya tersedia untuk Admin.</span>
      </div>
    );
  }

  const handleSwitchHppMethod = async (nextMethod: HppMethod) => {
    if (!user || switchingHpp || nextMethod === activeHppMethod) return;
    setSwitchingHpp(true);
    setFeedback(null);
    try {
      await saveStoreSettings(
        {
          storeName: storeSetting?.storeName || 'KEDAI KHANXA',
          ownerName: storeSetting?.ownerName || profile?.displayName || 'Pemilik Warung',
          address: storeSetting?.address || '',
          phone: storeSetting?.phone || '',
          receiptFooter: storeSetting?.receiptFooter || '',
          qrisFeePercent: storeSetting?.qrisFeePercent,
          hppMethod: nextMethod,
        },
        user.uid
      );
      setFeedback({
        kind: 'ok',
        text: `Metode perhitungan HPP aktif diubah ke ${getHppMethodLabel(nextMethod)}.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSwitchingHpp(false);
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || expLockRef.current) return;
    setFeedback(null);

    const targetAccount = activeAccounts.find((a) => a.id === expAccountId);
    if (!targetAccount) {
      setFeedback({ kind: 'err', text: 'Pilih akun sumber dana pengeluaran yang aktif.' });
      return;
    }

    expLockRef.current = true;
    setSavingExp(true);
    try {
      const res = await recordExpense(
        {
          category: expCategory,
          description: expDescription,
          amount: Number(expAmount) || 0,
          account: targetAccount,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        }
      );
      setFeedback({
        kind: 'ok',
        text: `Pengeluaran ${res.transactionNumber} berhasil dicatat dan saldo ${targetAccount.name} telah disesuaikan.`,
      });
      setExpDescription('');
      setExpAmount('');
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSavingExp(false);
      expLockRef.current = false;
    }
  };

  const handleDeleteExpense = async (exp: Expense) => {
    if (!user || deletingExpId) return;
    setDeletingExpId(exp.id);
    setFeedback(null);
    try {
      await deleteExpenseAndRestoreAccount(exp, accounts, {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Admin',
      });
      setFeedback({
        kind: 'ok',
        text: `Catatan pengeluaran ${exp.transactionNumber} dihapus dan saldo kas dikembalikan.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setDeletingExpId(null);
    }
  };

  const handleExportExcel = () => {
    try {
      exportFullReportExcel({
        storeName,
        period: resolvedPeriod,
        balanceReport,
        profitReport,
        trendReport,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    }
  };

  const handleExportPdf = () => {
    try {
      exportFullReportPdf({
        storeName,
        period: resolvedPeriod,
        balanceReport,
        profitReport,
        trendReport,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    }
  };

  const revDelta = formatDeltaText(
    trendReport.revenueChangePct,
    formatRupiah(trendReport.previous.revenue)
  );
  const profitDelta = formatDeltaText(
    trendReport.profitChangePct,
    formatRupiah(trendReport.previous.grossProfit)
  );
  const trxDelta = formatDeltaText(
    trendReport.trxCountChangePct,
    `${trendReport.previous.transactionCount} trx`
  );
  const avgDelta = formatDeltaText(
    trendReport.avgValueChangePct,
    formatRupiah(trendReport.previous.avgTransactionValue)
  );

  const granularityLabel =
    TREND_GRANULARITY_OPTIONS.find((g) => g.id === trendGranularity)?.label || 'Harian';

  return (
    <div className="space-y-5">
      {/* Header & Filter Periode + Export Excel/PDF */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FileBarChart2 className="w-5 h-5 text-emerald-700 shrink-0" />
              <h2 className="font-display font-bold text-lg text-slate-900">
                Laporan Lengkap {storeName}
              </h2>
            </div>
            <p className="text-xs text-slate-500">
              Periode aktif: <strong className="text-slate-800">{resolvedPeriod.label}</strong> ·
              Metode HPP:{' '}
              <strong className="text-emerald-800">
                {activeHppMethod === 'fifo' ? 'FIFO' : 'Moving Average'}
              </strong>{' '}
              · Tarif QRIS <strong className="font-mono-num">{formatQty(activeQrisRate)}%</strong>
              {loadingItems ? ' · Menyelaraskan rincian item...' : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportExcel}
              className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Export Excel</span>
            </button>
            <button
              type="button"
              onClick={handleExportPdf}
              className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <FileText className="w-4 h-4" />
              <span>Export PDF</span>
            </button>
          </div>
        </div>

        {/* Filter Periode & Tanggal (Mobile Friendly) */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-3 border-t border-slate-100">
          <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelectPeriodType(opt.id)}
                className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  periodType === opt.id
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {periodType === 'range' ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">Dari:</span>
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value || todayStr)}
                  aria-label="Tanggal Mulai Laporan"
                  className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">Sampai:</span>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value || todayStr)}
                  aria-label="Tanggal Akhir Laporan"
                  className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="text-xs text-slate-500">Acuan:</span>
              <input
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value || todayStr)}
                aria-label="Pilih Tanggal Acuan Laporan"
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
          )}
        </div>
      </div>

      {/* Navigasi Sub-Tab Laporan Lengkap (Scrollable di Android, Wrap di Desktop) */}
      <div className="flex overflow-x-auto sm:flex-wrap gap-2 pb-1">
        <button
          type="button"
          onClick={() => setSubTab('balance')}
          className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === 'balance'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Wallet className="w-4 h-4" />
          <span>Pergerakan Saldo</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('profit')}
          className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === 'profit'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <TrendingUp className="w-4 h-4" />
          <span>Laporan Laba</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('trends')}
          className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === 'trends'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          <span>Tren Penjualan</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('qris_expenses')}
          className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === 'qris_expenses'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Receipt className="w-4 h-4" />
          <span>Biaya QRIS &amp; Pengeluaran</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('details')}
          className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === 'details'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <ShoppingBag className="w-4 h-4" />
          <span>Rincian Transaksi</span>
        </button>
      </div>

      {feedback && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm flex items-start justify-between gap-3 ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {feedback.kind === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-current opacity-70 hover:opacity-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* =====================================================================
          TAB 1: LAPORAN PERGERAKAN SALDO
      ===================================================================== */}
      {subTab === 'balance' && (
        <div className="space-y-6">
          {/* Ringkasan Saldo Awal, Masuk, Keluar, Akhir */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500 flex items-center justify-between">
                <span>Saldo Awal Periode</span>
                <Wallet className="w-4 h-4 text-slate-400" />
              </div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
                {loading ? '...' : formatRupiah(balanceReport.totalOpeningBalance)}
              </div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                Per {resolvedPeriod.startDate}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500 flex items-center justify-between">
                <span>Total Uang Masuk</span>
                <ArrowDownLeft className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-emerald-700">
                {loading ? '...' : formatRupiah(balanceReport.totalIn)}
              </div>
              <div className="text-[11px] text-slate-500">Semua akun aktif &amp; terdaftar</div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500 flex items-center justify-between">
                <span>Total Uang Keluar</span>
                <ArrowUpRight className="w-4 h-4 text-red-600" />
              </div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-red-700">
                {loading ? '...' : formatRupiah(balanceReport.totalOut)}
              </div>
              <div className="text-[11px] text-slate-500">Belanja, pinjaman, ops &amp; pindah</div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500 flex items-center justify-between">
                <span>Saldo Akhir Periode</span>
                <Landmark className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
                {loading ? '...' : formatRupiah(balanceReport.totalClosingBalance)}
              </div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                Per {resolvedPeriod.endDate}
              </div>
            </div>
          </div>

          {/* 4 Kelompok Terpisah: Laci Kas, DANA, Rekening Bank, Deposit PPOB */}
          <section className="space-y-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Pemisahan Saldo per Kategori Akun
              </h3>
              <p className="text-xs text-slate-500">
                Laci Kas, DANA / E-Wallet, Rekening Bank, dan Deposit PPOB dipisahkan lengkap dengan saldo awal &amp; akhir.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {balanceReport.bucketSummaries.map((b) => (
                <div
                  key={b.key}
                  className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="font-display font-semibold text-sm text-slate-900">
                      {b.label}
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono-num">
                      {b.accountCount} akun
                    </span>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Saldo Awal</span>
                      <span className="font-mono-num text-slate-700">
                        {formatRupiah(b.openingBalance)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Uang Masuk</span>
                      <span className="font-mono-num font-medium text-emerald-700">
                        +{formatRupiah(b.totalIn)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Uang Keluar</span>
                      <span className="font-mono-num font-medium text-red-700">
                        -{formatRupiah(b.totalOut)}
                      </span>
                    </div>
                    <div className="flex justify-between pt-1.5 border-t border-slate-100">
                      <span className="font-semibold text-slate-800">Saldo Akhir</span>
                      <span className="font-mono-num font-bold text-slate-900">
                        {formatRupiah(b.closingBalance)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Rincian per Akun & Ringkasan per Jenis Transaksi */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Pergerakan Saldo per Rekening &amp; Kas
                </h3>
              </div>
              {balanceReport.accountRows.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada akun kas atau rekening terdaftar.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4 whitespace-nowrap">Akun / Kategori</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Saldo Awal</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Masuk</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Keluar</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Saldo Akhir</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {balanceReport.accountRows.map((a) => (
                        <tr key={a.accountId} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-900">{a.accountName}</div>
                            <div className="text-[11px] text-slate-500">
                              {a.bucketLabel} · {a.transactionCount} mutasi
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-slate-700 whitespace-nowrap">
                            {formatRupiah(a.openingBalance)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-emerald-700 whitespace-nowrap">
                            +{formatRupiah(a.totalIn)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-red-700 whitespace-nowrap">
                            -{formatRupiah(a.totalOut)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-bold text-slate-900 whitespace-nowrap">
                            {formatRupiah(a.closingBalance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Ringkasan per Jenis Transaksi
                </h3>
                <p className="text-xs text-slate-500">
                  Arus uang masuk &amp; keluar berdasarkan modul sumber.
                </p>
              </div>
              {balanceReport.typeBreakdown.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada pergerakan saldo pada periode ini.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-80">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-4">Jenis Transaksi</th>
                        <th className="py-2.5 px-4 text-right">Masuk</th>
                        <th className="py-2.5 px-4 text-right">Keluar</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {balanceReport.typeBreakdown.map((tb) => (
                        <tr key={tb.categoryKey} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4">
                            <div className="font-medium text-slate-900">{tb.categoryLabel}</div>
                            <div className="text-[11px] text-slate-500 font-mono-num">
                              {tb.count} entri
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num text-emerald-700 whitespace-nowrap">
                            {tb.totalIn > 0 ? `+${formatRupiah(tb.totalIn)}` : '-'}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num text-red-700 whitespace-nowrap">
                            {tb.totalOut > 0 ? `-${formatRupiah(tb.totalOut)}` : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          {/* Mutasi Antar Rekening */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="w-4 h-4 text-emerald-700" />
                <div>
                  <h3 className="font-display font-semibold text-base text-slate-900">
                    Mutasi Antar Rekening ({balanceReport.transferEvents.length} transaksi)
                  </h3>
                  <p className="text-xs text-slate-500">
                    Perpindahan saldo internal antar kas, DANA, bank, dan deposit PPOB (bukan laba/biaya).
                  </p>
                </div>
              </div>
              <div className="font-mono-num text-xs font-semibold text-slate-800">
                Total Volume: {formatRupiah(balanceReport.totalTransferVolume)}
              </div>
            </div>
            {balanceReport.transferEvents.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500">
                Tidak ada mutasi pindah saldo antar rekening pada periode ini.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 whitespace-nowrap">Waktu &amp; Ref</th>
                      <th className="py-3 px-4 whitespace-nowrap">Akun Asal</th>
                      <th className="py-3 px-4 whitespace-nowrap">Akun Tujuan</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Nominal</th>
                      <th className="py-3 px-4 whitespace-nowrap">Petugas &amp; Catatan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {balanceReport.transferEvents.map((tr) => (
                      <tr key={tr.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono-num font-semibold text-slate-900">
                            {tr.referenceNumber}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {tr.transactionDate} · {tr.transactionTime}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-medium text-red-700 whitespace-nowrap">
                          {tr.fromAccountName}
                        </td>
                        <td className="py-3 px-4 font-medium text-emerald-700 whitespace-nowrap">
                          {tr.toAccountName}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-bold text-slate-900 whitespace-nowrap">
                          {formatRupiah(tr.amount)}
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          <div>{tr.description}</div>
                          <div className="text-[11px] text-slate-400">Oleh: {tr.recordedByName}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Riwayat Pergerakan Saldo Lengkap dengan Filter Kategori & Jenis */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Riwayat Setiap Transaksi Saldo ({filteredLedgerRows.length} catatan)
                </h3>
                <p className="text-xs text-slate-500">
                  Menampilkan tanggal, jenis transaksi, rekening, dan saldo sebelum/sesudah.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={ledgerBucketFilter}
                  onChange={(e) => setLedgerBucketFilter(e.target.value as BalanceBucketKey | 'all')}
                  aria-label="Filter Kelompok Akun"
                  className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  <option value="all">Semua Kelompok Saldo</option>
                  {BALANCE_BUCKETS.map((b) => (
                    <option key={b.key} value={b.key}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <select
                  value={ledgerTypeFilter}
                  onChange={(e) => setLedgerTypeFilter(e.target.value as LedgerCategoryKey | 'all')}
                  aria-label="Filter Jenis Transaksi"
                  className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  <option value="all">Semua Jenis Transaksi</option>
                  {(Object.keys(LEDGER_CATEGORY_LABELS) as LedgerCategoryKey[]).map((key) => (
                    <option key={key} value={key}>
                      {LEDGER_CATEGORY_LABELS[key]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {filteredLedgerRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Belum ada riwayat mutasi saldo yang sesuai dengan filter pada periode ini.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[420px]">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 whitespace-nowrap">Waktu &amp; Ref</th>
                      <th className="py-3 px-4 whitespace-nowrap">Jenis Transaksi</th>
                      <th className="py-3 px-4 whitespace-nowrap">Akun</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Masuk / Keluar</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Saldo Sesudah</th>
                      <th className="py-3 px-4 whitespace-nowrap">Keterangan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredLedgerRows.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="font-mono-num font-semibold text-slate-900">
                            {row.transactionNumber}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {row.transactionDate} · {row.transactionTime}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="font-medium text-slate-900">{row.categoryLabel}</div>
                          <div className="text-[11px] text-slate-500">{row.bucketLabel}</div>
                        </td>
                        <td className="py-2.5 px-4 text-slate-800 whitespace-nowrap">
                          {row.accountName}
                        </td>
                        <td
                          className={`py-2.5 px-4 text-right font-mono-num font-semibold whitespace-nowrap ${
                            row.direction === 'in' ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {row.direction === 'in' ? '+' : '-'}
                          {formatRupiah(row.amount)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono-num text-slate-700 whitespace-nowrap">
                          {formatRupiah(row.balanceAfter)}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600 max-w-xs truncate">
                          {row.description}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* =====================================================================
          TAB 2: LAPORAN LABA (FIFO vs MOVING AVERAGE & PEMISAHAN POS NON-LABA)
      ===================================================================== */}
      {subTab === 'profit' && (
        <div className="space-y-6">
          {/* Bar Metode HPP Aktif (Admin dapat berpindah langsung) */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Layers className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  Metode Perhitungan HPP: {profitReport.hppMethodLabel}
                </div>
                <p className="text-xs text-slate-500">
                  Laba Kotor &amp; Laba Bersih otomatis menyesuaikan metode HPP yang dipilih Admin.
                </p>
              </div>
            </div>
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 shrink-0">
              <button
                type="button"
                disabled={switchingHpp}
                onClick={() => handleSwitchHppMethod('moving_average')}
                className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap ${
                  activeHppMethod === 'moving_average'
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Moving Average
              </button>
              <button
                type="button"
                disabled={switchingHpp}
                onClick={() => handleSwitchHppMethod('fifo')}
                className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap ${
                  activeHppMethod === 'fifo'
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                FIFO
              </button>
            </div>
          </div>

          {/* 4 KPI Laba */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">Omzet Penjualan</div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
                {formatRupiah(profitReport.salesRevenue)}
              </div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                {profitReport.salesCount} struk selesai
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">
                HPP ({activeHppMethod === 'fifo' ? 'FIFO' : 'Moving Avg'})
              </div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
                {formatRupiah(profitReport.salesCogsActive)}
              </div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                Laba Kotor: {formatRupiah(profitReport.salesGrossProfit)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">Komisi Jasa ATM &amp; PPOB</div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-emerald-700">
                {formatRupiah(profitReport.serviceProfitTotal)}
              </div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                ATM {formatRupiah(profitReport.miniAtmProfit)} · PPOB{' '}
                {formatRupiah(profitReport.ppobProfit)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">Laba Bersih Usaha</div>
              <div
                className={`font-mono-num text-lg sm:text-2xl font-bold ${
                  profitReport.netOperatingProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatRupiah(profitReport.netOperatingProfit)}
              </div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                Pot. QRIS {formatRupiah(profitReport.qrisFeeTotal)} · Ops{' '}
                {formatRupiah(profitReport.expensesTotal)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Laporan Laba Kotor & Laba Bersih Terpisah */}
            <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Perhitungan Laba Kotor &amp; Laba Bersih
                </h3>
                <p className="text-xs text-slate-500">
                  Setiap transaksi dihitung tepat satu kali; biaya QRIS &amp; operasional mengurangi laba bersih.
                </p>
              </div>
              <div className="divide-y divide-slate-100 text-sm">
                <div className="px-5 py-3 flex justify-between">
                  <span className="text-slate-600">
                    Omzet Penjualan Retail ({profitReport.salesCount} transaksi)
                  </span>
                  <span className="font-mono-num font-semibold text-slate-900">
                    {formatRupiah(profitReport.salesRevenue)}
                  </span>
                </div>
                <div className="px-5 py-3 flex justify-between">
                  <span className="text-slate-600">
                    (-) HPP Barang Terjual [{activeHppMethod === 'fifo' ? 'FIFO' : 'Moving Average'}]
                  </span>
                  <span className="font-mono-num text-slate-700">
                    {formatRupiah(profitReport.salesCogsActive)}
                  </span>
                </div>
                <div className="px-5 py-3.5 flex justify-between bg-slate-50">
                  <span className="font-semibold text-slate-900">(=) Laba Kotor Penjualan</span>
                  <span className="font-mono-num font-bold text-emerald-700">
                    {formatRupiah(profitReport.salesGrossProfit)}
                  </span>
                </div>
                <div className="px-5 py-3 flex justify-between">
                  <span className="text-slate-600">
                    (+) Komisi / Pendapatan Jasa Mini ATM ({profitReport.miniAtmCount} trx)
                  </span>
                  <span className="font-mono-num text-emerald-700">
                    {formatRupiah(profitReport.miniAtmProfit)}
                  </span>
                </div>
                <div className="px-5 py-3 flex justify-between">
                  <span className="text-slate-600">
                    (+) Komisi / Pendapatan Jasa PPOB ({profitReport.ppobCount} trx)
                  </span>
                  <span className="font-mono-num text-emerald-700">
                    {formatRupiah(profitReport.ppobProfit)}
                  </span>
                </div>
                <div className="px-5 py-3 flex justify-between">
                  <span className="text-slate-600">
                    (-) Biaya QRIS ({profitReport.qrisTransactionCount} trx QRIS)
                  </span>
                  <span className="font-mono-num font-semibold text-amber-700">
                    {formatRupiah(profitReport.qrisFeeTotal)}
                  </span>
                </div>
                <div className="px-5 py-3 flex justify-between">
                  <span className="text-slate-600">
                    (-) Biaya Operasional ({profitReport.expensesCount} catatan)
                  </span>
                  <span className="font-mono-num font-semibold text-red-700">
                    {formatRupiah(profitReport.expensesTotal)}
                  </span>
                </div>
                <div className="px-5 py-4 flex justify-between bg-emerald-50/70">
                  <span className="font-bold text-slate-900">(=) Laba Bersih Operasional</span>
                  <span
                    className={`font-mono-num text-base font-bold ${
                      profitReport.netOperatingProfit >= 0 ? 'text-emerald-800' : 'text-red-700'
                    }`}
                  >
                    {formatRupiah(profitReport.netOperatingProfit)}
                  </span>
                </div>
              </div>
            </section>

            {/* Panel Kanan: Perbandingan HPP & Pos Non-Laba */}
            <div className="lg:col-span-5 space-y-6">
              {/* Perbandingan FIFO vs Moving Average */}
              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
                  <Scale className="w-4 h-4 text-emerald-700" />
                  <h3 className="font-display font-semibold text-sm text-slate-900">
                    Simulasi Perbandingan FIFO vs Moving Average
                  </h3>
                </div>
                <div className="p-4 space-y-2.5 text-xs">
                  <div className="grid grid-cols-3 text-slate-500 font-semibold border-b border-slate-100 pb-2">
                    <span>Komponen</span>
                    <span className="text-right">Moving Avg</span>
                    <span className="text-right">FIFO</span>
                  </div>
                  <div className="grid grid-cols-3 items-center">
                    <span className="text-slate-700">HPP Terjual</span>
                    <span className="text-right font-mono-num text-slate-900">
                      {formatRupiah(profitReport.salesCogsMovingAverage)}
                    </span>
                    <span className="text-right font-mono-num text-slate-900">
                      {formatRupiah(profitReport.salesCogsFifo)}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 items-center pt-1 border-t border-slate-100">
                    <span className="font-semibold text-slate-800">Laba Kotor</span>
                    <span className="text-right font-mono-num font-bold text-emerald-700">
                      {formatRupiah(profitReport.salesGrossProfitMovingAverage)}
                    </span>
                    <span className="text-right font-mono-num font-bold text-emerald-700">
                      {formatRupiah(profitReport.salesGrossProfitFifo)}
                    </span>
                  </div>
                </div>
              </section>

              {/* Pos Non-Laba (Dipisahkan dari Laba) */}
              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
                  <HandCoins className="w-4 h-4 text-amber-700" />
                  <div>
                    <h3 className="font-display font-semibold text-sm text-slate-900">
                      Pos Non-Laba (Dikecualikan dari Laba)
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Pinjaman, cicilan pokok, modal &amp; pindah saldo tidak masuk hitungan laba.
                    </p>
                  </div>
                </div>
                <div className="divide-y divide-slate-100 text-xs">
                  <div className="px-5 py-2.5 flex justify-between">
                    <span className="text-slate-600">
                      Pinjaman Pelanggan Diberikan ({profitReport.nonProfitFlows.loansDisbursedCount} trx)
                    </span>
                    <span className="font-mono-num font-semibold text-slate-900">
                      {formatRupiah(profitReport.nonProfitFlows.loansDisbursedAmount)}
                    </span>
                  </div>
                  <div className="px-5 py-2.5 flex justify-between">
                    <span className="text-slate-600">
                      Cicilan Pokok Pinjaman ({profitReport.nonProfitFlows.loanPaymentsCount} trx)
                    </span>
                    <span className="font-mono-num font-semibold text-slate-900">
                      {formatRupiah(profitReport.nonProfitFlows.loanPaymentsAmount)}
                    </span>
                  </div>
                  <div className="px-5 py-2.5 flex justify-between">
                    <span className="text-slate-600">Pelunasan Kasbon Belanja</span>
                    <span className="font-mono-num font-semibold text-slate-900">
                      {formatRupiah(profitReport.nonProfitFlows.kasbonPaymentsAmount)}
                    </span>
                  </div>
                  <div className="px-5 py-2.5 flex justify-between">
                    <span className="text-slate-600">Setoran Modal / Tarik Prive</span>
                    <span className="font-mono-num text-slate-800">
                      +{formatRupiah(profitReport.nonProfitFlows.capitalInAmount)} / -
                      {formatRupiah(profitReport.nonProfitFlows.capitalOutAmount)}
                    </span>
                  </div>
                  <div className="px-5 py-2.5 flex justify-between">
                    <span className="text-slate-600">Mutasi Antar Rekening</span>
                    <span className="font-mono-num text-slate-800">
                      {formatRupiah(profitReport.nonProfitFlows.transferVolumeAmount)}
                    </span>
                  </div>
                  <div className="px-5 py-2.5 flex justify-between bg-amber-50/50">
                    <span className="font-medium text-slate-800">
                      Sisa Piutang Pinjaman ({profitReport.nonProfitFlows.overdueLoansCount} terlambat)
                    </span>
                    <span className="font-mono-num font-bold text-amber-800">
                      {formatRupiah(profitReport.nonProfitFlows.totalLoansRemainingAllTime)}
                    </span>
                  </div>
                  <div className="px-5 py-2.5 flex justify-between">
                    <span className="text-slate-600">Sisa Piutang Kasbon Pelanggan</span>
                    <span className="font-mono-num font-semibold text-slate-900">
                      {formatRupiah(profitReport.nonProfitFlows.totalCustomerKasbonRemaining)}
                    </span>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 3: LAPORAN TREN PENJUALAN
      ===================================================================== */}
      {subTab === 'trends' && (
        <div className="space-y-6">
          {/* Filter Produk, Kategori & Granularitas Tren */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
              <div className="space-y-1">
                <label htmlFor="trend-cat" className="block text-xs font-medium text-slate-700">
                  Filter Kategori Produk
                </label>
                <select
                  id="trend-cat"
                  value={trendCategoryId}
                  onChange={(e) => setTrendCategoryId(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  <option value="all">Semua Kategori</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="trend-prod" className="block text-xs font-medium text-slate-700">
                  Filter Produk Spesifik
                </label>
                <select
                  id="trend-prod"
                  value={trendProductId}
                  onChange={(e) => setTrendProductId(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  <option value="all">Semua Produk</option>
                  {filterableProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.unit})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-700">Tampilan Grafik Tren</div>
              <div className="inline-flex flex-wrap rounded-lg border border-slate-200 bg-slate-50 p-1">
                {TREND_GRANULARITY_OPTIONS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setTrendGranularity(g.id)}
                    className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap ${
                      trendGranularity === g.id
                        ? 'bg-emerald-700 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Perbandingan Periode Sebelumnya */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">Omzet Periode</div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
                {formatRupiah(trendReport.current.revenue)}
              </div>
              <div
                className={`text-[11px] font-mono-num flex items-center gap-1 ${
                  revDelta.tone === 'up'
                    ? 'text-emerald-700'
                    : revDelta.tone === 'down'
                      ? 'text-red-700'
                      : 'text-slate-500'
                }`}
              >
                {revDelta.tone === 'up' ? (
                  <TrendingUp className="w-3 h-3 shrink-0" />
                ) : revDelta.tone === 'down' ? (
                  <TrendingDown className="w-3 h-3 shrink-0" />
                ) : null}
                <span>{revDelta.text}</span>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">Laba Kotor Retail</div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-emerald-700">
                {formatRupiah(trendReport.current.grossProfit)}
              </div>
              <div
                className={`text-[11px] font-mono-num ${
                  profitDelta.tone === 'up'
                    ? 'text-emerald-700'
                    : profitDelta.tone === 'down'
                      ? 'text-red-700'
                      : 'text-slate-500'
                }`}
              >
                {profitDelta.text}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">Jumlah Transaksi</div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
                {trendReport.current.transactionCount} trx
              </div>
              <div
                className={`text-[11px] font-mono-num ${
                  trxDelta.tone === 'up'
                    ? 'text-emerald-700'
                    : trxDelta.tone === 'down'
                      ? 'text-red-700'
                      : 'text-slate-500'
                }`}
              >
                {trxDelta.text}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-500">Rata-Rata Nilai Trx</div>
              <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
                {formatRupiah(trendReport.current.avgTransactionValue)}
              </div>
              <div
                className={`text-[11px] font-mono-num ${
                  avgDelta.tone === 'up'
                    ? 'text-emerald-700'
                    : avgDelta.tone === 'down'
                      ? 'text-red-700'
                      : 'text-slate-500'
                }`}
              >
                {avgDelta.text}
              </div>
            </div>
          </div>

          {/* Grafik Tren Penjualan */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Grafik Tren Omzet &amp; Laba Kotor ({granularityLabel})
                </h3>
                <p className="text-xs text-slate-500">
                  Pembanding periode sebelumnya: {resolvedPeriod.prevLabel}
                </p>
              </div>
              <span className="text-xs text-slate-500 font-mono-num">
                HPP: {activeHppMethod === 'fifo' ? 'FIFO' : 'Moving Average'}
              </span>
            </div>
            <SalesTrendChart points={trendReport.trendPoints} granularityLabel={granularityLabel} />
          </section>

          {/* Top Produk Paling Laris & Produk Laba Tertinggi */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Produk Paling Laris ({resolvedPeriod.label})
                </h3>
                <p className="text-xs text-slate-500">
                  Diurutkan berdasarkan total kuantitas terjual dalam satuan dasar produk.
                </p>
              </div>
              {trendReport.topSellingProducts.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada data item produk terjual pada periode ini.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">#</th>
                        <th className="py-3 px-4">Produk</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Terjual</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Omzet</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {trendReport.topSellingProducts.map((item, idx) => (
                        <tr key={item.productId} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-mono-num font-bold text-slate-500">
                            {idx + 1}
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="font-semibold text-slate-900">{item.productName}</div>
                            <div className="text-[11px] text-slate-500">
                              {item.categoryName} · {item.transactionCount} struk
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                            {formatQty(item.baseQtySold)} {item.baseUnit}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num text-emerald-700 font-semibold whitespace-nowrap">
                            {formatRupiah(item.revenue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Produk dengan Laba Tertinggi
                </h3>
                <p className="text-xs text-slate-500">
                  Dihitung dari selisih omzet neto dan HPP ({activeHppMethod === 'fifo' ? 'FIFO' : 'Moving Average'}).
                </p>
              </div>
              {trendReport.topProfitProducts.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada data laba per produk pada periode ini.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">#</th>
                        <th className="py-3 px-4">Produk</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Omzet / HPP</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Laba Kotor</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {trendReport.topProfitProducts.map((item, idx) => (
                        <tr key={item.productId} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-mono-num font-bold text-slate-500">
                            {idx + 1}
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="font-semibold text-slate-900">{item.productName}</div>
                            <div className="text-[11px] text-slate-500">
                              {formatQty(item.baseQtySold)} {item.baseUnit} · {item.categoryName}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num text-slate-600 whitespace-nowrap">
                            <div>{formatRupiah(item.revenue)}</div>
                            <div className="text-[11px] text-slate-400">
                              HPP {formatRupiah(item.cogs)}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num font-bold text-emerald-700 whitespace-nowrap">
                            {formatRupiah(item.profit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 4: BIAYA QRIS & PENGELUARAN OPERASIONAL (FITUR LAMA TETAP UTUH)
      ===================================================================== */}
      {subTab === 'qris_expenses' && (
        <div className="space-y-6">
          {/* Tabel Laporan Biaya QRIS Detail */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-start gap-2">
                <QrCode className="w-4 h-4 text-amber-700 shrink-0 mt-1" />
                <div>
                  <h3 className="font-display font-semibold text-base text-slate-900">
                    Laporan Potongan Biaya QRIS ({resolvedPeriod.label})
                  </h3>
                  <p className="text-xs text-slate-500">
                    Biaya QRIS dihitung hanya dari nominal QRIS sebagai biaya transaksi pembayaran.
                  </p>
                </div>
              </div>
              <div className="text-xs font-mono-num text-slate-700 flex flex-wrap gap-3">
                <span>
                  Bruto QRIS: <strong>{formatRupiah(profitReport.qrisGrossVolume)}</strong>
                </span>
                <span className="text-amber-700">
                  Potongan: <strong>{formatRupiah(profitReport.qrisFeeTotal)}</strong>
                </span>
                <span className="text-emerald-700">
                  Bersih QRIS: <strong>{formatRupiah(profitReport.qrisNetReceived)}</strong>
                </span>
              </div>
            </div>

            {profitReport.qrisSalesRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Tidak ada transaksi dengan metode QRIS atau Gabungan Tunai+QRIS pada periode ini.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-80">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                      <th className="py-3 px-4 whitespace-nowrap">No. Transaksi</th>
                      <th className="py-3 px-4 whitespace-nowrap">Metode</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Omzet Penjualan</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Bagian QRIS</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Tarif</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Potongan QRIS</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Penerimaan Bersih</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {profitReport.qrisSalesRows.map((s) => {
                      const qAmt = Number(s.qrisAmount || 0);
                      const qFee = Number(s.qrisFeeAmount || 0);
                      const qRate = Number(s.qrisFeeRate || 0);
                      const netRecv =
                        s.netReceivedAmount !== undefined
                          ? Number(s.netReceivedAmount)
                          : Math.max(0, Number(s.totalAmount) - qFee);
                      return (
                        <tr key={s.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                            {s.transactionDate} · {s.transactionTime}
                          </td>
                          <td className="py-3 px-4 font-mono-num text-xs font-semibold text-slate-900 whitespace-nowrap">
                            {s.transactionNumber}
                          </td>
                          <td className="py-3 px-4 text-xs uppercase text-slate-600 whitespace-nowrap">
                            {s.paymentMethod === 'mixed' ? 'Tunai + QRIS' : 'QRIS'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-slate-900 whitespace-nowrap">
                            {formatRupiah(s.totalAmount)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-slate-700 whitespace-nowrap">
                            {formatRupiah(qAmt)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-xs text-slate-500 whitespace-nowrap">
                            {formatQty(qRate)}%
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-semibold text-amber-700 whitespace-nowrap">
                            {formatRupiah(qFee)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                            {formatRupiah(netRecv)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Pengeluaran Operasional */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Catat Pengeluaran Operasional
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Saldo akun sumber dana berkurang otomatis dan tercatat di Mutasi Saldo.
                </p>
              </div>

              <form onSubmit={handleCreateExpense} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="exp-cat" className="block text-xs font-medium text-slate-700">
                    Kategori Pengeluaran *
                  </label>
                  <select
                    id="exp-cat"
                    value={expCategory}
                    onChange={(e) => setExpCategory(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {EXPENSE_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label htmlFor="exp-desc" className="block text-xs font-medium text-slate-700">
                    Keterangan Pengeluaran *
                  </label>
                  <input
                    id="exp-desc"
                    type="text"
                    required
                    maxLength={240}
                    value={expDescription}
                    onChange={(e) => setExpDescription(e.target.value)}
                    placeholder="Contoh: Bayar tagihan listrik warung bulan ini"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="exp-amount" className="block text-xs font-medium text-slate-700">
                    Nominal (Rp) *
                  </label>
                  <input
                    id="exp-amount"
                    type="number"
                    min="1"
                    step="any"
                    required
                    value={expAmount}
                    onChange={(e) => setExpAmount(e.target.value)}
                    placeholder="Contoh: 150000"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="exp-acc" className="block text-xs font-medium text-slate-700">
                    Sumber Dana (Kas / Rekening) *
                  </label>
                  <select
                    id="exp-acc"
                    value={expAccountId}
                    onChange={(e) => setExpAccountId(e.target.value)}
                    required
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {activeAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({formatRupiah(acc.balance)}) · {getAccountTypeLabel(acc.type)}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={savingExp || activeAccounts.length === 0}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>{savingExp ? 'Menyimpan...' : 'Simpan Pengeluaran'}</span>
                </button>
              </form>
            </section>

            <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
                <div>
                  <h3 className="font-display font-semibold text-base text-slate-900">
                    Daftar Pengeluaran ({resolvedPeriod.label})
                  </h3>
                  <p className="text-xs text-slate-500">
                    Total pengeluaran periode:{' '}
                    <strong className="font-mono-num text-red-700">
                      {formatRupiah(profitReport.expensesTotal)}
                    </strong>
                  </p>
                </div>
              </div>

              {profitReport.periodExpenses.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada catatan pengeluaran operasional pada periode ini.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4 whitespace-nowrap">Waktu &amp; Ref</th>
                        <th className="py-3 px-4 whitespace-nowrap">Kategori &amp; Keterangan</th>
                        <th className="py-3 px-4 whitespace-nowrap">Sumber Dana</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Nominal</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {profitReport.periodExpenses.map((exp) => (
                        <tr key={exp.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 whitespace-nowrap">
                            <div className="font-mono-num text-xs font-semibold text-slate-900">
                              {exp.transactionNumber}
                            </div>
                            <div className="font-mono-num text-[11px] text-slate-500">
                              {exp.transactionDate} · {exp.transactionTime}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="text-xs font-semibold text-slate-900">{exp.category}</div>
                            <div className="text-xs text-slate-600">{exp.description}</div>
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                            {exp.accountName}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-semibold text-red-700 whitespace-nowrap">
                            {formatRupiah(exp.amount)}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              disabled={deletingExpId === exp.id}
                              onClick={() => handleDeleteExpense(exp)}
                              className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                              title="Hapus pengeluaran & kembalikan saldo akun"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>{deletingExpId === exp.id ? '...' : 'Hapus'}</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 5: RINCIAN TRANSAKSI (PENJUALAN RETAIL, MINI ATM & PPOB)
      ===================================================================== */}
      {subTab === 'details' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-emerald-700" />
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Penjualan Retail ({profitReport.periodSales.length} transaksi)
                </h3>
              </div>
              <span className="font-mono-num text-xs font-semibold text-emerald-700">
                Omzet {formatRupiah(profitReport.salesRevenue)} · Laba ({activeHppMethod === 'fifo' ? 'FIFO' : 'MA'}){' '}
                {formatRupiah(profitReport.salesGrossProfit)}
              </span>
            </div>
            {profitReport.periodSales.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Belum ada penjualan retail selesai pada periode ini.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 whitespace-nowrap">Waktu &amp; No. Struk</th>
                      <th className="py-3 px-4 whitespace-nowrap">Pelanggan / Kasir</th>
                      <th className="py-3 px-4 whitespace-nowrap">Metode</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Omzet</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">
                        HPP ({activeHppMethod === 'fifo' ? 'FIFO' : 'MA'})
                      </th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Laba Kotor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {profitReport.periodSales.map((s) => {
                      const val = profitReport.valuationsBySaleId.get(s.id);
                      const cost = val ? val.cogsActive : Number(s.totalCost || 0);
                      const profit = val
                        ? val.grossProfitActive
                        : Number(s.totalProfit ?? Number(s.totalAmount) - cost);
                      return (
                        <tr key={s.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 whitespace-nowrap">
                            <div className="font-mono-num text-xs font-semibold text-slate-900">
                              {s.transactionNumber}
                            </div>
                            <div className="font-mono-num text-[11px] text-slate-500">
                              {s.transactionDate} · {s.transactionTime}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-xs">
                            <div className="text-slate-900">{s.customerName || 'Pelanggan Umum'}</div>
                            <div className="text-[11px] text-slate-500">Kasir: {s.recordedByName}</div>
                          </td>
                          <td className="py-2.5 px-4 text-xs uppercase text-slate-600 whitespace-nowrap">
                            {s.paymentMethod === 'mixed' ? 'Tunai+QRIS' : s.paymentMethod}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                            {formatRupiah(s.totalAmount)}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num text-slate-600 whitespace-nowrap">
                            {formatRupiah(cost)}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                            {formatRupiah(profit)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Landmark className="w-4 h-4 text-emerald-700" />
                  <h3 className="font-display font-semibold text-base text-slate-900">
                    Mini ATM ({profitReport.periodMiniAtms.length} trx)
                  </h3>
                </div>
                <span className="font-mono-num text-xs font-semibold text-emerald-700">
                  Laba {formatRupiah(profitReport.miniAtmProfit)}
                </span>
              </div>
              {profitReport.periodMiniAtms.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada transaksi Mini ATM selesai pada periode ini.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-72">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-4">No. Trx &amp; Layanan</th>
                        <th className="py-2.5 px-4 text-right">Pokok</th>
                        <th className="py-2.5 px-4 text-right">Laba</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {profitReport.periodMiniAtms.map((t) => (
                        <tr key={t.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4">
                            <div className="font-mono-num font-semibold text-slate-900">
                              {t.transactionNumber}
                            </div>
                            <div className="text-slate-600">
                              {getMiniAtmServiceLabel(t.serviceType)} · {t.bankName}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num text-slate-800 whitespace-nowrap">
                            {formatRupiah(t.principalAmount)}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                            {formatRupiah(t.netProfit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Download className="w-4 h-4 text-emerald-700" />
                  <h3 className="font-display font-semibold text-base text-slate-900">
                    PPOB ({profitReport.periodPpobs.length} trx)
                  </h3>
                </div>
                <span className="font-mono-num text-xs font-semibold text-emerald-700">
                  Laba {formatRupiah(profitReport.ppobProfit)}
                </span>
              </div>
              {profitReport.periodPpobs.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada transaksi PPOB selesai pada periode ini.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-72">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-4">No. Trx &amp; Produk</th>
                        <th className="py-2.5 px-4 text-right">Tagihan</th>
                        <th className="py-2.5 px-4 text-right">Laba</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {profitReport.periodPpobs.map((t) => (
                        <tr key={t.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4">
                            <div className="font-mono-num font-semibold text-slate-900">
                              {t.transactionNumber}
                            </div>
                            <div className="text-slate-600">
                              {getPpobCategoryLabel(t.category)} · {t.providerName}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num text-slate-800 whitespace-nowrap">
                            {formatRupiah(Number(t.sellPrice) + Number(t.adminFee))}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                            {formatRupiah(t.netProfit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
