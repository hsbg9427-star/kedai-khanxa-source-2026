import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Calculator,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Eye,
  Lock,
  RefreshCw,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type {
  Account,
  CashierClosing,
  CashierClosingReviewStatus,
} from '../types/database';
import {
  computeLiveClosingBreakdown,
  fetchKasirClosingSourceData,
  finalizeCashierClosing,
  reviewCashierClosing,
  subscribeCashierClosings,
  type ClosingSourceSnapshot,
} from '../services/closingService';
import {
  evaluateClosingVariance,
  getClosingStatusLabel,
} from '../utils/cashierClosing';
import { formatRupiah, getTodayDateString } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';

interface ClosingKasirPageProps {
  accounts: Account[];
}

function getStatusBadgeClass(status: CashierClosing['status']): string {
  switch (status) {
    case 'balance':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'short':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'over':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

function getReviewBadgeMeta(reviewStatus: CashierClosingReviewStatus): {
  label: string;
  className: string;
} {
  switch (reviewStatus) {
    case 'verified':
      return {
        label: 'Terverifikasi Admin',
        className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      };
    case 'flagged':
      return {
        label: 'Perlu Catatan Admin',
        className: 'bg-amber-50 text-amber-800 border-amber-200',
      };
    default:
      return {
        label: 'Menunggu Pemeriksaan',
        className: 'bg-slate-100 text-slate-600 border-slate-200',
      };
  }
}

export function ClosingKasirPage({ accounts }: ClosingKasirPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [subTab, setSubTab] = useState<'form' | 'history'>('form');
  const [closings, setClosings] = useState<CashierClosing[]>([]);
  const [closingsLoading, setClosingsLoading] = useState(true);
  const [hasPendingWrites, setHasPendingWrites] = useState(false);

  // Periode & Hitungan Shift Kasir
  const today = getTodayDateString();
  const [periodStartDate, setPeriodStartDate] = useState(today);
  const [periodEndDate, setPeriodEndDate] = useState(today);
  const [shiftLabel, setShiftLabel] = useState(profile?.shiftLabel || 'Shift Reguler');
  const [openingCash, setOpeningCash] = useState('0');
  const [actualCash, setActualCash] = useState('');
  const [notes, setNotes] = useState('');

  const [sourceSnapshot, setSourceSnapshot] = useState<ClosingSourceSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [savingClosing, setSavingClosing] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const submitLockRef = useRef(false);

  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Filter Riwayat (terutama untuk Admin)
  const [cashierFilter, setCashierFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [reviewFilter, setReviewFilter] = useState<string>('all');

  // Detail & Pemeriksaan Admin
  const [detailClosing, setDetailClosing] = useState<CashierClosing | null>(null);
  const [reviewTarget, setReviewTarget] = useState<CashierClosing | null>(null);
  const [reviewDecision, setReviewDecision] = useState<CashierClosingReviewStatus>('verified');
  const [reviewNoteInput, setReviewNoteInput] = useState('');
  const [savingReview, setSavingReview] = useState(false);

  useEffect(() => {
    if (profile?.shiftLabel && shiftLabel === 'Shift Reguler') {
      setShiftLabel(profile.shiftLabel);
    }
  }, [profile?.shiftLabel]);

  // Langganan riwayat closing (Kasir hanya miliknya, Admin seluruh kasir)
  useEffect(() => {
    if (!user) return;
    setClosingsLoading(true);
    const unsub = subscribeCashierClosings(
      isAdmin,
      user.uid,
      (rows, pending) => {
        setClosings(rows);
        setHasPendingWrites(pending);
        setClosingsLoading(false);
      },
      (err) => {
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
        setClosingsLoading(false);
      }
    );
    return () => unsub();
  }, [user, isAdmin]);

  const loadClosingSources = useCallback(async () => {
    if (!user) return;
    setLoadingSnapshot(true);
    try {
      const snap = await fetchKasirClosingSourceData(user.uid);
      setSourceSnapshot(snap);
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setLoadingSnapshot(false);
    }
  }, [user]);

  useEffect(() => {
    loadClosingSources();
  }, [loadClosingSources]);

  const breakdown = useMemo(() => {
    if (!user || !sourceSnapshot) return null;
    return computeLiveClosingBreakdown(
      sourceSnapshot,
      accounts,
      user.uid,
      periodStartDate,
      periodEndDate,
      Math.max(0, Number(openingCash) || 0)
    );
  }, [user, sourceSnapshot, accounts, periodStartDate, periodEndDate, openingCash]);

  const parsedActualCash = actualCash.trim() === '' ? NaN : Math.max(0, Number(actualCash));
  const liveVariance = useMemo(() => {
    if (!breakdown || !Number.isFinite(parsedActualCash)) return null;
    return evaluateClosingVariance(breakdown.expectedCash, parsedActualCash);
  }, [breakdown, parsedActualCash]);

  const cashierOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of closings) {
      if (c.recordedByUid && !map.has(c.recordedByUid)) {
        map.set(c.recordedByUid, c.recordedByName || 'Kasir');
      }
    }
    return Array.from(map.entries()).map(([uid, name]) => ({ uid, name }));
  }, [closings]);

  const filteredClosings = useMemo(() => {
    return closings.filter((c) => {
      if (isAdmin && cashierFilter !== 'all' && c.recordedByUid !== cashierFilter) return false;
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (reviewFilter !== 'all' && c.reviewStatus !== reviewFilter) return false;
      return true;
    });
  }, [closings, isAdmin, cashierFilter, statusFilter, reviewFilter]);

  const handleRequestFinalize = (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    if (!breakdown || !user) {
      setFeedback({ kind: 'err', text: 'Data transaksi shift belum siap. Klik Muat Ulang Hitungan.' });
      return;
    }
    if (!periodStartDate || !periodEndDate || periodStartDate > periodEndDate) {
      setFeedback({ kind: 'err', text: 'Rentang tanggal periode closing tidak valid.' });
      return;
    }
    if (!Number.isFinite(parsedActualCash) || parsedActualCash < 0) {
      setFeedback({
        kind: 'err',
        text: 'Masukkan jumlah uang fisik yang benar-benar dihitung di laci kasir.',
      });
      return;
    }
    const check = evaluateClosingVariance(breakdown.expectedCash, parsedActualCash);
    if (check.status !== 'balance' && !notes.trim()) {
      setFeedback({
        kind: 'err',
        text: `Terdapat selisih (${check.statusLabel}). Isi catatan penjelasan selisih sebelum finalisasi.`,
      });
      return;
    }
    setShowConfirmModal(true);
  };

  const handleConfirmFinalize = async () => {
    if (!user || !breakdown || !Number.isFinite(parsedActualCash) || submitLockRef.current) return;
    submitLockRef.current = true;
    setSavingClosing(true);
    setFeedback(null);
    try {
      const result = await finalizeCashierClosing(
        {
          shiftLabel,
          periodStartDate,
          periodEndDate,
          openingCash: Math.max(0, Number(openingCash) || 0),
          actualCash: parsedActualCash,
          notes,
          breakdown,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Kasir',
        }
      );

      setShowConfirmModal(false);
      setActualCash('');
      setNotes('');
      setSubTab('history');
      setFeedback({
        kind: 'ok',
        text: `Closing Kasir ${result.transactionNumber} berhasil difinalisasi dengan status ${getClosingStatusLabel(
          result.closing.status
        )}.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
      setShowConfirmModal(false);
    } finally {
      setSavingClosing(false);
      submitLockRef.current = false;
    }
  };

  const handleOpenAdminReview = (c: CashierClosing) => {
    if (!isAdmin) return;
    setReviewTarget(c);
    setReviewDecision(c.reviewStatus === 'flagged' ? 'flagged' : 'verified');
    setReviewNoteInput(c.reviewNote || '');
  };

  const handleSaveAdminReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin || !reviewTarget) return;
    setSavingReview(true);
    setFeedback(null);
    try {
      await reviewCashierClosing(
        reviewTarget.id,
        {
          reviewStatus: reviewDecision,
          reviewNote: reviewNoteInput,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
          isAdmin: true,
        }
      );
      setReviewTarget(null);
      setFeedback({
        kind: 'ok',
        text: `Pemeriksaan closing ${reviewTarget.transactionNumber} berhasil disimpan.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSavingReview(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Calculator className="w-5 h-5 text-emerald-700" />
            <h2 className="font-display font-bold text-lg text-slate-900">
              Closing Kasir &amp; Hitung Uang Fisik
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            Cocokkan arus uang tunai laci kasir (terpisah dari QRIS, Transfer Bank, dan Piutang).
            Closing yang sudah difinalisasi bersifat permanen dan diperiksa oleh Admin.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!isOnline && (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 font-medium">
              <WifiOff className="w-3.5 h-3.5" />
              <span>Offline</span>
            </span>
          )}
          {hasPendingWrites && (
            <span className="text-xs text-amber-700 font-medium">Menyinkronkan...</span>
          )}
          <div className="inline-flex rounded-lg border border-slate-200 p-1 bg-slate-50 text-xs">
            <button
              type="button"
              onClick={() => setSubTab('form')}
              className={`min-h-[36px] px-3 py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
                subTab === 'form'
                  ? 'bg-white text-emerald-800 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Closing &amp; Hitung Fisik
            </button>
            <button
              type="button"
              onClick={() => setSubTab('history')}
              className={`min-h-[36px] px-3 py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
                subTab === 'history'
                  ? 'bg-white text-emerald-800 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {isAdmin ? `Semua Riwayat (${closings.length})` : `Riwayat Saya (${closings.length})`}
            </button>
          </div>
        </div>
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
            aria-label="Tutup"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {subTab === 'form' ? (
        <div className="space-y-5">
          {/* Filter Periode Shift */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display font-semibold text-sm sm:text-base text-slate-900">
                  1. Periode Shift &amp; Petugas
                </h3>
                <p className="text-xs text-slate-500">
                  Menghitung transaksi yang dicatat oleh{' '}
                  <strong className="text-slate-800">
                    {profile?.displayName || user?.displayName || 'Kasir'}
                  </strong>
                  .
                </p>
              </div>
              <button
                type="button"
                disabled={loadingSnapshot}
                onClick={loadClosingSources}
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingSnapshot ? 'animate-spin' : ''}`} />
                <span>{loadingSnapshot ? 'Menghitung...' : 'Muat Ulang Hitungan'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label htmlFor="cls-start" className="block text-xs font-medium text-slate-700">
                  Dari Tanggal
                </label>
                <input
                  id="cls-start"
                  type="date"
                  value={periodStartDate}
                  onChange={(e) => setPeriodStartDate(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="cls-end" className="block text-xs font-medium text-slate-700">
                  Sampai Tanggal
                </label>
                <input
                  id="cls-end"
                  type="date"
                  value={periodEndDate}
                  onChange={(e) => setPeriodEndDate(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="cls-shift" className="block text-xs font-medium text-slate-700">
                  Label Shift
                </label>
                <input
                  id="cls-shift"
                  type="text"
                  maxLength={60}
                  value={shiftLabel}
                  onChange={(e) => setShiftLabel(e.target.value)}
                  placeholder="Contoh: Shift Pagi / Shift Sore"
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="cls-opening" className="block text-xs font-medium text-slate-700">
                  Modal Awal Laci Kas (Rp)
                </label>
                <input
                  id="cls-opening"
                  type="number"
                  min="0"
                  value={openingCash}
                  onChange={(e) => setOpeningCash(e.target.value)}
                  placeholder="0"
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>
          </div>

          {!breakdown ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
              Memuat rincian transaksi shift kasir...
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Rincian Arus Tunai vs Non-Tunai */}
              <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
                <div className="space-y-1">
                  <h3 className="font-display font-semibold text-base text-slate-900">
                    2. Pemisahan Transaksi Tunai vs Non-Tunai
                  </h3>
                  <p className="text-xs text-slate-500">
                    Total penjualan TIDAK disamakan dengan uang tunai. Transaksi QRIS, Transfer Bank/DANA,
                    dan Kasbon dipisahkan agar uang fisik di laci akurat.
                  </p>
                </div>

                {/* Penjualan Retail */}
                <div className="rounded-lg border border-slate-200 p-4 space-y-2.5 text-xs sm:text-sm">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="font-semibold text-slate-900">
                      Penjualan Retail ({breakdown.retailTxCount} trx)
                    </span>
                    <span className="font-mono-num font-bold text-slate-900">
                      Total Omzet: {formatRupiah(breakdown.totalSalesAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span>• Pembayaran Tunai Masuk Laci (termasuk DP &amp; bagian tunai campuran)</span>
                    <span className="font-mono-num font-semibold">
                      +{formatRupiah(breakdown.retailCashIn)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>• Pembayaran Non-Tunai QRIS (tidak masuk laci)</span>
                    <span className="font-mono-num">{formatRupiah(breakdown.retailQrisTotal)}</span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>• Pembayaran Non-Tunai Transfer Bank / DANA</span>
                    <span className="font-mono-num">{formatRupiah(breakdown.retailTransferTotal)}</span>
                  </div>
                  {breakdown.retailDebtCreatedTotal > 0 && (
                    <div className="flex justify-between text-amber-700">
                      <span>• Sisa Penjualan Masuk Kasbon / Piutang</span>
                      <span className="font-mono-num">
                        {formatRupiah(breakdown.retailDebtCreatedTotal)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Mini ATM */}
                <div className="rounded-lg border border-slate-200 p-4 space-y-2 text-xs sm:text-sm">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="font-semibold text-slate-900">
                      Layanan Mini ATM ({breakdown.miniAtmTxCount} trx)
                    </span>
                    <span className="font-mono-num text-xs text-slate-500">
                      Mutasi Rekening/QRIS: {formatRupiah(breakdown.miniAtmNonCashTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span>• Tunai Masuk Laci (Transfer Bank &amp; Jasa)</span>
                    <span className="font-mono-num font-semibold">
                      +{formatRupiah(breakdown.miniAtmCashIn)}
                    </span>
                  </div>
                  <div className="flex justify-between text-red-700">
                    <span>• Tunai Keluar Laci (Penyerahan Tarik Tunai ke Pelanggan)</span>
                    <span className="font-mono-num font-semibold">
                      -{formatRupiah(breakdown.miniAtmCashOut)}
                    </span>
                  </div>
                </div>

                {/* PPOB & Piutang */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs sm:text-sm">
                  <div className="rounded-lg border border-slate-200 p-3.5 space-y-2">
                    <div className="font-semibold text-slate-900 border-b border-slate-100 pb-1.5">
                      PPOB ({breakdown.ppobTxCount} trx)
                    </div>
                    <div className="flex justify-between text-emerald-700">
                      <span>Bayar Tunai Masuk</span>
                      <span className="font-mono-num font-semibold">
                        +{formatRupiah(breakdown.ppobCashIn)}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-500 text-xs">
                      <span>Bayar Non-Tunai</span>
                      <span className="font-mono-num">{formatRupiah(breakdown.ppobNonCashTotal)}</span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 p-3.5 space-y-2">
                    <div className="font-semibold text-slate-900 border-b border-slate-100 pb-1.5">
                      Pembayaran Piutang ({breakdown.receivablePaymentCount} trx)
                    </div>
                    <div className="flex justify-between text-emerald-700">
                      <span>Pelunasan Tunai Masuk</span>
                      <span className="font-mono-num font-semibold">
                        +{formatRupiah(breakdown.receivableCashIn)}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-500 text-xs">
                      <span>Pelunasan Transfer</span>
                      <span className="font-mono-num">
                        {formatRupiah(breakdown.receivableNonCashIn)}
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Form Input Uang Fisik & Finalisasi */}
              <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <h3 className="font-display font-semibold text-base text-slate-900">
                  3. Hitung Uang Fisik &amp; Finalisasi
                </h3>

                <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-2">
                  <div className="text-xs font-medium text-emerald-800">
                    Uang Fisik yang Seharusnya Tersedia di Laci
                  </div>
                  <div className="font-mono-num text-2xl font-bold text-emerald-900">
                    {formatRupiah(breakdown.expectedCash)}
                  </div>
                  <div className="text-[11px] font-mono-num text-emerald-800 space-y-0.5 pt-1 border-t border-emerald-200/70">
                    <div className="flex justify-between">
                      <span>Modal Awal Shift</span>
                      <span>{formatRupiah(breakdown.openingCash)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Total Tunai Masuk</span>
                      <span>+{formatRupiah(breakdown.totalCashIn)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Total Tunai Keluar (Tarik Tunai)</span>
                      <span>-{formatRupiah(breakdown.totalCashOut)}</span>
                    </div>
                  </div>
                </div>

                <form onSubmit={handleRequestFinalize} className="space-y-4">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="cls-actual-cash"
                      className="block text-xs font-semibold text-slate-800"
                    >
                      Jumlah Uang Fisik yang Dihitung (Rp) *
                    </label>
                    <input
                      id="cls-actual-cash"
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={actualCash}
                      onChange={(e) => setActualCash(e.target.value)}
                      placeholder="Masukkan total uang tunai fisik di laci"
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-lg border border-slate-300 text-base font-mono-num font-bold focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>

                  {liveVariance && (
                    <div
                      className={`rounded-lg border p-3.5 space-y-1.5 ${getStatusBadgeClass(
                        liveVariance.status
                      )}`}
                    >
                      <div className="flex items-center justify-between text-xs font-semibold">
                        <span>Status Rekonsiliasi</span>
                        <span className="uppercase">{liveVariance.statusLabel}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm font-mono-num font-bold">
                        <span>Selisih (Fisik - Seharusnya)</span>
                        <span>
                          {liveVariance.varianceAmount > 0 ? '+' : ''}
                          {formatRupiah(liveVariance.varianceAmount)}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label htmlFor="cls-notes" className="block text-xs font-medium text-slate-700">
                      Catatan Selisih / Keterangan Shift{' '}
                      {liveVariance && liveVariance.status !== 'balance' ? '*' : '(Opsional)'}
                    </label>
                    <textarea
                      id="cls-notes"
                      rows={3}
                      maxLength={300}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder={
                        liveVariance && liveVariance.status !== 'balance'
                          ? 'Jelaskan penyebab selisih uang fisik (wajib diisi jika selisih)...'
                          : 'Catatan kondisi laci kasir atau pergantian shift...'
                      }
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>

                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-[11px] text-slate-600 flex items-start gap-2">
                    <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-500" />
                    <span>
                      Setelah difinalisasi, data closing tidak dapat diubah atau dihapus oleh Kasir.
                      Pastikan hitungan uang fisik sudah benar.
                    </span>
                  </div>

                  <button
                    type="submit"
                    disabled={savingClosing || loadingSnapshot}
                    className="w-full min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                  >
                    <ClipboardCheck className="w-4 h-4" />
                    <span>Finalisasi Closing Kasir</span>
                  </button>
                </form>
              </section>
            </div>
          )}
        </div>
      ) : (
        /* Tab Riwayat Closing Kasir */
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                {isAdmin ? 'Seluruh Riwayat Closing Kasir' : 'Riwayat Closing Saya'}
              </h3>
              <p className="text-xs text-slate-500">
                {isAdmin
                  ? 'Periksa laporan closing seluruh kasir, verifikasi uang fisik, dan berikan catatan audit.'
                  : 'Riwayat closing yang sudah Anda finalisasi. Bersifat permanen (read-only).'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && (
                <select
                  value={cashierFilter}
                  onChange={(e) => setCashierFilter(e.target.value)}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                  aria-label="Filter Kasir"
                >
                  <option value="all">Semua Kasir</option>
                  {cashierOptions.map((c) => (
                    <option key={c.uid} value={c.uid}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                aria-label="Filter Status Selisih"
              >
                <option value="all">Semua Status Uang</option>
                <option value="balance">Sesuai / Balance</option>
                <option value="short">Kurang / Short</option>
                <option value="over">Lebih / Over</option>
              </select>
              <select
                value={reviewFilter}
                onChange={(e) => setReviewFilter(e.target.value)}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                aria-label="Filter Status Pemeriksaan"
              >
                <option value="all">Semua Pemeriksaan</option>
                <option value="pending">Menunggu Pemeriksaan</option>
                <option value="verified">Terverifikasi Admin</option>
                <option value="flagged">Perlu Catatan Admin</option>
              </select>
            </div>
          </div>

          {closingsLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : filteredClosings.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Belum ada data closing kasir yang tersimpan.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; No. Closing</th>
                    <th className="py-3 px-4 whitespace-nowrap">Kasir &amp; Shift</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Total Penjualan</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Uang Diharapkan</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Uang Fisik</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Selisih &amp; Status</th>
                    <th className="py-3 px-4 whitespace-nowrap">Pemeriksaan Admin</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredClosings.map((c) => {
                    const reviewMeta = getReviewBadgeMeta(c.reviewStatus);
                    return (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono-num text-xs font-semibold text-slate-900">
                            {c.transactionNumber}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {c.transactionDate} · {c.transactionTime}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono-num">
                            Periode: {c.periodStartDate}
                            {c.periodEndDate !== c.periodStartDate ? ` s.d ${c.periodEndDate}` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="text-xs font-semibold text-slate-900">
                            {c.recordedByName}
                          </div>
                          {c.shiftLabel && (
                            <div className="text-[11px] text-slate-500">{c.shiftLabel}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-slate-900 whitespace-nowrap">
                          {formatRupiah(c.totalSalesAmount)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-slate-700 whitespace-nowrap">
                          {formatRupiah(c.expectedCash)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                          {formatRupiah(c.actualCash)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="font-mono-num text-xs font-bold text-slate-900">
                            {c.varianceAmount > 0 ? '+' : ''}
                            {formatRupiah(c.varianceAmount)}
                          </div>
                          <span
                            className={`inline-block mt-0.5 px-2 py-0.5 rounded border text-[10px] font-semibold ${getStatusBadgeClass(
                              c.status
                            )}`}
                          >
                            {getClosingStatusLabel(c.status)}
                          </span>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${reviewMeta.className}`}
                          >
                            {c.reviewStatus === 'verified' ? (
                              <ShieldCheck className="w-3 h-3" />
                            ) : (
                              <Clock className="w-3 h-3" />
                            )}
                            <span>{reviewMeta.label}</span>
                          </span>
                          {c.reviewedByName && (
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              Oleh {c.reviewedByName}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setDetailClosing(c)}
                              className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Detail</span>
                            </button>
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => handleOpenAdminReview(c)}
                                className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 cursor-pointer"
                              >
                                <ShieldCheck className="w-3.5 h-3.5" />
                                <span>Periksa</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modal Konfirmasi Finalisasi */}
      {showConfirmModal && breakdown && liveVariance && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-display font-bold text-base text-slate-900">
                Konfirmasi Finalisasi Closing Kasir
              </h3>
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 text-xs sm:text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Periode / Shift</span>
                <span className="font-semibold text-slate-900">
                  {periodStartDate}
                  {periodEndDate !== periodStartDate ? ` - ${periodEndDate}` : ''}
                  {shiftLabel ? ` (${shiftLabel})` : ''}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Total Penjualan Retail</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {formatRupiah(breakdown.totalSalesAmount)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Uang Tunai Seharusnya</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {formatRupiah(liveVariance.expectedCash)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Uang Fisik Terhitung</span>
                <span className="font-mono-num font-bold text-slate-900">
                  {formatRupiah(liveVariance.actualCash)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-2">
                <span className="font-semibold text-slate-800">Selisih</span>
                <span className="font-mono-num font-bold">
                  {liveVariance.varianceAmount > 0 ? '+' : ''}
                  {formatRupiah(liveVariance.varianceAmount)} ({liveVariance.statusLabel})
                </span>
              </div>
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              Closing yang sudah difinalisasi <strong>tidak dapat diubah atau dihapus</strong> oleh
              Kasir dan akan masuk ke daftar pemeriksaan Admin.
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={savingClosing}
                onClick={handleConfirmFinalize}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {savingClosing ? 'Menyimpan...' : 'Ya, Finalisasi Permanen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Detail Closing */}
      {detailClosing && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-bold text-base text-slate-900">
                  Detail Closing {detailClosing.transactionNumber}
                </h3>
                <p className="text-xs text-slate-500 font-mono-num">
                  {detailClosing.recordedByName} · {detailClosing.transactionDate}{' '}
                  {detailClosing.transactionTime}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailClosing(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs sm:text-sm">
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-600">Periode / Shift</span>
                  <span className="font-medium text-slate-900">
                    {detailClosing.periodStartDate} s.d {detailClosing.periodEndDate}
                    {detailClosing.shiftLabel ? ` · ${detailClosing.shiftLabel}` : ''}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Total Penjualan Retail</span>
                  <span className="font-mono-num font-semibold text-slate-900">
                    {formatRupiah(detailClosing.totalSalesAmount)} ({detailClosing.retailTxCount} trx)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Retail Non-Tunai (QRIS / Transfer)</span>
                  <span className="font-mono-num text-slate-700">
                    {formatRupiah(detailClosing.retailQrisTotal + detailClosing.retailTransferTotal)}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-3 space-y-1.5">
                <div className="font-semibold text-slate-800">Rincian Arus Tunai Laci</div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Modal Awal Shift</span>
                  <span className="font-mono-num">{formatRupiah(detailClosing.openingCash)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>Retail Tunai Masuk</span>
                  <span className="font-mono-num">+{formatRupiah(detailClosing.retailCashIn)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>Mini ATM Tunai Masuk</span>
                  <span className="font-mono-num">+{formatRupiah(detailClosing.miniAtmCashIn)}</span>
                </div>
                <div className="flex justify-between text-red-700">
                  <span>Mini ATM Tunai Keluar</span>
                  <span className="font-mono-num">-{formatRupiah(detailClosing.miniAtmCashOut)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>PPOB Tunai Masuk</span>
                  <span className="font-mono-num">+{formatRupiah(detailClosing.ppobCashIn)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>Pelunasan Piutang Tunai</span>
                  <span className="font-mono-num">+{formatRupiah(detailClosing.receivableCashIn)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5 font-semibold">
                  <span>Uang Seharusnya (Expected)</span>
                  <span className="font-mono-num">{formatRupiah(detailClosing.expectedCash)}</span>
                </div>
                <div className="flex justify-between font-bold text-slate-900">
                  <span>Uang Fisik Terhitung</span>
                  <span className="font-mono-num">{formatRupiah(detailClosing.actualCash)}</span>
                </div>
                <div className="flex justify-between font-bold">
                  <span>Selisih ({getClosingStatusLabel(detailClosing.status)})</span>
                  <span className="font-mono-num">
                    {detailClosing.varianceAmount > 0 ? '+' : ''}
                    {formatRupiah(detailClosing.varianceAmount)}
                  </span>
                </div>
              </div>

              {detailClosing.notes && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                  <div className="font-semibold">Catatan Kasir:</div>
                  <div>{detailClosing.notes}</div>
                </div>
              )}

              {detailClosing.reviewNote && (
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700">
                  <div className="font-semibold">
                    Catatan Pemeriksaan Admin ({detailClosing.reviewedByName || 'Admin'}):
                  </div>
                  <div>{detailClosing.reviewNote}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Pemeriksaan Admin */}
      {reviewTarget && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveAdminReview}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-display font-bold text-base text-slate-900">
                Pemeriksaan Admin · {reviewTarget.transactionNumber}
              </h3>
              <button
                type="button"
                onClick={() => setReviewTarget(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
              <div>
                Kasir: <strong>{reviewTarget.recordedByName}</strong>
              </div>
              <div className="font-mono-num">
                Diharapkan: {formatRupiah(reviewTarget.expectedCash)} · Fisik:{' '}
                {formatRupiah(reviewTarget.actualCash)} · Selisih:{' '}
                <strong>
                  {reviewTarget.varianceAmount > 0 ? '+' : ''}
                  {formatRupiah(reviewTarget.varianceAmount)}
                </strong>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="adm-rev-status" className="block text-xs font-medium text-slate-700">
                Status Pemeriksaan
              </label>
              <select
                id="adm-rev-status"
                value={reviewDecision}
                onChange={(e) => setReviewDecision(e.target.value as CashierClosingReviewStatus)}
                className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
              >
                <option value="verified">Terverifikasi / Diterima</option>
                <option value="flagged">Perlu Tindak Lanjut / Selisih</option>
                <option value="pending">Menunggu Pemeriksaan</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="adm-rev-note" className="block text-xs font-medium text-slate-700">
                Catatan Pemeriksaan Admin (Opsional)
              </label>
              <textarea
                id="adm-rev-note"
                rows={3}
                maxLength={300}
                value={reviewNoteInput}
                onChange={(e) => setReviewNoteInput(e.target.value)}
                placeholder="Catatan hasil pengecekan fisik / serah terima kas..."
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setReviewTarget(null)}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={savingReview}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {savingReview ? 'Menyimpan...' : 'Simpan Pemeriksaan'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
