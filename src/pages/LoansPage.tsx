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
  Pencil,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type { Account, Loan, LoanPayment } from '../types/database';
import {
  createLoanDisbursement,
  recordLoanInstallment,
  subscribeLoanPayments,
  subscribeLoans,
  updateLoanAdminFeeAgreement,
} from '../services/loanService';
import {
  formatIndonesianDate,
  formatRupiah,
  getAccountTypeLabel,
  getTodayDateString,
} from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import {
  getLoanAdminFeeState,
  getLoanDisplayStatus,
  getLoanPaymentBreakdown,
  type LoanDisplayStatus,
} from '../utils/qrisFee';
import { roundMoney } from '../utils/unitConversion';

interface LoansPageProps {
  accounts: Account[];
}

type LoanTab = 'loans' | 'payments' | 'summary';
type StatusFilter =
  | 'all'
  | 'active'
  | 'Belum Bayar'
  | 'Cicilan'
  | 'Terlambat'
  | 'Lunas'
  | 'awaiting_admin';

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
  const [loanAdminFee, setLoanAdminFee] = useState('');
  const [loanDate, setLoanDate] = useState(getTodayDateString());
  const [dueDate, setDueDate] = useState(addDays(getTodayDateString(), 30));
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [loanNotes, setLoanNotes] = useState('');
  const [savingLoan, setSavingLoan] = useState(false);

  // Modal Cicilan / Pelunasan / Bayar Admin Fleksibel
  const [payingLoan, setPayingLoan] = useState<Loan | null>(null);
  const [payPrincipal, setPayPrincipal] = useState('');
  const [payAdminFee, setPayAdminFee] = useState('');
  const [destAccountId, setDestAccountId] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [savingPay, setSavingPay] = useState(false);

  // Edit target biaya admin fleksibel di modal pembayaran
  const [editingTargetAdmin, setEditingTargetAdmin] = useState(false);
  const [targetAdminDraft, setTargetAdminDraft] = useState('');
  const [savingTargetAdmin, setSavingTargetAdmin] = useState(false);

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
  const totalAdminFeePaid = roundMoney(
    loans.reduce((sum, l) => sum + Math.max(0, Number(l.adminFeePaid) || 0), 0)
  );
  const awaitingAdminLoans = loans.filter((l) => getLoanAdminFeeState(l).needsAdminPayment);
  const overdueLoans = loans.filter((l) => getLoanDisplayStatus(l, todayStr) === 'Terlambat');
  const activeLoansCount = loans.filter((l) => Number(l.remainingAmount) > 0).length;

  const filteredLoans = loans.filter((l) => {
    const displayStatus = getLoanDisplayStatus(l, todayStr);
    const adminState = getLoanAdminFeeState(l);
    if (statusFilter === 'active' && displayStatus === 'Lunas') return false;
    if (statusFilter === 'awaiting_admin' && !adminState.needsAdminPayment) return false;
    if (
      statusFilter !== 'all' &&
      statusFilter !== 'active' &&
      statusFilter !== 'awaiting_admin' &&
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
    setLoanAdminFee('');
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
      const parsedAdminFee = roundMoney(Math.max(0, Number(loanAdminFee) || 0));
      const res = await createLoanDisbursement(
        {
          borrowerName,
          borrowerPhone,
          principalAmount: Number(principalAmount),
          adminFee: parsedAdminFee,
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
            } berkurang ${formatRupiah(Number(principalAmount))} (biaya admin dibayar setelah pengembalian).`
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
    const adminState = getLoanAdminFeeState(loan);
    setPayingLoan(loan);
    setPayPrincipal(loan.remainingAmount > 0 ? String(loan.remainingAmount) : '0');
    setPayAdminFee(
      loan.remainingAmount <= 0 && adminState.remainingTargetAdminFee > 0
        ? String(adminState.remainingTargetAdminFee)
        : ''
    );
    setEditingTargetAdmin(false);
    setTargetAdminDraft(adminState.targetAdminFee > 0 ? String(adminState.targetAdminFee) : '');
    setPayNotes('');
    setFeedback(null);
    const preferred =
      selectableAccounts.find((a) => a.id === loan.sourceAccountId) ||
      selectableAccounts.find((a) => a.type === 'cash') ||
      selectableAccounts[0];
    if (preferred) setDestAccountId(preferred.id);
  };

  const handleSaveTargetAdminFee = async () => {
    if (!payingLoan || savingTargetAdmin) return;
    const nextTarget = roundMoney(Math.max(0, Number(targetAdminDraft) || 0));
    setSavingTargetAdmin(true);
    try {
      await updateLoanAdminFeeAgreement(payingLoan.id, nextTarget);
      setPayingLoan({ ...payingLoan, adminFee: nextTarget });
      setEditingTargetAdmin(false);
      if (payingLoan.remainingAmount <= 0) {
        const remAdmin = Math.max(0, nextTarget - (Number(payingLoan.adminFeePaid) || 0));
        if (remAdmin > 0) setPayAdminFee(String(remAdmin));
      }
      setFeedback({
        kind: 'ok',
        text:
          nextTarget > 0
            ? `Target biaya admin ${payingLoan.transactionNumber} diperbarui menjadi ${formatRupiah(
                nextTarget
              )}.`
            : `Biaya admin ${payingLoan.transactionNumber} diatur ke mode Fleksibel.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSavingTargetAdmin(false);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !payingLoan || submitLockRef.current) return;

    const destAcc = selectableAccounts.find((a) => a.id === destAccountId);
    if (!destAcc) {
      setFeedback({ kind: 'err', text: 'Pilih kas atau rekening tujuan penerimaan.' });
      return;
    }

    const numericPrincipal = roundMoney(Math.max(0, Number(payPrincipal) || 0));
    const numericAdmin = roundMoney(Math.max(0, Number(payAdminFee) || 0));
    const totalCashIn = roundMoney(numericPrincipal + numericAdmin);

    if (totalCashIn <= 0) {
      setFeedback({
        kind: 'err',
        text: 'Isi minimal salah satu: nominal bayar pokok pinjaman atau biaya admin (> Rp0).',
      });
      return;
    }
    if (numericPrincipal > 0 && payingLoan.remainingAmount <= 0) {
      setFeedback({
        kind: 'err',
        text: 'Pokok pinjaman sudah lunas. Kosongkan nominal pokok untuk membayar biaya admin saja.',
      });
      return;
    }
    if (numericPrincipal > payingLoan.remainingAmount) {
      setFeedback({
        kind: 'err',
        text: `Pembayaran pokok tidak boleh melebihi sisa pokok pinjaman (${formatRupiah(
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
          principalAmountPaid: numericPrincipal,
          adminFeePaid: numericAdmin,
          destinationAccount: destAcc,
          notes: payNotes,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        }
      );

      setPayingLoan(null);
      const summaryParts: string[] = [];
      if (res.principalPaid > 0) summaryParts.push(`Pokok ${formatRupiah(res.principalPaid)}`);
      if (res.adminFeePaid > 0) summaryParts.push(`Admin ${formatRupiah(res.adminFeePaid)}`);
      setFeedback({
        kind: 'ok',
        text: `${res.transactionNumber} (${summaryParts.join(' + ')}) = ${formatRupiah(
          res.totalReceived
        )} diterima ke ${destAcc.name}. Sisa pokok: ${formatRupiah(res.remainingAfter)}.`,
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

  const modalPrincipalNum = roundMoney(Math.max(0, Number(payPrincipal) || 0));
  const modalAdminNum = roundMoney(Math.max(0, Number(payAdminFee) || 0));
  const modalTotalIn = roundMoney(modalPrincipalNum + modalAdminNum);
  const payingAdminState = payingLoan ? getLoanAdminFeeState(payingLoan) : null;

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
            Khusus Admin. Pokok pinjaman &amp; pengembalian pokok memengaruhi kas/rekening (pos
            non-laba), sedangkan biaya admin fleksibel dibayar setelah/saat pengembalian &amp;
            dicatat sebagai pendapatan jasa.
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Total Pinjaman Diberikan</div>
          <div className="font-mono-num text-lg font-bold text-slate-900">
            {formatRupiah(totalPrincipal)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">{loans.length} catatan pinjaman</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Pokok Kembali</div>
          <div className="font-mono-num text-lg font-bold text-emerald-700">
            {formatRupiah(totalPaid)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">{payments.length} kali pembayaran</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Sisa Piutang Pokok</div>
          <div className="font-mono-num text-lg font-bold text-amber-700">
            {formatRupiah(totalRemaining)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">
            {activeLoansCount} peminjam masih berjalan
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Biaya Admin Diterima</div>
          <div className="font-mono-num text-lg font-bold text-emerald-700">
            {formatRupiah(totalAdminFeePaid)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">
            {awaitingAdminLoans.length > 0
              ? `${awaitingAdminLoans.length} tunggu bayar admin`
              : 'Fleksibel setelah pengembalian'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Jatuh Tempo / Terlambat</div>
          <div
            className={`font-mono-num text-lg font-bold ${
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
          <span>Riwayat Cicilan &amp; Admin</span>
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
              <option value="active">Pokok Belum Lunas (Semua)</option>
              <option value="Belum Bayar">Belum Bayar</option>
              <option value="Cicilan">Cicilan</option>
              <option value="Terlambat">Terlambat</option>
              <option value="Lunas">Pokok Lunas</option>
              <option value="awaiting_admin">Pokok Lunas · Menunggu Biaya Admin</option>
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
                      <th className="py-3 px-4 text-right whitespace-nowrap">Sisa Pokok</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Biaya Admin</th>
                      <th className="py-3 px-4 whitespace-nowrap">Status</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredLoans.map((loan) => {
                      const dispStatus = getLoanDisplayStatus(loan, todayStr);
                      const adminState = getLoanAdminFeeState(loan);
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
                          <td className="py-3.5 px-4 text-right font-mono-num text-xs whitespace-nowrap">
                            <div
                              className={
                                adminState.paidAdminFee > 0
                                  ? 'font-semibold text-emerald-700'
                                  : 'text-slate-500'
                              }
                            >
                              Masuk: {formatRupiah(adminState.paidAdminFee)}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {adminState.isFlexible
                                ? 'Mode: Fleksibel'
                                : `Target: ${formatRupiah(adminState.targetAdminFee)}`}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 whitespace-nowrap">
                            <div className="flex flex-col items-start gap-1">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold ${getStatusBadgeClass(
                                  dispStatus
                                )}`}
                              >
                                {dispStatus}
                              </span>
                              {adminState.needsAdminPayment && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold bg-amber-50 text-amber-800 border-amber-200">
                                  Menunggu Admin
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            {loan.remainingAmount > 0 ? (
                              <button
                                type="button"
                                onClick={() => openPayModal(loan)}
                                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 cursor-pointer"
                              >
                                Bayar / Cicil
                              </button>
                            ) : adminState.needsAdminPayment ? (
                              <button
                                type="button"
                                onClick={() => openPayModal(loan)}
                                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 cursor-pointer"
                              >
                                Bayar Admin
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => openPayModal(loan)}
                                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-100 cursor-pointer"
                              >
                                {adminState.paidAdminFee > 0 ? '+ Biaya Admin' : 'Bayar Admin'}
                              </button>
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
              Riwayat Pembayaran Pokok &amp; Biaya Admin Pinjaman
            </h3>
          </div>
          {payments.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Belum ada pembayaran cicilan atau biaya admin pinjaman yang tercatat.
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
                    <th className="py-3 px-4 text-right whitespace-nowrap">Pokok</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Biaya Admin</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Total Masuk</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Sisa Pokok</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {payments.map((p) => {
                    const parts = getLoanPaymentBreakdown(p);
                    return (
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
                        <td className="py-3 px-4 text-right font-mono-num text-slate-800 whitespace-nowrap">
                          {formatRupiah(parts.principalPaid)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-emerald-700 whitespace-nowrap">
                          {formatRupiah(parts.adminFeePaid)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                          +{formatRupiah(parts.totalAmount)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-slate-900 whitespace-nowrap">
                          {formatRupiah(p.remainingAfter)}
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

      {/* Tab Laporan Pinjaman */}
      {subTab === 'summary' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Rekapitulasi Laporan Pinjaman Uang Pelanggan
              </h3>
              <p className="text-xs text-slate-500">
                Posisi per {formatIndonesianDate(todayStr)} (pokok terpisah dari omzet; biaya admin
                masuk pendapatan jasa)
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
                <span className="text-slate-600">Total Pengembalian Pokok Diterima</span>
                <span className="font-mono-num font-semibold text-emerald-700">
                  {formatRupiah(totalPaid)}
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between bg-amber-50/60">
                <span className="font-semibold text-slate-900">Total Sisa Piutang Pokok</span>
                <span className="font-mono-num font-bold text-amber-800">
                  {formatRupiah(totalRemaining)}
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between bg-emerald-50/60">
                <span className="font-semibold text-slate-900">
                  Total Biaya Admin Diterima (Pendapatan)
                </span>
                <span className="font-mono-num font-bold text-emerald-700">
                  {formatRupiah(totalAdminFeePaid)}
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
                <span className="text-slate-600">Pinjaman Pokok Lunas</span>
                <span className="font-mono-num font-semibold text-emerald-700">
                  {loans.filter((l) => getLoanDisplayStatus(l, todayStr) === 'Lunas').length}{' '}
                  transaksi
                </span>
              </div>
              <div className="px-4 py-3 flex justify-between">
                <span className="text-slate-600">Pokok Lunas Menunggu Target Admin</span>
                <span className="font-mono-num font-semibold text-amber-700">
                  {awaitingAdminLoans.length} transaksi
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
                  Jumlah Pinjaman / Pokok (Rp)
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

              <div className="sm:col-span-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="loan-admin" className="block text-xs font-medium text-slate-700">
                    Biaya Admin (Rp · Opsional &amp; Fleksibel)
                  </label>
                  <button
                    type="button"
                    onClick={() => setLoanAdminFee('')}
                    className="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer"
                  >
                    Kosongkan (Fleksibel)
                  </button>
                </div>
                <input
                  id="loan-admin"
                  type="number"
                  min="0"
                  step="1"
                  value={loanAdminFee}
                  onChange={(e) => setLoanAdminFee(e.target.value)}
                  placeholder="Kosongkan = tentukan bebas setelah pinjaman dikembalikan"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <div className="flex flex-wrap gap-1.5">
                  {[0, 5000, 10000, 20000, 50000].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setLoanAdminFee(val === 0 ? '' : String(val))}
                      className="px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[11px] font-medium text-slate-700 cursor-pointer"
                    >
                      {val === 0 ? 'Fleksibel (Nanti)' : formatRupiah(val)}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  Tidak dipotong di awal pencairan (uang keluar 100% sesuai pokok). Biaya admin
                  dibayar setelah pengembalian pinjaman dan nominalnya dapat diubah kapan saja.
                </p>
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

      {/* Modal Cicilan / Pelunasan / Bayar Admin Fleksibel */}
      {payingLoan && payingAdminState && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleRecordPayment}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4 my-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  {payingLoan.remainingAmount > 0
                    ? 'Terima Pengembalian & Biaya Admin'
                    : 'Bayar Biaya Admin Pinjaman'}
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

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1.5 font-mono-num">
              <div className="flex justify-between">
                <span className="text-slate-500">Pokok Pinjaman</span>
                <span className="text-slate-900">{formatRupiah(payingLoan.principalAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Pokok Sudah Dibayar</span>
                <span className="text-emerald-700">{formatRupiah(payingLoan.paidAmount)}</span>
              </div>
              <div className="flex justify-between font-bold border-t border-slate-200 pt-1">
                <span className="text-slate-700">Sisa Pokok Pinjaman</span>
                <span
                  className={
                    payingLoan.remainingAmount > 0 ? 'text-amber-800' : 'text-emerald-700'
                  }
                >
                  {payingLoan.remainingAmount > 0
                    ? formatRupiah(payingLoan.remainingAmount)
                    : 'Rp0 (Lunas)'}
                </span>
              </div>
              <div className="flex justify-between items-center border-t border-slate-200 pt-1">
                <span className="text-slate-500">Target Biaya Admin</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-800">
                    {payingAdminState.isFlexible
                      ? 'Fleksibel'
                      : formatRupiah(payingAdminState.targetAdminFee)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingTargetAdmin((v) => !v)}
                    className="inline-flex items-center gap-0.5 text-[11px] font-sans font-semibold text-emerald-700 hover:underline cursor-pointer"
                  >
                    <Pencil className="w-3 h-3" />
                    <span>{editingTargetAdmin ? 'Tutup' : 'Ubah'}</span>
                  </button>
                </div>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Biaya Admin Masuk</span>
                <span className="text-emerald-700">
                  {formatRupiah(payingAdminState.paidAdminFee)}
                </span>
              </div>

              {editingTargetAdmin && (
                <div className="pt-2 border-t border-slate-200 space-y-1.5 font-sans">
                  <label
                    htmlFor="edit-target-admin"
                    className="block text-[11px] font-medium text-slate-700"
                  >
                    Atur Target Biaya Admin (0 = Fleksibel)
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="edit-target-admin"
                      type="number"
                      min="0"
                      step="1"
                      value={targetAdminDraft}
                      onChange={(e) => setTargetAdminDraft(e.target.value)}
                      placeholder="0 = Fleksibel"
                      className="flex-1 min-h-[36px] px-2.5 py-1 rounded border border-slate-300 text-xs font-mono-num bg-white"
                    />
                    <button
                      type="button"
                      disabled={savingTargetAdmin}
                      onClick={handleSaveTargetAdminFee}
                      className="min-h-[36px] px-3 py-1 rounded bg-slate-800 text-white text-xs font-medium hover:bg-slate-900 disabled:opacity-50 cursor-pointer"
                    >
                      {savingTargetAdmin ? '...' : 'Simpan'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {/* Input Bayar Pokok */}
              {payingLoan.remainingAmount > 0 ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="pay-loan-principal"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Bayar Pokok Pinjaman (Rp)
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPayPrincipal('0')}
                        className="text-[11px] font-medium text-slate-600 hover:underline cursor-pointer"
                      >
                        Rp0 (Admin Saja)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPayPrincipal(String(payingLoan.remainingAmount))}
                        className="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer"
                      >
                        Lunasi Pokok
                      </button>
                    </div>
                  </div>
                  <input
                    id="pay-loan-principal"
                    type="number"
                    min="0"
                    max={payingLoan.remainingAmount}
                    step="1"
                    value={payPrincipal}
                    onChange={(e) => setPayPrincipal(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              ) : (
                <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                  Pokok pinjaman sudah lunas 100%. Silakan masukkan nominal biaya admin fleksibel di
                  bawah ini.
                </div>
              )}

              {/* Input Biaya Admin Fleksibel */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="pay-loan-admin" className="block text-xs font-medium text-slate-700">
                    Bayar Biaya Admin (Rp · Fleksibel)
                  </label>
                  {payingAdminState.remainingTargetAdminFee > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setPayAdminFee(String(payingAdminState.remainingTargetAdminFee))
                      }
                      className="text-xs font-semibold text-amber-700 hover:underline cursor-pointer"
                    >
                      Isi Sisa Target ({formatRupiah(payingAdminState.remainingTargetAdminFee)})
                    </button>
                  )}
                </div>
                <input
                  id="pay-loan-admin"
                  type="number"
                  min="0"
                  step="1"
                  value={payAdminFee}
                  onChange={(e) => setPayAdminFee(e.target.value)}
                  placeholder={
                    payingLoan.remainingAmount > 0
                      ? '0 (opsional, atau bayar setelah pokok kembali)'
                      : 'Masukkan biaya admin fleksibel (contoh: 10000)'
                  }
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <div className="flex flex-wrap gap-1.5">
                  {[0, 5000, 10000, 20000, 50000].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setPayAdminFee(val === 0 ? '' : String(val))}
                      className="px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[11px] font-medium text-slate-700 cursor-pointer"
                    >
                      {val === 0 ? 'Rp0 (Nanti)' : formatRupiah(val)}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  {payingLoan.remainingAmount > 0
                    ? 'Biaya admin dapat dikosongkan sekarang dan dibayar belakangan setelah pinjaman pokok dikembalikan.'
                    : 'Nominal bebas sesuai kesepakatan akhir dan langsung masuk pendapatan jasa.'}
                </p>
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
                  placeholder="Biaya admin setelah pelunasan, transfer BRI, dll"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-between text-xs">
                <span className="font-medium text-emerald-900">
                  Total Uang Masuk ({formatRupiah(modalPrincipalNum)} pokok +{' '}
                  {formatRupiah(modalAdminNum)} admin)
                </span>
                <span className="font-mono-num text-sm font-bold text-emerald-800">
                  {formatRupiah(modalTotalIn)}
                </span>
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
                disabled={savingPay || modalTotalIn <= 0}
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
