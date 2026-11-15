import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  HandCoins,
  Search,
  CalendarClock,
  Check,
  X,
  History,
  FileBarChart2,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type { Account, Loan, LoanPayment } from '../types/database';
import {
  createLoanDisbursement,
  recordLoanInstallment,
  subscribeLoanPayments,
  subscribeLoans,
} from '../services/loanService';
import {
  formatIndonesianDate,
  formatRupiah,
  getAccountTypeLabel,
  getTodayDateString,
} from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import { getLoanDisplayStatus, type LoanDisplayStatus } from '../utils/qrisFee';
import { roundMoney } from '../utils/unitConversion';

interface LoansPageProps {
  accounts: Account[];
}

type LoanTab = 'loans' | 'payments' | 'summary';
type StatusFilter = 'all' | 'active' | 'Belum Bayar' | 'Cicilan' | 'Terlambat' | 'Lunas';

function addDays(dateStr: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  base.setDate(base.getDate() + days);
  return getTodayDateString(base);
}

function getStatusBadgeClass(status: LoanDisplayStatus): string {
  switch (status) {
    case 'Lunas':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'Terlambat':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'Cicilan':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

export function LoansPage({ accounts }: LoansPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [payments, setPayments] = useState<LoanPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasPendingWrites, setHasPendingWrites] = useState(false);

  const [subTab, setSubTab] = useState<LoanTab>('loans');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Form Pinjaman Baru
  const [showNewModal, setShowNewModal] = useState(false);
  const [borrowerName, setBorrowerName] = useState('');
  const [borrowerPhone, setBorrowerPhone] = useState('');
  const [principalAmount, setPrincipalAmount] = useState('');
  const [loanDate, setLoanDate] = useState(getTodayDateString());
  const [dueDate, setDueDate] = useState(addDays(getTodayDateString(), 30));
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [loanNotes, setLoanNotes] = useState('');
  const [savingLoan, setSavingLoan] = useState(false);

  // Modal Cicilan / Pelunasan
  const [payingLoan, setPayingLoan] = useState<Loan | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [destAccountId, setDestAccountId] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [savingPay, setSavingPay] = useState(false);

  const submitLockRef = useRef(false);

  const activeAccounts = accounts.filter((a) => a.isActive);
  const fundingAccounts = activeAccounts.filter((a) => a.type !== 'ppob_deposit');
  const selectableAccounts = fundingAccounts.length > 0 ? fundingAccounts : activeAccounts;

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubLoans = subscribeLoans(
      (list, pending) => {
        setLoans(list);
        setHasPendingWrites(pending);
        setLoading(false);
      },
      () => setLoading(false)
    );
    const unsubPayments = subscribeLoanPayments(
      (list) => setPayments(list),
      () => {}
    );
    return () => {
      unsubLoans();
      unsubPayments();
    };
  }, [isAdmin]);

  useEffect(() => {
    if (selectableAccounts.length > 0) {
      if (!sourceAccountId) {
        const cash = selectableAccounts.find((a) => a.type === 'cash') || selectableAccounts[0];
        if (cash) setSourceAccountId(cash.id);
      }
      if (!destAccountId) {
        const cash = selectableAccounts.find((a) => a.type === 'cash') || selectableAccounts[0];
        if (cash) setDestAccountId(cash.id);
      }
    }
  }, [selectableAccounts, sourceAccountId, destAccountId]);

  if (!isAdmin) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>
          Akses ditolak. Modul Pinjaman Uang Pelanggan hanya dapat diakses oleh Admin KEDAI KHANXA.
        </span>
      </div>
    );
  }

  const todayStr = getTodayDateString();

  const totalPrincipal = roundMoney(
    loans.reduce((sum, l) => sum + (Number(l.principalAmount) || 0), 0)
  );
  const totalPaid = roundMoney(loans.reduce((sum, l) => sum + (Number(l.paidAmount) || 0), 0));
  const totalRemaining = roundMoney(
    loans.reduce((sum, l) => sum + Math.max(0, Number(l.remainingAmount) || 0), 0)
  );
  const overdueLoans = loans.filter((l) => getLoanDisplayStatus(l, todayStr) === 'Terlambat');
  const activeLoansCount = loans.filter((l) => Number(l.remainingAmount) > 0).length;

  const filteredLoans = loans.filter((l) => {
    const displayStatus = getLoanDisplayStatus(l, todayStr);
    if (statusFilter === 'active' && displayStatus === 'Lunas') return false;
    if (
      statusFilter !== 'all' &&
      statusFilter !== 'active' &&
      displayStatus !== statusFilter
    ) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        l.borrowerName.toLowerCase().includes(q) ||
        l.transactionNumber.toLowerCase().includes(q) ||
        (l.borrowerPhone || '').toLowerCase().includes(q) ||
        l.sourceAccountName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const openNewLoanModal = () => {
    const today = getTodayDateString();
    setBorrowerName('');
    setBorrowerPhone('');
    setPrincipalAmount('');
    setLoanDate(today);
    setDueDate(addDays(today, 30));
    setLoanNotes('');
    setFeedback(null);
    setShowNewModal(true);
  };

  const handleCreateLoan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || submitLockRef.current) return;

    const selectedSource = selectableAccounts.find((a) => a.id === sourceAccountId);
    if (!selectedSource) {
      setFeedback({ kind: 'err', text: 'Pilih sumber dana pinjaman (Laci Kas / DANA / Bank).' });
      return;
    }

    submitLockRef.current = true;
    setSavingLoan(true);
    setFeedback(null);

    try {
      const res = await createLoanDisbursement(
        {
          borrowerName,
          borrowerPhone,
          principalAmount: Number(principalAmount),
          loanDate,
          dueDate,
          sourceAccount: selectedSource,
          notes: loanNotes,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        }
      );

      setShowNewModal(false);
      setFeedback({
        kind: 'ok',
        text: isOnline
          ? `Pinjaman ${res.transactionNumber} a.n. ${borrowerName.trim()} dicatat. Saldo ${
              selectedSource.name
            } berkurang otomatis.`
          : `Pinjaman ${res.transactionNumber} disimpan lokal (offline) dan saldo langsung diperbarui.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSavingLoan(false);
      submitLockRef.current = false;
    }
  };

  const openPayModal = (loan: Loan) => {
    setPayingLoan(loan);
    setPayAmount(String(loan.remainingAmount));
    setPayNotes('');
    setFeedback(null);
    const preferred =
      selectableAccounts.find((a) => a.id === loan.sourceAccountId) ||
      selectableAccounts.find((a) => a.type === 'cash') ||
      selectableAccounts[0];
    if (preferred) setDestAccountId(preferred.id);
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !payingLoan || submitLockRef.current) return;

    const destAcc = selectableAccounts.find((a) => a.id === destAccountId);
    if (!destAcc) {
      setFeedback({ kind: 'err', text: 'Pilih kas atau rekening tujuan penerimaan cicilan.' });
      return;
    }

    const numericAmount = roundMoney(Number(payAmount) || 0);
    if (numericAmount <= 0) {
      setFeedback({ kind: 'err', text: 'Nominal pembayaran harus lebih dari Rp0.' });
      return;
    }
    if (numericAmount > payingLoan.remainingAmount) {
      setFeedback({
        kind: 'err',
        text: `Pembayaran tidak boleh melebihi sisa pinjaman (${formatRupiah(
          payingLoan.remainingAmount
        )}).`,
      });
      return;
    }

    submitLockRef.current = true;
    setSavingPay(true);
    setFeedback(null);

    try {
      const res = await recordLoanInstallment(
        {
          loan: payingLoan,
          amount: numericAmount,
          destinationAccount: destAcc,
          notes: payNotes,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        }
      );

      setPayingLoan(null);
      setFeedback({
        kind: 'ok',
        text: `${res.remainingAfter === 0 ? 'Pelunasan' : 'Cicilan'} ${
          res.transactionNumber
        } diterima ke ${destAcc.name}. Sisa pinjaman: ${formatRupiah(res.remainingAfter)}.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSavingPay(false);
      submitLockRef.current = false;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Aksi Utama */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="font-display font-bold text-lg text-slate-900">
              Pinjaman Uang &amp; Piutang Pinjaman
            </h2>
            {hasPendingWrites && (
              <span className="text-xs font-medium text-amber-700">· Menunggu sinkronisasi</span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Khusus Admin. Pokok pinjaman &amp; cicilan memengaruhi saldo kas/rekening dan piutang,
            bukan omzet penjualan atau biaya operasional.
          </p>
        </div>

        <button
          type="button"
          onClick={openNewLoanModal}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Catat Pinjaman Baru</span>
        </button>
      </div>

      {feedback && (
        <div
          className={`p-4 rounded-xl border text-sm ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* KPI Ringkas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Total Pinjaman Diberikan</div>
          <div className="font-mono-num text-xl font-bold text-slate-900">
            {formatRupiah(totalPrincipal)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">{loans.length} catatan pinjaman</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Total Cicilan Diterima</div>
          <div className="font-mono-num text-xl font-bold text-emerald-700">
            {formatRupiah(totalPaid)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">{payments.length} kali pembayaran</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Total Piutang Belum Lunas</div>
          <div className="font-mono-num text-xl font-bold text-amber-700">
            {formatRupiah(totalRemaining)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">
            {activeLoansCount} peminjam masih berjalan
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Pinjaman Jatuh Tempo / Terlambat</div>
          <div
            className={`font-mono-num text-xl font-bold ${
              overdueLoans.length > 0 ? 'text-red-700' : 'text-slate-900'
            }`}
          >
            {overdueLoans.length} Pinjaman
          </div>
          <div className="text-xs text-slate-500 font-mono-num">
            {formatRupiah(overdueLoans.reduce((s, l) => s + l.remainingAmount, 0))} belum lunas
          </div>
        </div>
      </div>

      {/* Sub-Navigasi */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSubTab('loans')}
          className={`min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
            subTab === 'loans'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <HandCoins className="w-4 h-4" />
          <span>Daftar Pinjaman</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('payments')}
          className={`min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
            subTab === 'payments'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <History className="w-4 h-4" />
          <span>Riwayat Cicilan &amp; Pelunasan</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('summary')}
          className={`min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
            subTab === 'summary'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <FileBarChart2 className="w-4 h-4" />
          <span>Laporan Pinjaman</span>
        </button>
      </div>

      {/* Tab Daftar Pinjaman */}
      {subTab === 'loans' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari nama peminjam, nomor pinjaman, atau rekening..."
                className="w-full min-h-[44px] pl-10 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label="Filter Status Pinjaman"
              className="min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              <option value="all">Semua Status</option>
              <option value="active">Belum Lunas (Semua)</option>
              <option value="Belum Bayar">Belum Bayar</option>
              <option value="Cicilan">Cicilan</option>
              <option value="Terlambat">Terlambat</option>
              <option value="Lunas">Lunas</option>
            </select>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {loading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : filteredLoans.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {loans.length === 0
                  ? 'Belum ada data pinjaman uang pelanggan.'
                  : 'Tidak ada data pinjaman yang sesuai filter.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 whitespace-nowrap">No. &amp; Peminjam</th>
                      <th className="py-3 px-4 whitespace-nowrap">Tanggal / Tempo</th>
                      <th className="py-3 px-4 whitespace-nowrap">Sumber Dana</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Pokok</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Dibayar</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Sisa Pinjaman</th>
                      <th className="py-3 px-4 whitespace-nowrap">Status</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredLoans.map((loan) => {
                      const dispStatus = getLoanDisplayStatus(loan, todayStr);
                      return (
                        <tr key={loan.id} className="hover:bg-slate-50">
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-slate-900">{loan.borrowerName}</div>
                            <div className="text-xs font-mono-num text-slate-500">
                              {loan.transactionNumber}
                              {loan.borrowerPhone ? ` · ${loan.borrowerPhone}` : ''}
                            </div>
                            {loan.notes && (
                              <div className="text-[11px] text-slate-500 truncate max-w-[220px]">
                                {loan.notes}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                            <div>Pinjam: {loan.loanDate}</div>
                            <div className="flex items-center gap-1 mt-0.5">
                              <CalendarClock className="w-3 h-3 text-slate-400" />
                              <span>Tempo: {loan.dueDate}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-xs text-slate-700 whitespace-nowrap">
                            <div className="font-medium">{loan.sourceAccountName}</div>
                            <div className="text-slate-500">
                              {getAccountTypeLabel(loan.sourceAccountType)}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono-num text-slate-700 whitespace-nowrap">
                            {formatRupiah(loan.principalAmount)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono-num text-emerald-700 whitespace-nowrap">
                            {formatRupiah(loan.paidAmount)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono-num font-bold text-slate-900 whitespace-nowrap">
                            {formatRupiah(loan.remainingAmount)}
                          </td>
                          <td className="py-3.5 px-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold ${getStatusBadgeClass(
                                dispStatus
                              )}`}
                            >
                              {dispStatus}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            {loan.remainingAmount > 0 ? (
                              <button
                                type="button"
                                onClick={() => openPayModal(loan)}
                                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 cursor-pointer"
                              >
                                Bayar Cicilan
                              </button>
                            ) : (
                              <span className="text-xs text-slate-400 font-medium">Selesai</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab Riwayat Pembayaran */}
      {subTab === 'payments' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h3 className="font-display font-semibold text-base text-slate-900">
              Riwayat Pembayaran Cicilan &amp; Pelunasan Pinjaman
            </h3>
          </div>
          {payments.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Belum ada pembayaran cicilan pinjaman yang tercatat.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                    <th className="py-3 px-4 whitespace-nowrap">No. Pembayaran</th>
                    <th className="py-3 px-4 whitespace-nowrap">Peminjam (Ref)</th>
                    <th className="py-3 px-4 whitespace-nowrap">Masuk Rekening</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Nominal Bayar</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Sisa Setelah Bayar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {payments.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                        {p.transactionDate} · {p.transactionTime}
                      </td>
                      <td className="py-3 px-4 font-mono-num text-xs font-semibold text-slate-900 whitespace-nowrap">
                        {p.transactionNumber}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{p.borrowerName}</div>
                        <div className="text-xs font-mono-num text-slate-500">{p.loanNumber}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                        {p.accountName}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                        +{formatRupiah(p.amount)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-slate-900 whitespace-nowrap">
                        {formatRupiah(p.remainingAfter)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab Laporan Pinjaman */}
      {subTab === 'summary' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Rekapitulasi Laporan Pinjaman Uang Pelanggan
              </h3>
              <p className="text-xs text-slate-500">
                Posisi per {formatIndonesianDate(todayStr)} (terpisah dari omzet &amp; beban usaha)
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
              <div className="px-4 py-3 flex justify-between">
                <span className="text-slate-600">Total Pokok Pinjaman Disalurkan</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {formatRupiah(totalPrincipal)}
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between">
                <span className="text-slate-600">Total Cicilan &amp; Pelunasan Diterima</span>
                <span className="font-mono-num font-semibold text-emerald-700">
                  {formatRupiah(totalPaid)}
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between bg-amber-50/60">
                <span className="font-semibold text-slate-900">Total Piutang Belum Lunas</span>
                <span className="font-mono-num font-bold text-amber-800">
                  {formatRupiah(totalRemaining)}
                </span>
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
              <div className="px-4 py-3 flex justify-between">
                <span className="text-slate-600">Pinjaman Status Belum Bayar</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {loans.filter((l) => getLoanDisplayStatus(l, todayStr) === 'Belum Bayar').length}{' '}
                  transaksi
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between">
                <span className="text-slate-600">Pinjaman Status Cicilan</span>
                <span className="font-mono-num font-semibold text-amber-700">
                  {loans.filter((l) => getLoanDisplayStatus(l, todayStr) === 'Cicilan').length}{' '}
                  transaksi
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between">
                <span className="text-slate-600">Pinjaman Status Terlambat</span>
                <span className="font-mono-num font-semibold text-red-700">
                  {overdueLoans.length} transaksi
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between">
                <span className="text-slate-600">Pinjaman Status Lunas</span>
                <span className="font-mono-num font-semibold text-emerald-700">
                  {loans.filter((l) => getLoanDisplayStatus(l, todayStr) === 'Lunas').length}{' '}
                  transaksi
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Tambah Pinjaman */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleCreateLoan}
            className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-5 space-y-4 my-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Catat Pinjaman Uang Baru
              </h3>
              <button
                type="button"
                onClick={() => setShowNewModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="space-y-1">
                <label htmlFor="loan-name" className="block text-xs font-medium text-slate-700">
                  Nama Peminjam
                </label>
                <input
                  id="loan-name"
                  type="text"
                  required
                  maxLength={100}
                  value={borrowerName}
                  onChange={(e) => setBorrowerName(e.target.value)}
                  placeholder="Contoh: Pak Budi"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="loan-phone" className="block text-xs font-medium text-slate-700">
                  Nomor HP (Opsional)
                </label>
                <input
                  id="loan-phone"
                  type="text"
                  maxLength={24}
                  value={borrowerPhone}
                  onChange={(e) => setBorrowerPhone(e.target.value)}
                  placeholder="08xxxxxxxxxx"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="loan-source" className="block text-xs font-medium text-slate-700">
                  Sumber Dana (Laci Kas / DANA / Rekening Bank)
                </label>
                <select
                  id="loan-source"
                  required
                  value={sourceAccountId}
                  onChange={(e) => setSourceAccountId(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {selectableAccounts.length === 0 ? (
                    <option value="">(Belum ada akun kas / rekening aktif)</option>
                  ) : (
                    selectableAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} · {getAccountTypeLabel(acc.type)} (Saldo {formatRupiah(acc.balance)})
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="loan-amt" className="block text-xs font-medium text-slate-700">
                  Jumlah Pinjaman (Rp)
                </label>
                <input
                  id="loan-amt"
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={principalAmount}
                  onChange={(e) => setPrincipalAmount(e.target.value)}
                  placeholder="Contoh: 200000"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="loan-date" className="block text-xs font-medium text-slate-700">
                  Tanggal Pinjaman
                </label>
                <input
                  id="loan-date"
                  type="date"
                  required
                  value={loanDate}
                  onChange={(e) => setLoanDate(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="loan-due" className="block text-xs font-medium text-slate-700">
                  Tanggal Jatuh Tempo
                </label>
                <input
                  id="loan-due"
                  type="date"
                  required
                  min={loanDate}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="loan-notes" className="block text-xs font-medium text-slate-700">
                  Catatan (Opsional)
                </label>
                <input
                  id="loan-notes"
                  type="text"
                  maxLength={240}
                  value={loanNotes}
                  onChange={(e) => setLoanNotes(e.target.value)}
                  placeholder="Keterangan tambahan..."
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowNewModal(false)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={savingLoan || selectableAccounts.length === 0}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{savingLoan ? 'Menyimpan...' : 'Salurkan Pinjaman'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Cicilan / Pelunasan */}
      {payingLoan && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleRecordPayment}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Terima Cicilan / Pelunasan
                </h3>
                <div className="text-xs font-mono-num text-slate-500">
                  {payingLoan.borrowerName} · {payingLoan.transactionNumber}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPayingLoan(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1 font-mono-num">
              <div className="flex justify-between">
                <span className="text-slate-500">Pokok Pinjaman</span>
                <span className="text-slate-900">{formatRupiah(payingLoan.principalAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Sudah Dibayar</span>
                <span className="text-emerald-700">{formatRupiah(payingLoan.paidAmount)}</span>
              </div>
              <div className="flex justify-between font-bold border-t border-slate-200 pt-1">
                <span className="text-slate-700">Sisa Pinjaman</span>
                <span className="text-amber-800">{formatRupiah(payingLoan.remainingAmount)}</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor="pay-loan-amt" className="block text-xs font-medium text-slate-700">
                    Nominal Pembayaran (Rp)
                  </label>
                  <button
                    type="button"
                    onClick={() => setPayAmount(String(payingLoan.remainingAmount))}
                    className="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer"
                  >
                    Lunasi Semua
                  </button>
                </div>
                <input
                  id="pay-loan-amt"
                  type="number"
                  required
                  min="1"
                  max={payingLoan.remainingAmount}
                  step="1"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="pay-loan-acc" className="block text-xs font-medium text-slate-700">
                  Masuk ke Rekening / Kas Tujuan
                </label>
                <select
                  id="pay-loan-acc"
                  required
                  value={destAccountId}
                  onChange={(e) => setDestAccountId(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {selectableAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} (Saldo {formatRupiah(acc.balance)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="pay-loan-notes" className="block text-xs font-medium text-slate-700">
                  Catatan (Opsional)
                </label>
                <input
                  id="pay-loan-notes"
                  type="text"
                  maxLength={240}
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="Cicilan ke-1, transfer BRI, dll"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayingLoan(null)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={savingPay}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{savingPay ? 'Memproses...' : 'Simpan Pembayaran'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
