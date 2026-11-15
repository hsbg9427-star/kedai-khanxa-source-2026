import React, { useMemo, useState } from 'react';
import {
  Wallet,
  ShoppingBag,
  Landmark,
  Receipt,
  ArrowUpRight,
  CheckCircle2,
  Wifi,
  WifiOff,
  ShoppingCart,
  Package,
  AlertTriangle,
  BookUser,
  HandCoins,
  FileBarChart2,
  Smartphone,
  Truck,
  ClipboardCheck,
  Target,
  TrendingUp,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type { Account, Customer, Product, StoreSetting } from '../types/database';
import { saveDailySalesTarget, type TodayDashboardMetrics } from '../services/warungService';
import type { NavTab } from '../components/AppShell';
import {
  formatIndonesianDate,
  formatQty,
  formatRupiah,
  getAccountTypeLabel,
  getRoleLabel,
  getTodayDateString,
} from '../utils/formatters';
import { formatProductStockSummary } from '../utils/unitConversion';
import { getReadableFirestoreError } from '../utils/firestoreError';

interface DashboardPageProps {
  storeSetting: StoreSetting | null;
  accounts: Account[];
  accountsLoading: boolean;
  customers: Customer[];
  products: Product[];
  metrics: TodayDashboardMetrics;
  onNavigate: (tab: NavTab) => void;
}

export function DashboardPage({
  storeSetting,
  accounts,
  accountsLoading,
  customers,
  products,
  metrics,
  onNavigate,
}: DashboardPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline, hasPendingSync, lastSyncedAt } = useNetwork();

  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);

  const todayStr = getTodayDateString();
  const activeAccounts = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);
  const cashAccounts = useMemo(
    () => activeAccounts.filter((a) => a.type === 'cash'),
    [activeAccounts]
  );

  const totalBalance = useMemo(
    () => activeAccounts.reduce((acc, item) => acc + (Number(item.balance) || 0), 0),
    [activeAccounts]
  );
  const cashBalance = useMemo(
    () => cashAccounts.reduce((acc, item) => acc + (Number(item.balance) || 0), 0),
    [cashAccounts]
  );

  const totalReceivables = useMemo(
    () => customers.reduce((sum, c) => sum + (Number(c.totalDebt) || 0), 0),
    [customers]
  );
  const debtorsCount = useMemo(
    () => customers.filter((c) => Number(c.totalDebt) > 0).length,
    [customers]
  );

  const lowStockProducts = useMemo(() => {
    return products
      .filter((p) => p.isActive && Number(p.stock) <= Number(p.minStock))
      .slice()
      .sort((a, b) => {
        const ratioA = Number(a.minStock) > 0 ? Number(a.stock) / Number(a.minStock) : Number(a.stock);
        const ratioB = Number(b.minStock) > 0 ? Number(b.stock) / Number(b.minStock) : Number(b.stock);
        return ratioA - ratioB;
      });
  }, [products]);

  const totalTransactions = metrics.retailSalesCount + metrics.miniAtmCount + metrics.ppobCount;
  const totalServiceProfit = metrics.miniAtmProfitTotal + metrics.ppobProfitTotal;
  const totalServiceCount = metrics.miniAtmCount + metrics.ppobCount;
  const totalEstimatedGrossProfit =
    metrics.retailProfitTotal + metrics.miniAtmProfitTotal + metrics.ppobProfitTotal;
  const totalEstimatedNetProfit = Number(
    (totalEstimatedGrossProfit - metrics.retailQrisFeeTotal).toFixed(2)
  );

  const salesTarget = Math.max(0, Number(storeSetting?.dailySalesTarget || 0));
  const totalSalesToday = metrics.retailSalesTotal;
  const targetProgressRaw = salesTarget > 0 ? (totalSalesToday / salesTarget) * 100 : 0;
  const targetProgressPercent = Math.min(100, Math.max(0, Number(targetProgressRaw.toFixed(1))));
  const targetRemaining = Math.max(0, salesTarget - totalSalesToday);
  const targetSurplus = Math.max(0, totalSalesToday - salesTarget);
  const avgBasket =
    metrics.retailSalesCount > 0 ? Math.round(totalSalesToday / metrics.retailSalesCount) : 0;

  const handleOpenEditTarget = () => {
    setTargetInput(String(salesTarget > 0 ? salesTarget : 1000000));
    setTargetError(null);
    setEditingTarget(true);
  };

  const handleSaveTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin) return;
    const parsed = Math.max(0, Math.round(Number(targetInput) || 0));
    setSavingTarget(true);
    setTargetError(null);
    try {
      await saveDailySalesTarget(
        parsed,
        storeSetting,
        profile?.displayName || user.displayName || 'Admin',
        user.uid
      );
      setEditingTarget(false);
    } catch (error) {
      setTargetError(getReadableFirestoreError(error));
    } finally {
      setSavingTarget(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header Operasional Kedai & Aksi Cepat */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span>{formatIndonesianDate(todayStr)}</span>
              <span aria-hidden="true">·</span>
              <span>{getRoleLabel(profile?.role || (isAdmin ? 'admin' : 'kasir'))}</span>
              {profile?.shiftLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{profile.shiftLabel}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span
                className={`inline-flex items-center gap-1 font-medium ${
                  isOnline ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                <span>
                  {isOnline
                    ? hasPendingSync
                      ? 'Menyinkronkan'
                      : 'Tersinkron'
                    : 'Mode Offline'}
                </span>
              </span>
              {lastSyncedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-num">
                    {lastSyncedAt.toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </>
              )}
            </div>
            <h2 className="font-display text-lg sm:text-xl font-bold text-slate-900 truncate">
              Operasional Harian {storeSetting?.storeName || 'KEDAI KHANXA'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-600">
              Halo, {profile?.displayName || 'Petugas'}. Pantau saldo, omzet, transaksi layanan, dan stok barang hari ini.
            </p>
          </div>

          <button
            type="button"
            onClick={() => onNavigate('pos')}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ShoppingCart className="w-4 h-4" />
            <span>Buka Kasir Retail</span>
          </button>
        </div>

        {/* Pintasan Modul Usaha */}
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate('mini_atm')}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Landmark className="w-3.5 h-3.5 text-slate-600" />
            <span>Mini ATM</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('ppob')}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Smartphone className="w-3.5 h-3.5 text-slate-600" />
            <span>PPOB</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('products')}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Package className="w-3.5 h-3.5 text-slate-600" />
            <span>Produk &amp; Stok</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('stock_opname')}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ClipboardCheck className="w-3.5 h-3.5 text-slate-600" />
            <span>Stok Opname</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('customers')}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <BookUser className="w-3.5 h-3.5 text-slate-600" />
            <span>Kasbon</span>
          </button>
          {isAdmin && (
            <>
              <button
                type="button"
                onClick={() => onNavigate('purchases')}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Truck className="w-3.5 h-3.5 text-slate-600" />
                <span>Pembelian</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('loans')}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <HandCoins className="w-3.5 h-3.5 text-slate-600" />
                <span>Pinjaman</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('accounts')}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Wallet className="w-3.5 h-3.5 text-slate-600" />
                <span>Kas &amp; Saldo</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/70 text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FileBarChart2 className="w-3.5 h-3.5 text-slate-600" />
                <span>Laporan</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Baris KPI Utama: Saldo Kas, Penjualan Hari Ini, Jumlah Transaksi, Estimasi Laba */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
            <span className="truncate">
              {isAdmin ? 'Saldo Kas & Rekening' : 'Saldo Kas Laci & Akun'}
            </span>
            <Wallet className="w-4 h-4 text-emerald-700 shrink-0" />
          </div>
          <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900 truncate">
            {accountsLoading
              ? '...'
              : formatRupiah(isAdmin ? totalBalance : cashAccounts.length > 0 ? cashBalance : totalBalance)}
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 font-mono-num truncate">
            {isAdmin
              ? `${activeAccounts.length} akun aktif · Kas ${formatRupiah(cashBalance)}`
              : `${activeAccounts.length} akun pembayaran aktif`}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
            <span className="truncate">Penjualan Hari Ini</span>
            <ShoppingBag className="w-4 h-4 text-emerald-700 shrink-0" />
          </div>
          <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900 truncate">
            {formatRupiah(totalSalesToday)}
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 font-mono-num truncate">
            {salesTarget > 0
              ? `${targetProgressPercent}% dari target harian`
              : `Rata-rata ${formatRupiah(avgBasket)} / struk`}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
            <span className="truncate">Jumlah Transaksi</span>
            <Receipt className="w-4 h-4 text-slate-600 shrink-0" />
          </div>
          <div className="font-mono-num text-lg sm:text-2xl font-bold text-slate-900">
            {totalTransactions} <span className="text-xs sm:text-sm font-medium text-slate-500">trx</span>
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 font-mono-num truncate">
            Retail {metrics.retailSalesCount} · ATM {metrics.miniAtmCount} · PPOB {metrics.ppobCount}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
            <span className="truncate">Estimasi Laba</span>
            <TrendingUp className="w-4 h-4 text-emerald-700 shrink-0" />
          </div>
          <div
            className={`font-mono-num text-lg sm:text-2xl font-bold truncate ${
              totalEstimatedNetProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {formatRupiah(totalEstimatedNetProfit)}
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 font-mono-num truncate">
            Retail {formatRupiah(metrics.retailProfitTotal)} · Layanan {formatRupiah(totalServiceProfit)}
          </div>
        </div>
      </div>

      {/* Baris Target Penjualan & Ringkasan Mini ATM + PPOB */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Target Penjualan Harian */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
                <Target className="w-4 h-4" />
              </div>
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Target Penjualan Hari Ini
                </h3>
                <p className="text-xs text-slate-500">
                  Pemantauan capaian omzet retail harian kedai.
                </p>
              </div>
            </div>

            {isAdmin && !editingTarget && (
              <button
                type="button"
                onClick={handleOpenEditTarget}
                className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>{salesTarget > 0 ? 'Ubah Target' : 'Atur Target'}</span>
              </button>
            )}
          </div>

          {editingTarget && isAdmin ? (
            <form onSubmit={handleSaveTarget} className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-3">
              <div className="space-y-1">
                <label htmlFor="dash-sales-target" className="block text-xs font-medium text-slate-700">
                  Nominal Target Penjualan Harian (Rp)
                </label>
                <input
                  id="dash-sales-target"
                  type="number"
                  min="0"
                  step="50000"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              {targetError && <p className="text-xs text-red-700">{targetError}</p>}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingTarget(false)}
                  className="min-h-[40px] inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Batal</span>
                </button>
                <button
                  type="submit"
                  disabled={savingTarget}
                  className="min-h-[40px] inline-flex items-center gap-1 px-4 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{savingTarget ? 'Menyimpan...' : 'Simpan Target'}</span>
                </button>
              </div>
            </form>
          ) : salesTarget > 0 ? (
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-2">
                <div>
                  <div className="text-xs text-slate-500">Tercapai Hari Ini</div>
                  <div className="font-mono-num text-xl font-bold text-slate-900">
                    {formatRupiah(totalSalesToday)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">Target Harian</div>
                  <div className="font-mono-num text-sm font-semibold text-slate-700">
                    {formatRupiah(salesTarget)}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden border border-slate-200">
                  <div
                    className={`h-full transition-all duration-300 ${
                      targetProgressRaw >= 100 ? 'bg-emerald-600' : 'bg-emerald-700'
                    }`}
                    style={{ width: `${targetProgressPercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs font-mono-num">
                  <span className="font-semibold text-emerald-700">
                    {targetProgressPercent}% tercapai
                  </span>
                  {targetRemaining > 0 ? (
                    <span className="text-slate-600">Kurang {formatRupiah(targetRemaining)}</span>
                  ) : (
                    <span className="text-emerald-700 font-semibold">
                      Target terlampaui +{formatRupiah(targetSurplus)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-slate-800">
                  Target penjualan harian belum diatur
                </div>
                <p className="text-xs text-slate-500">
                  Omzet retail saat ini {formatRupiah(totalSalesToday)} dari {metrics.retailSalesCount} transaksi.
                </p>
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={handleOpenEditTarget}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Pasang Target
                </button>
              )}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-slate-500">Struk Retail</div>
              <div className="font-mono-num font-semibold text-slate-900">
                {metrics.retailSalesCount} trx
              </div>
            </div>
            <div>
              <div className="text-slate-500">Potongan QRIS</div>
              <div className="font-mono-num font-semibold text-amber-700">
                {formatRupiah(metrics.retailQrisFeeTotal)}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Pengeluaran</div>
              <div className="font-mono-num font-semibold text-slate-900">
                {formatRupiah(metrics.expensesTotal)}
              </div>
            </div>
          </div>
        </section>

        {/* Ringkasan Mini ATM & PPOB Hari Ini */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Ringkasan Mini ATM &amp; PPOB
              </h3>
              <p className="text-xs text-slate-500">
                Performa transaksi layanan keuangan dan tagihan hari ini.
              </p>
            </div>
            <div className="text-right font-mono-num">
              <div className="text-[11px] text-slate-500">Total Laba Layanan</div>
              <div className="text-sm font-bold text-emerald-700">
                {formatRupiah(totalServiceProfit)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Sub-ringkasan Mini ATM */}
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                  <Landmark className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span>Mini ATM</span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('mini_atm')}
                  className="text-xs font-medium text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-0.5 cursor-pointer"
                >
                  <span>Buka</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Transaksi</span>
                  <span className="font-mono-num font-semibold text-slate-900">
                    {metrics.miniAtmCount} trx
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Nominal Pokok</span>
                  <span className="font-mono-num font-medium text-slate-800">
                    {formatRupiah(metrics.miniAtmVolumeTotal)}
                  </span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-200">
                  <span className="text-slate-600 font-medium">Laba Bersih</span>
                  <span className="font-mono-num font-bold text-emerald-700">
                    {formatRupiah(metrics.miniAtmProfitTotal)}
                  </span>
                </div>
              </div>
            </div>

            {/* Sub-ringkasan PPOB */}
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                  <Smartphone className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span>PPOB</span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('ppob')}
                  className="text-xs font-medium text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-0.5 cursor-pointer"
                >
                  <span>Buka</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Transaksi</span>
                  <span className="font-mono-num font-semibold text-slate-900">
                    {metrics.ppobCount} trx
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Total Omzet</span>
                  <span className="font-mono-num font-medium text-slate-800">
                    {formatRupiah(metrics.ppobSalesTotal)}
                  </span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-200">
                  <span className="text-slate-600 font-medium">Laba Bersih</span>
                  <span className="font-mono-num font-bold text-emerald-700">
                    {formatRupiah(metrics.ppobProfitTotal)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-mono-num">
            <span>Total {totalServiceCount} transaksi layanan selesai hari ini</span>
            <span>Pengeluaran: {metrics.expensesCount} catatan</span>
          </div>
        </section>
      </div>

      {/* Baris Saldo Kas & Rekening + Stok Menipis */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Saldo Kas & Rekening */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Saldo Kas &amp; Rekening
              </h3>
              <p className="text-xs text-slate-500">
                Posisi saldo laci kas, rekening bank, e-wallet, dan deposit PPOB.
              </p>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => onNavigate('accounts')}
                className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Kelola Akun
              </button>
            )}
          </div>

          {accountsLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((row) => (
                <div key={row} className="h-10 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : activeAccounts.length === 0 ? (
            <div className="p-8 text-center space-y-3">
              <p className="text-sm text-slate-600">
                Belum ada akun kas laci, rekening bank, atau deposit PPOB yang aktif.
              </p>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => onNavigate('accounts')}
                  className="min-h-[44px] inline-flex items-center justify-center px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 transition-colors cursor-pointer"
                >
                  Tambah Kas / Rekening
                </button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {activeAccounts.map((acc) => (
                <div
                  key={acc.id}
                  className="px-5 py-3 flex items-center justify-between gap-4 hover:bg-slate-50 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{acc.name}</div>
                    <div className="text-xs text-slate-500 truncate">
                      {getAccountTypeLabel(acc.type)}
                      {acc.accountNumber ? ` · ${acc.accountNumber}` : ''}
                    </div>
                  </div>
                  <div className="font-mono-num text-sm font-semibold text-slate-900 shrink-0">
                    {formatRupiah(acc.balance)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Stok Menipis */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {lowStockProducts.length > 0 ? (
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              )}
              <div className="min-w-0">
                <h3 className="font-display font-semibold text-base text-slate-900 truncate">
                  Stok Menipis ({lowStockProducts.length})
                </h3>
                <p className="text-xs text-slate-500 truncate">
                  Barang dengan stok di bawah atau sama dengan batas minimum.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('products')}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Semua Produk
            </button>
          </div>

          {lowStockProducts.length === 0 ? (
            <div className="p-6 flex-1 flex flex-col items-center justify-center text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
              <div className="text-sm font-medium text-slate-900">Semua Stok Produk Aman</div>
              <p className="text-xs text-slate-500">
                Tidak ada barang aktif yang mencapai batas minimum saat ini.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 flex-1">
              {lowStockProducts.slice(0, 6).map((p) => {
                const stockLabel = formatProductStockSummary(p.stock, p).primary;
                const isZero = Number(p.stock) <= 1e-6;
                return (
                  <div
                    key={p.id}
                    className="px-5 py-3 flex items-center justify-between gap-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{p.name}</div>
                      <div className="text-xs text-slate-500 font-mono-num truncate">
                        {p.sku} · Min {formatQty(p.minStock)} {p.unit}
                      </div>
                    </div>
                    <div
                      className={`font-mono-num text-xs font-semibold shrink-0 ${
                        isZero ? 'text-red-700' : 'text-amber-700'
                      }`}
                    >
                      {isZero ? 'Habis (0)' : `Sisa ${stockLabel}`}
                    </div>
                  </div>
                );
              })}
              {lowStockProducts.length > 6 && (
                <div className="px-5 py-2.5 bg-slate-50 text-xs text-slate-600 flex items-center justify-between">
                  <span className="font-mono-num">
                    +{lowStockProducts.length - 6} produk lainnya menipis
                  </span>
                  <button
                    type="button"
                    onClick={() => onNavigate('products')}
                    className="font-semibold text-emerald-700 hover:underline cursor-pointer"
                  >
                    Cek Stok
                  </button>
                </div>
              )}
            </div>
          )}

          {isAdmin && lowStockProducts.length > 0 && (
            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onNavigate('purchases')}
                className="min-h-[38px] flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
              >
                <Truck className="w-3.5 h-3.5" />
                <span>Buat Pembelian</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('stock_opname')}
                className="min-h-[38px] flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-100 cursor-pointer"
              >
                <ClipboardCheck className="w-3.5 h-3.5" />
                <span>Stok Opname</span>
              </button>
            </div>
          )}
        </section>
      </div>

      {/* Ringkasan Piutang Pelanggan Aktif */}
      {totalReceivables > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <BookUser className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-slate-900">
                Piutang Pelanggan Aktif:{' '}
                <span className="font-mono-num text-amber-700">
                  {formatRupiah(totalReceivables)}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 font-mono-num">
                {debtorsCount} pelanggan memiliki tagihan kasbon belum lunas
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('customers')}
            className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>Kelola Piutang</span>
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
