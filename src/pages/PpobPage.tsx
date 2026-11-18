import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Smartphone,
  Search,
  CheckCircle2,
  X,
  Receipt,
  AlertCircle,
  WifiOff,
  Clock,
  RotateCcw,
  Printer,
  Copy,
  Download,
  Share2,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type { Account, PpobTransaction, StoreSetting } from '../types/database';
import {
  completePendingPpobTransaction,
  failAndRefundPpobTransaction,
  recordPpobTransaction,
  subscribePpobTransactions,
} from '../services/serviceModuleService';
import {
  calculatePpobBreakdown,
  getPpobCategoryLabel,
  getPpobStatusLabel,
  PPOB_CATEGORY_OPTIONS,
  type PpobCategory,
} from '../utils/serviceTransactions';
import { formatRupiah, getTodayDateString } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import { formatPpobReceiptText } from '../utils/posReceipt';
import {
  buildRawBtThermalUrl,
  downloadThermalReceiptPdf,
  printThermalReceiptText,
} from '../utils/receiptPrinter';

interface PpobPageProps {
  accounts: Account[];
  storeSetting: StoreSetting | null;
}

export function PpobPage({ accounts, storeSetting }: PpobPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [transactions, setTransactions] = useState<PpobTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasPendingWrites, setHasPendingWrites] = useState(false);

  // Form State
  const [category, setCategory] = useState<PpobCategory>('pulsa');
  const [providerName, setProviderName] = useState('Telkomsel');
  const [targetNumber, setTargetNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [capitalPrice, setCapitalPrice] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [adminFee, setAdminFee] = useState('0');
  const [serialNumber, setSerialNumber] = useState('');
  const [initialStatus, setInitialStatus] = useState<'completed' | 'pending'>('completed');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [cashAccountId, setCashAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  // Filter, Feedback & Action Modals
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'pending' | 'failed'>(
    'all'
  );
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [receiptTx, setReceiptTx] = useState<PpobTransaction | null>(null);
  const [receiptPrintNotice, setReceiptPrintNotice] = useState<string | null>(null);
  const [receiptCopied, setReceiptCopied] = useState(false);
  const [completingTx, setCompletingTx] = useState<PpobTransaction | null>(null);
  const [completingSn, setCompletingSn] = useState('');
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  const submitLockRef = useRef(false);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);
  const depositCandidates = useMemo(() => {
    const ppobAccs = activeAccounts.filter((a) => a.type === 'ppob_deposit');
    if (ppobAccs.length > 0) return ppobAccs;
    const wallets = activeAccounts.filter((a) => a.type === 'ewallet' || a.type === 'bank');
    return wallets.length > 0 ? wallets : activeAccounts;
  }, [activeAccounts]);

  const cashCandidates = useMemo(() => {
    const cash = activeAccounts.filter((a) => a.type === 'cash');
    return cash.length > 0 ? cash : activeAccounts;
  }, [activeAccounts]);

  useEffect(() => {
    if (!depositAccountId && depositCandidates.length > 0) {
      setDepositAccountId(depositCandidates[0].id);
    }
  }, [depositCandidates, depositAccountId]);

  useEffect(() => {
    if (!cashAccountId && cashCandidates.length > 0) {
      setCashAccountId(cashCandidates[0].id);
    }
  }, [cashCandidates, cashAccountId]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const unsub = subscribePpobTransactions(
      isAdmin,
      user.uid,
      (rows, pending) => {
        setTransactions(rows);
        setHasPendingWrites(pending);
        setLoading(false);
      },
      (err) => {
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
        setLoading(false);
      }
    );
    return () => unsub();
  }, [isAdmin, user]);

  const currentCatMeta =
    PPOB_CATEGORY_OPTIONS.find((c) => c.id === category) || PPOB_CATEGORY_OPTIONS[0];

  const handleCategoryChange = (nextCat: PpobCategory) => {
    setCategory(nextCat);
    const meta = PPOB_CATEGORY_OPTIONS.find((c) => c.id === nextCat);
    if (meta && meta.providers.length > 0) {
      setProviderName(meta.providers[0]);
    }
  };

  const selectedDepositAccount = activeAccounts.find((a) => a.id === depositAccountId) || null;
  const selectedCashAccount = activeAccounts.find((a) => a.id === cashAccountId) || null;

  const previewBreakdown = useMemo(() => {
    const cap = Number(capitalPrice) || 0;
    const sell = Number(sellPrice) || 0;
    const adm = Number(adminFee) || 0;
    if (cap <= 0 && sell <= 0 && adm <= 0) return null;
    try {
      return calculatePpobBreakdown({
        capitalPrice: Math.max(0, cap),
        sellPrice: Math.max(0, sell),
        adminFee: Math.max(0, adm),
      });
    } catch {
      return null;
    }
  }, [capitalPrice, sellPrice, adminFee]);

  const todayDate = getTodayDateString();
  const todayStats = useMemo(() => {
    const completedRows = transactions.filter(
      (t) => t.status === 'completed' && t.transactionDate === todayDate
    );
    const pendingCount = transactions.filter((t) => t.status === 'pending').length;
    return {
      count: completedRows.length,
      pendingCount,
      omzet: completedRows.reduce(
        (sum, r) => sum + (Number(r.sellPrice) || 0) + (Number(r.adminFee) || 0),
        0
      ),
      capitalTotal: completedRows.reduce((sum, r) => sum + (Number(r.capitalPrice) || 0), 0),
      profitTotal: completedRows.reduce((sum, r) => sum + (Number(r.netProfit) || 0), 0),
    };
  }, [transactions, todayDate]);

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.transactionNumber.toLowerCase().includes(q) ||
        t.providerName.toLowerCase().includes(q) ||
        t.targetNumber.toLowerCase().includes(q) ||
        (t.customerName || '').toLowerCase().includes(q) ||
        (t.serialNumber || '').toLowerCase().includes(q)
      );
    });
  }, [transactions, searchQuery, statusFilter]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || submitLockRef.current) return;
    setFeedback(null);

    if (!selectedDepositAccount || !selectedCashAccount) {
      setFeedback({
        kind: 'err',
        text: 'Akun Deposit Server PPOB dan Akun Penerima Bayar wajib tersedia dan aktif.',
      });
      return;
    }

    submitLockRef.current = true;
    setSaving(true);

    try {
      const result = await recordPpobTransaction(
        {
          category,
          providerName,
          targetNumber,
          customerName,
          capitalPrice: Number(capitalPrice) || 0,
          sellPrice: Number(sellPrice) || 0,
          adminFee: Number(adminFee) || 0,
          depositAccount: selectedDepositAccount,
          cashAccount: selectedCashAccount,
          serialNumber,
          status: initialStatus,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Kasir',
        }
      );

      setFeedback({
        kind: 'ok',
        text: isAdmin
          ? `Transaksi PPOB ${result.transactionNumber} berhasil dicatat. Tagihan pelanggan: ${formatRupiah(
              result.customerTotal
            )}, Laba: ${formatRupiah(result.netProfit)}.`
          : `Transaksi PPOB ${result.transactionNumber} berhasil dicatat. Tagihan pelanggan: ${formatRupiah(
              result.customerTotal
            )}.`,
      });
      setTargetNumber('');
      setCustomerName('');
      setCapitalPrice('');
      setSellPrice('');
      setAdminFee('0');
      setSerialNumber('');
      setInitialStatus('completed');
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSaving(false);
      submitLockRef.current = false;
    }
  };

  const handleConfirmCompletePending = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!completingTx || actionBusyId) return;
    setActionBusyId(completingTx.id);
    setFeedback(null);
    try {
      await completePendingPpobTransaction(completingTx, completingSn);
      setFeedback({
        kind: 'ok',
        text: `Transaksi ${completingTx.transactionNumber} selesai dikonfirmasi.`,
      });
      setCompletingTx(null);
      setCompletingSn('');
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setActionBusyId(null);
    }
  };

  const handleFailRefund = async (txDoc: PpobTransaction) => {
    if (!user || actionBusyId) return;
    setActionBusyId(txDoc.id);
    setFeedback(null);
    try {
      await failAndRefundPpobTransaction(txDoc, accounts, {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Petugas',
      });
      setFeedback({
        kind: 'ok',
        text: `Transaksi ${txDoc.transactionNumber} ditandai Gagal & saldo modal/kas telah dikembalikan.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setActionBusyId(null);
    }
  };

  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accounts) map.set(acc.id, acc.name);
    return map;
  }, [accounts]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-emerald-700" />
            <h2 className="font-display font-bold text-lg text-slate-900">
              Transaksi PPOB &amp; Pembayaran Digital KEDAI KHANXA
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            Pulsa, Paket Data, Token &amp; Tagihan PLN, PDAM, BPJS, serta Top-Up E-Wallet dengan
            pemotongan modal deposit dan penerimaan kas otomatis.
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-500 shrink-0">
          {!isOnline && (
            <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium">
              <WifiOff className="w-3.5 h-3.5" />
              <span>Mode Offline</span>
            </span>
          )}
          {hasPendingWrites && (
            <span className="text-amber-700 font-medium">Menyinkronkan perubahan...</span>
          )}
        </div>
      </div>

      {/* Today KPI */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 ${isAdmin ? 'xl:grid-cols-4' : 'xl:grid-cols-2'} gap-4`}>
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Transaksi PPOB Hari Ini</div>
          <div className="font-mono-num text-xl font-bold text-slate-900">
            {todayStats.count} Sukses
          </div>
          <div className="text-[11px] text-amber-700 font-mono-num">
            {todayStats.pendingCount} transaksi menunggu (pending)
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Omzet PPOB Hari Ini</div>
          <div className="font-mono-num text-xl font-bold text-slate-900">
            {formatRupiah(todayStats.omzet)}
          </div>
          <div className="text-[11px] text-slate-400">Harga jual + biaya admin</div>
        </div>
        {isAdmin && (
          <>
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
              <div className="text-xs text-slate-500">Modal Deposit Terpakai</div>
              <div className="font-mono-num text-xl font-bold text-slate-900">
                {formatRupiah(todayStats.capitalTotal)}
              </div>
              <div className="text-[11px] text-slate-400">Terpotong dari akun deposit</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
              <div className="text-xs text-slate-500">Laba Bersih PPOB</div>
              <div className="font-mono-num text-xl font-bold text-emerald-700">
                {formatRupiah(todayStats.profitTotal)}
              </div>
              <div className="text-[11px] text-slate-400">Total bayar pelanggan - modal</div>
            </div>
          </>
        )}
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
            aria-label="Tutup notifikasi"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {activeAccounts.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800 flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Belum Ada Akun Kas atau Deposit PPOB</div>
            <p className="text-xs mt-0.5">
              Hubungi Admin untuk membuat akun <strong>Deposit Server PPOB</strong> dan{' '}
              <strong>Laci Kas</strong> terlebih dahulu di menu Kas &amp; Rekening.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Form Transaksi PPOB */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div>
            <h3 className="font-display font-semibold text-base text-slate-900">
              Catat Transaksi PPOB Baru
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Pilih kategori layanan, masukkan nomor tujuan, harga modal, dan harga jual.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Kategori PPOB */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">Kategori Layanan</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PPOB_CATEGORY_OPTIONS.map((cat) => {
                  const selected = category === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => handleCategoryChange(cat.id)}
                      className={`min-h-[40px] px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors text-left cursor-pointer ${
                        selected
                          ? 'bg-emerald-700 border-emerald-700 text-white font-semibold'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Provider / Produk */}
            <div className="space-y-1.5">
              <label htmlFor="ppob-provider" className="block text-xs font-medium text-slate-700">
                Provider / Nama Produk *
              </label>
              <input
                id="ppob-provider"
                type="text"
                value={providerName}
                onChange={(e) => setProviderName(e.target.value)}
                required
                maxLength={80}
                placeholder="Contoh: Telkomsel 10rb / PLN Token 50rb"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {currentCatMeta.providers.map((prov) => (
                  <button
                    key={prov}
                    type="button"
                    onClick={() => setProviderName(prov)}
                    className={`px-2 py-1 rounded text-[11px] font-medium border cursor-pointer ${
                      providerName === prov
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {prov}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="ppob-target" className="block text-xs font-medium text-slate-700">
                  {currentCatMeta.targetLabel} *
                </label>
                <input
                  id="ppob-target"
                  type="text"
                  value={targetNumber}
                  onChange={(e) => setTargetNumber(e.target.value)}
                  required
                  minLength={3}
                  maxLength={50}
                  placeholder={currentCatMeta.targetPlaceholder}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="ppob-cust" className="block text-xs font-medium text-slate-700">
                  Nama Pelanggan (Opsional)
                </label>
                <input
                  id="ppob-cust"
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  maxLength={100}
                  placeholder="Nama pembeli"
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            {/* Modal, Harga Jual, Biaya Admin */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label htmlFor="ppob-capital" className="block text-xs font-medium text-slate-700">
                  Harga Modal (Rp) *
                </label>
                <input
                  id="ppob-capital"
                  type="number"
                  min="0"
                  step="any"
                  value={capitalPrice}
                  onChange={(e) => setCapitalPrice(e.target.value)}
                  required
                  placeholder="10200"
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="ppob-sell" className="block text-xs font-medium text-slate-700">
                  Harga Jual (Rp) *
                </label>
                <input
                  id="ppob-sell"
                  type="number"
                  min="0"
                  step="any"
                  value={sellPrice}
                  onChange={(e) => setSellPrice(e.target.value)}
                  required
                  placeholder="12000"
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="ppob-admin" className="block text-xs font-medium text-slate-700">
                  Biaya Admin (Rp)
                </label>
                <input
                  id="ppob-admin"
                  type="number"
                  min="0"
                  step="any"
                  value={adminFee}
                  onChange={(e) => setAdminFee(e.target.value)}
                  placeholder="0"
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            {/* Sumber Modal Deposit & Akun Penerima */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="ppob-deposit-acc" className="block text-xs font-medium text-slate-700">
                  Sumber Modal / Deposit PPOB *
                </label>
                <select
                  id="ppob-deposit-acc"
                  value={depositAccountId}
                  onChange={(e) => setDepositAccountId(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {activeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name}
                      {isAdmin ? ` (${formatRupiah(acc.balance)})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="ppob-cash-acc" className="block text-xs font-medium text-slate-700">
                  Akun Kas Penerima Bayar *
                </label>
                <select
                  id="ppob-cash-acc"
                  value={cashAccountId}
                  onChange={(e) => setCashAccountId(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {activeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name}
                      {isAdmin ? ` (${formatRupiah(acc.balance)})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* SN / Token & Status */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="ppob-sn" className="block text-xs font-medium text-slate-700">
                  No. SN / Token PLN (Opsional)
                </label>
                <input
                  id="ppob-sn"
                  type="text"
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                  maxLength={100}
                  placeholder="Token / Serial Number"
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="ppob-status" className="block text-xs font-medium text-slate-700">
                  Status Transaksi
                </label>
                <select
                  id="ppob-status"
                  value={initialStatus}
                  onChange={(e) => setInitialStatus(e.target.value as 'completed' | 'pending')}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  <option value="completed">Sukses (Langsung Selesai)</option>
                  <option value="pending">Pending (Menunggu SN)</option>
                </select>
              </div>
            </div>

            {/* Preview Profit & Mutasi */}
            {previewBreakdown && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Total Tagihan Pelanggan</span>
                  <span className="font-mono-num font-bold text-slate-900">
                    {formatRupiah(previewBreakdown.customerTotal)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">
                    Potong {selectedDepositAccount?.name || 'Deposit PPOB'}
                  </span>
                  <span className="font-mono-num font-semibold text-red-700">
                    -{formatRupiah(previewBreakdown.capitalPrice)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">
                    Masuk ke {selectedCashAccount?.name || 'Laci Kas'}
                  </span>
                  <span className="font-mono-num font-semibold text-emerald-700">
                    +{formatRupiah(previewBreakdown.customerTotal)}
                  </span>
                </div>
                {isAdmin && (
                  <div className="pt-2 border-t border-slate-200 flex justify-between items-center">
                    <span className="font-semibold text-slate-800">Laba Bersih PPOB</span>
                    <span
                      className={`font-mono-num text-sm font-bold ${
                        previewBreakdown.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatRupiah(previewBreakdown.netProfit)}
                    </span>
                  </div>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={saving || activeAccounts.length === 0}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              <span>{saving ? 'Menyimpan Transaksi...' : 'Simpan Transaksi PPOB'}</span>
            </button>
          </form>
        </section>

        {/* Riwayat Transaksi PPOB */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Riwayat Transaksi PPOB
              </h3>
              <p className="text-xs text-slate-500">
                Tersinkronisasi real-time Admin &amp; Kasir. Konfirmasi SN transaksi pending atau
                batalkan transaksi gagal untuk mengembalikan saldo deposit.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari nomor HP / ID / SN..."
                  className="min-h-[40px] pl-9 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs w-44 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as 'all' | 'completed' | 'pending' | 'failed')
                }
                aria-label="Filter status transaksi PPOB"
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="all">Semua Status</option>
                <option value="completed">Sukses</option>
                <option value="pending">Pending</option>
                <option value="failed">Gagal / Refund</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : filteredTransactions.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Belum ada transaksi PPOB yang tercatat.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">No. Trx &amp; Waktu</th>
                    <th className="py-3 px-4 whitespace-nowrap">Produk &amp; Tujuan</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">
                      {isAdmin ? 'Harga / Modal' : 'Tagihan'}
                    </th>
                    {isAdmin && <th className="py-3 px-4 text-right whitespace-nowrap">Laba</th>}
                    <th className="py-3 px-4 whitespace-nowrap">Status</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredTransactions.map((tx) => {
                    const totalTagihan = Number(tx.sellPrice) + Number(tx.adminFee);
                    const isFailed = tx.status === 'failed';
                    return (
                      <tr key={tx.id} className={`hover:bg-slate-50 ${isFailed ? 'opacity-60' : ''}`}>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono-num text-xs font-semibold text-slate-900">
                            {tx.transactionNumber}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {tx.transactionDate} · {tx.transactionTime}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate max-w-[160px]">
                            Oleh: {tx.recordedByName}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-xs font-semibold text-slate-900">
                            {getPpobCategoryLabel(tx.category)} · {tx.providerName}
                          </div>
                          <div className="font-mono-num text-xs text-slate-600">
                            {tx.targetNumber}
                            {tx.customerName ? ` (${tx.customerName})` : ''}
                          </div>
                          {tx.serialNumber && (
                            <div className="font-mono-num text-[11px] text-emerald-700 truncate max-w-[200px]">
                              SN: {tx.serialNumber}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num whitespace-nowrap">
                          <div className="text-xs font-semibold text-slate-900">
                            {formatRupiah(totalTagihan)}
                          </div>
                          {isAdmin && (
                            <div className="text-[11px] text-slate-500">
                              Modal {formatRupiah(tx.capitalPrice)}
                            </div>
                          )}
                        </td>
                        {isAdmin && (
                          <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                            {formatRupiah(tx.netProfit)}
                          </td>
                        )}
                        <td className="py-3 px-4 whitespace-nowrap">
                          {tx.status === 'completed' ? (
                            <span className="inline-block px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-[11px] font-medium text-emerald-700">
                              {getPpobStatusLabel(tx.status)}
                            </span>
                          ) : tx.status === 'pending' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-[11px] font-medium text-amber-800">
                              <Clock className="w-3 h-3" />
                              <span>{getPpobStatusLabel(tx.status)}</span>
                            </span>
                          ) : (
                            <span className="inline-block px-2 py-0.5 rounded border border-red-200 bg-red-50 text-[11px] font-medium text-red-700">
                              {getPpobStatusLabel(tx.status)}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            {tx.status === 'pending' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setCompletingTx(tx);
                                  setCompletingSn(tx.serialNumber || '');
                                }}
                                className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 cursor-pointer"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>Selesaikan</span>
                              </button>
                            )}
                            {tx.status !== 'failed' && (tx.status === 'pending' || isAdmin) && (
                              <button
                                type="button"
                                disabled={actionBusyId === tx.id}
                                onClick={() => handleFailRefund(tx)}
                                className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                                title="Tandai gagal & kembalikan saldo deposit/kas"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>{actionBusyId === tx.id ? '...' : 'Refund'}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setReceiptTx(tx)}
                              className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                            >
                              <Receipt className="w-3.5 h-3.5" />
                              <span>Struk</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Modal Input SN untuk Pending PPOB */}
      {completingTx && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h4 className="font-display font-bold text-base text-slate-900">
                  Konfirmasi Transaksi PPOB Selesai
                </h4>
                <p className="text-xs text-slate-500 font-mono-num">
                  {completingTx.transactionNumber} · {completingTx.targetNumber}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCompletingTx(null)}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmCompletePending} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="complete-sn" className="block text-xs font-medium text-slate-700">
                  Nomor SN / Token PLN (Opsional)
                </label>
                <input
                  id="complete-sn"
                  type="text"
                  value={completingSn}
                  onChange={(e) => setCompletingSn(e.target.value)}
                  maxLength={100}
                  placeholder="Masukkan SN atau kode token..."
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCompletingTx(null)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={actionBusyId === completingTx.id}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60 cursor-pointer"
                >
                  {actionBusyId === completingTx.id ? 'Menyimpan...' : 'Tandai Sukses'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Struk PPOB */}
      {receiptTx && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h4 className="font-display font-bold text-base text-slate-900">
                  {storeSetting?.storeName || 'KEDAI KHANXA'}
                </h4>
                <p className="text-xs text-slate-500">Bukti Pembayaran PPOB</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setReceiptTx(null);
                  setReceiptPrintNotice(null);
                  setReceiptCopied(false);
                }}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
                aria-label="Tutup struk"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">No. Referensi</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {receiptTx.transactionNumber}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Tanggal &amp; Jam</span>
                <span className="font-mono-num text-slate-800">
                  {receiptTx.transactionDate} · {receiptTx.transactionTime}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Kategori / Produk</span>
                <span className="font-semibold text-slate-900">
                  {getPpobCategoryLabel(receiptTx.category)} · {receiptTx.providerName}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Nomor Tujuan / ID</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {receiptTx.targetNumber}
                </span>
              </div>
              {receiptTx.customerName && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Pelanggan</span>
                  <span className="text-slate-900">{receiptTx.customerName}</span>
                </div>
              )}
              {receiptTx.serialNumber && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 space-y-0.5">
                  <div className="text-[11px] text-emerald-700">Serial Number / Token</div>
                  <div className="font-mono-num text-sm font-bold text-emerald-900 break-all">
                    {receiptTx.serialNumber}
                  </div>
                </div>
              )}
              <div className="pt-2 border-t border-slate-200 flex justify-between">
                <span className="text-slate-600">Harga Produk</span>
                <span className="font-mono-num text-slate-900">
                  {formatRupiah(receiptTx.sellPrice)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Biaya Admin</span>
                <span className="font-mono-num text-slate-900">
                  {formatRupiah(receiptTx.adminFee)}
                </span>
              </div>
              <div className="flex justify-between text-sm font-bold text-emerald-700 pt-1 border-t border-slate-200">
                <span>Total Bayar</span>
                <span className="font-mono-num">
                  {formatRupiah(Number(receiptTx.sellPrice) + Number(receiptTx.adminFee))}
                </span>
              </div>
              <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500 space-y-0.5">
                <div>
                  Status: {getPpobStatusLabel(receiptTx.status)} · Deposit:{' '}
                  {accountNameMap.get(receiptTx.accountId) || receiptTx.accountId}
                  {receiptTx.cashAccountId
                    ? ` · Kas: ${accountNameMap.get(receiptTx.cashAccountId) || receiptTx.cashAccountId}`
                    : ''}
                </div>
                <div>Petugas: {receiptTx.recordedByName}</div>
              </div>
            </div>

            {storeSetting?.receiptFooter && (
              <p className="text-center text-[11px] text-slate-500 border-t border-slate-100 pt-3">
                {storeSetting.receiptFooter}
              </p>
            )}

            {receiptPrintNotice && (
              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                {receiptPrintNotice}
              </div>
            )}

            <div className="pt-2 border-t border-slate-100 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={async () => {
                  setReceiptPrintNotice(null);
                  const text = formatPpobReceiptText(receiptTx, storeSetting);
                  const outcome = await printThermalReceiptText(text, {
                    title: `Struk PPOB ${receiptTx.transactionNumber}`,
                    paperWidthMm: 58,
                  });
                  if (outcome.status !== 'printed') {
                    setReceiptPrintNotice(
                      outcome.message ||
                        'Dialog cetak diblokir di mode pratinjau/browser ini. Gunakan Unduh PDF Struk.'
                    );
                  }
                }}
                className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
              >
                <Printer className="w-4 h-4 shrink-0" />
                <span>Cetak Struk</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setReceiptPrintNotice(null);
                  downloadThermalReceiptPdf(
                    formatPpobReceiptText(receiptTx, storeSetting),
                    `Struk_PPOB_${receiptTx.transactionNumber}`,
                    58
                  );
                }}
                className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
              >
                <Download className="w-4 h-4 shrink-0" />
                <span>Unduh PDF</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const text = formatPpobReceiptText(receiptTx, storeSetting);
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                  }
                  setReceiptCopied(true);
                  window.setTimeout(() => setReceiptCopied(false), 2000);
                }}
                className="min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5 shrink-0" />
                <span>{receiptCopied ? 'Tersalin!' : 'Salin Struk'}</span>
              </button>
              <a
                href={buildRawBtThermalUrl(formatPpobReceiptText(receiptTx, storeSetting))}
                className="min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50"
              >
                <Share2 className="w-3.5 h-3.5 shrink-0" />
                <span>Printer BT (RawBT)</span>
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
