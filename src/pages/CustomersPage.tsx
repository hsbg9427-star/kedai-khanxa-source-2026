import React, { useEffect, useState } from 'react';
import {
  Plus,
  Search,
  Check,
  X,
  Pencil,
  Trash2,
  Banknote,
  Receipt,
  UserPlus,
  History,
  Phone,
  MapPin,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type { Account, Customer, Receivable } from '../types/database';
import {
  createCustomer,
  deleteCustomer,
  recordManualDebt,
  recordReceivablePayment,
  subscribeReceivables,
  updateCustomer,
} from '../services/receivableService';
import { formatRupiah, getTodayDateString } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';

interface CustomersPageProps {
  customers: Customer[];
  loading: boolean;
  hasPendingWrites: boolean;
  accounts: Account[];
}

type ViewTab = 'customers' | 'history';
type DebtFilter = 'all' | 'has_debt' | 'settled';
type HistoryTypeFilter = 'all' | 'debt' | 'payment';

export function CustomersPage({
  customers,
  loading,
  hasPendingWrites,
  accounts,
}: CustomersPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [viewTab, setViewTab] = useState<ViewTab>('customers');
  const [searchQuery, setSearchQuery] = useState('');
  const [debtFilter, setDebtFilter] = useState<DebtFilter>('all');
  const [historyTypeFilter, setHistoryTypeFilter] = useState<HistoryTypeFilter>('all');
  const [historyCustomerId, setHistoryCustomerId] = useState<string>('all');

  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [receivablesLoading, setReceivablesLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Modal Tambah / Edit Pelanggan
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [custAddress, setCustAddress] = useState('');
  const [custNotes, setCustNotes] = useState('');
  const [custOpeningDebt, setCustOpeningDebt] = useState('0');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Modal Bayar / Cicil Piutang
  const [payingCustomer, setPayingCustomer] = useState<Customer | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payAccountId, setPayAccountId] = useState('');
  const [payNotes, setPayNotes] = useState('');

  // Modal Tambah Kasbon Manual
  const [debtCustomer, setDebtCustomer] = useState<Customer | null>(null);
  const [debtAmount, setDebtAmount] = useState('');
  const [debtNotes, setDebtNotes] = useState('');

  const activeAccounts = accounts.filter((a) => a.isActive);
  const staffUser = {
    uid: user?.uid || '',
    displayName: profile?.displayName || user?.displayName || 'Petugas',
  };

  useEffect(() => {
    if (!user) return;
    setReceivablesLoading(true);
    const unsub = subscribeReceivables(
      isAdmin,
      user.uid,
      (list) => {
        setReceivables(list);
        setReceivablesLoading(false);
      },
      () => setReceivablesLoading(false)
    );
    return () => unsub();
  }, [user, isAdmin]);

  useEffect(() => {
    if (!payAccountId && activeAccounts.length > 0) {
      const cashAcc = activeAccounts.find((a) => a.type === 'cash') || activeAccounts[0];
      if (cashAcc) setPayAccountId(cashAcc.id);
    }
  }, [activeAccounts, payAccountId]);

  const todayStr = getTodayDateString();
  const totalDebtAll = customers.reduce((sum, c) => sum + (Number(c.totalDebt) || 0), 0);
  const debtorsCount = customers.filter((c) => Number(c.totalDebt) > 0).length;
  const todayPaymentsTotal = receivables
    .filter((r) => r.type === 'payment' && r.transactionDate === todayStr)
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const todayPaymentsCount = receivables.filter(
    (r) => r.type === 'payment' && r.transactionDate === todayStr
  ).length;

  const filteredCustomers = customers.filter((c) => {
    const debt = Number(c.totalDebt) || 0;
    if (debtFilter === 'has_debt' && debt <= 0) return false;
    if (debtFilter === 'settled' && debt > 0) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q) ||
        (c.address || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const filteredHistory = receivables.filter((r) => {
    if (historyTypeFilter !== 'all' && r.type !== historyTypeFilter) return false;
    if (historyCustomerId !== 'all' && r.customerId !== historyCustomerId) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        r.customerName.toLowerCase().includes(q) ||
        r.transactionNumber.toLowerCase().includes(q) ||
        (r.notes || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const openCreateCustomer = () => {
    setEditingCustomer(null);
    setCustName('');
    setCustPhone('');
    setCustAddress('');
    setCustNotes('');
    setCustOpeningDebt('0');
    setShowCustomerModal(true);
    setFeedback(null);
  };

  const openEditCustomer = (c: Customer) => {
    setEditingCustomer(c);
    setCustName(c.name);
    setCustPhone(c.phone || '');
    setCustAddress(c.address || '');
    setCustNotes(c.notes || '');
    setCustOpeningDebt('0');
    setShowCustomerModal(true);
    setFeedback(null);
  };

  const handleSaveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!custName.trim()) {
      setFeedback({ kind: 'err', text: 'Nama pelanggan wajib diisi.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      if (editingCustomer) {
        await updateCustomer(editingCustomer.id, {
          name: custName,
          phone: custPhone,
          address: custAddress,
          notes: custNotes,
        });
        setFeedback({
          kind: 'ok',
          text: isOnline
            ? `Data pelanggan "${custName.trim()}" berhasil diperbarui.`
            : `Perubahan data "${custName.trim()}" disimpan lokal (offline).`,
        });
      } else {
        const openingDebt = Math.max(0, Number(custOpeningDebt) || 0);
        await createCustomer(
          {
            name: custName,
            phone: custPhone,
            address: custAddress,
            notes: custNotes,
            openingDebt,
          },
          staffUser
        );
        setFeedback({
          kind: 'ok',
          text: isOnline
            ? `Pelanggan "${custName.trim()}" berhasil ditambahkan${
                openingDebt > 0 ? ` dengan saldo piutang awal ${formatRupiah(openingDebt)}` : ''
              }.`
            : `Pelanggan "${custName.trim()}" disimpan lokal (offline) dan akan disinkronkan saat online.`,
        });
      }
      setShowCustomerModal(false);
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteCustomer = async (c: Customer) => {
    if (!isAdmin) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await deleteCustomer(c);
      setConfirmDeleteId(null);
      setFeedback({ kind: 'ok', text: `Pelanggan "${c.name}" berhasil dihapus.` });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openPayModal = (c: Customer) => {
    setPayingCustomer(c);
    setPayAmount(String(c.totalDebt));
    setPayNotes('');
    if (!payAccountId && activeAccounts.length > 0) {
      const cashAcc = activeAccounts.find((a) => a.type === 'cash') || activeAccounts[0];
      if (cashAcc) setPayAccountId(cashAcc.id);
    }
    setFeedback(null);
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !payingCustomer) return;

    const chosenAccount = activeAccounts.find((a) => a.id === payAccountId);
    if (!chosenAccount) {
      setFeedback({
        kind: 'err',
        text: 'Pilih akun kas atau rekening penerima pembayaran terlebih dahulu.',
      });
      return;
    }

    const numericAmount = Number(payAmount) || 0;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await recordReceivablePayment(
        {
          customer: payingCustomer,
          amount: numericAmount,
          account: chosenAccount,
          notes: payNotes,
        },
        staffUser
      );
      setPayingCustomer(null);
      setFeedback({
        kind: 'ok',
        text: `Pembayaran ${res.transactionNumber} sebesar ${formatRupiah(
          numericAmount
        )} diterima ke ${chosenAccount.name}. Sisa piutang ${payingCustomer.name}: ${formatRupiah(
          res.balanceAfter
        )}.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openDebtModal = (c: Customer) => {
    setDebtCustomer(c);
    setDebtAmount('');
    setDebtNotes('');
    setFeedback(null);
  };

  const handleRecordManualDebt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !debtCustomer) return;

    const numericAmount = Number(debtAmount) || 0;
    setSubmitting(true);
    setFeedback(null);
    try {
      const trxNo = await recordManualDebt(
        {
          customer: debtCustomer,
          amount: numericAmount,
          notes: debtNotes,
        },
        staffUser
      );
      setDebtCustomer(null);
      setFeedback({
        kind: 'ok',
        text: `Kasbon ${trxNo} sebesar ${formatRupiah(
          numericAmount
        )} untuk ${debtCustomer.name} berhasil dicatat.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openCustomerHistory = (customerId: string) => {
    setHistoryCustomerId(customerId);
    setHistoryTypeFilter('all');
    setViewTab('history');
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs text-slate-500">
            Buku Pelanggan &amp; Catatan Kasbon
            {hasPendingWrites && (
              <>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span className="text-amber-700 font-medium">Menunggu sinkronisasi</span>
              </>
            )}
          </div>
          <h2 className="font-display text-xl font-bold text-slate-900">
            Pelanggan &amp; Piutang (Kasbon)
          </h2>
          <p className="text-xs text-slate-500">
            Pembayaran piutang otomatis menambah saldo kas/rekening dan tercatat di buku arus kas.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateCustomer}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <UserPlus className="w-4 h-4" />
          <span>Tambah Pelanggan</span>
        </button>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">Total Piutang Aktif</div>
          <div className="font-mono-num text-2xl font-semibold text-amber-700">
            {loading ? '...' : formatRupiah(totalDebtAll)}
          </div>
          <div className="text-xs text-slate-500">Akumulasi kasbon belum lunas</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">Pelanggan Ada Piutang</div>
          <div className="font-mono-num text-2xl font-semibold text-slate-900">
            {loading ? '...' : debtorsCount}
          </div>
          <div className="text-xs text-slate-500">Pelanggan dengan tagihan aktif</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">Total Pelanggan Terdaftar</div>
          <div className="font-mono-num text-2xl font-semibold text-slate-900">
            {loading ? '...' : customers.length}
          </div>
          <div className="text-xs text-slate-500">Tersinkronisasi antarperangkat</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">Pelunasan / Cicilan Hari Ini</div>
          <div className="font-mono-num text-2xl font-semibold text-emerald-700">
            {formatRupiah(todayPaymentsTotal)}
          </div>
          <div className="text-xs text-slate-500 font-mono-num">
            {todayPaymentsCount} pembayaran masuk
          </div>
        </div>
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

      {/* Toolbar & Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setViewTab('customers')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewTab === 'customers'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Daftar Pelanggan ({customers.length})
            </button>
            <button
              type="button"
              onClick={() => setViewTab('history')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewTab === 'history'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Riwayat Kasbon &amp; Pembayaran ({receivables.length})
            </button>
          </div>

          {viewTab === 'customers' ? (
            <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'all', label: 'Semua' },
                  { id: 'has_debt', label: `Ada Piutang (${debtorsCount})` },
                  { id: 'settled', label: 'Lunas' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDebtFilter(opt.id)}
                  className={`min-h-[36px] px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    debtFilter === opt.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                {(
                  [
                    { id: 'all', label: 'Semua Jenis' },
                    { id: 'debt', label: 'Kasbon' },
                    { id: 'payment', label: 'Pembayaran' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setHistoryTypeFilter(opt.id)}
                    className={`min-h-[36px] px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      historyTypeFilter === opt.id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <select
                value={historyCustomerId}
                onChange={(e) => setHistoryCustomerId(e.target.value)}
                aria-label="Filter Pelanggan di Riwayat"
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="all">Semua Pelanggan</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="relative w-full lg:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              viewTab === 'customers'
                ? 'Cari nama, HP, atau alamat...'
                : 'Cari no. transaksi atau pelanggan...'
            }
            className="w-full min-h-[42px] pl-10 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
          />
        </div>
      </div>

      {/* Konten Utama */}
      {viewTab === 'customers' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : filteredCustomers.length === 0 ? (
            <div className="p-10 text-center space-y-3">
              <UserPlus className="w-8 h-8 text-slate-400 mx-auto" />
              <div className="text-sm text-slate-600">
                {customers.length === 0
                  ? 'Belum ada data pelanggan yang tercatat. Tambahkan pelanggan pertama untuk mulai mencatat kasbon.'
                  : 'Tidak ada pelanggan yang cocok dengan pencarian atau filter.'}
              </div>
              {customers.length === 0 && (
                <button
                  type="button"
                  onClick={openCreateCustomer}
                  className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Tambah Pelanggan Pertama</span>
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-5">Nama Pelanggan</th>
                      <th className="py-3 px-5 whitespace-nowrap">Kontak &amp; Alamat</th>
                      <th className="py-3 px-5 whitespace-nowrap">Status</th>
                      <th className="py-3 px-5 text-right whitespace-nowrap">Sisa Piutang</th>
                      <th className="py-3 px-5 text-right whitespace-nowrap">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredCustomers.map((c) => {
                      const hasDebt = Number(c.totalDebt) > 0;
                      return (
                        <tr key={c.id} className="hover:bg-slate-50">
                          <td className="py-3.5 px-5">
                            <div className="font-semibold text-slate-900">{c.name}</div>
                            {c.notes && (
                              <div className="text-xs text-slate-500 truncate max-w-xs">
                                {c.notes}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-5 text-xs text-slate-600 space-y-0.5">
                            <div className="font-mono-num">{c.phone || '-'}</div>
                            {c.address && (
                              <div className="text-slate-500 truncate max-w-xs">{c.address}</div>
                            )}
                          </td>
                          <td className="py-3.5 px-5 whitespace-nowrap">
                            <span
                              className={`text-xs font-semibold ${
                                hasDebt ? 'text-amber-700' : 'text-emerald-700'
                              }`}
                            >
                              {hasDebt ? 'Ada Piutang' : 'Lunas'}
                            </span>
                          </td>
                          <td
                            className={`py-3.5 px-5 text-right font-mono-num font-semibold whitespace-nowrap ${
                              hasDebt ? 'text-amber-700' : 'text-slate-500'
                            }`}
                          >
                            {formatRupiah(c.totalDebt)}
                          </td>
                          <td className="py-3.5 px-5 text-right whitespace-nowrap">
                            {confirmDeleteId === c.id ? (
                              <span className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteCustomer(c)}
                                  disabled={submitting}
                                  className="text-xs font-semibold text-red-700 hover:underline cursor-pointer"
                                >
                                  Ya, Hapus
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="text-xs text-slate-500 hover:underline cursor-pointer"
                                >
                                  Batal
                                </button>
                              </span>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                {hasDebt && (
                                  <button
                                    type="button"
                                    onClick={() => openPayModal(c)}
                                    className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 inline-flex items-center gap-1 cursor-pointer"
                                  >
                                    <Banknote className="w-3.5 h-3.5" />
                                    <span>Bayar</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => openDebtModal(c)}
                                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1 cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                  <span>Kasbon</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openCustomerHistory(c.id)}
                                  className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                                  title="Lihat Riwayat Pelanggan"
                                  aria-label={`Riwayat ${c.name}`}
                                >
                                  <History className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openEditCustomer(c)}
                                  className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                                  aria-label={`Ubah ${c.name}`}
                                >
                                  <Pencil className="w-4 h-4" />
                                </button>
                                {isAdmin && (
                                  <button
                                    type="button"
                                    disabled={hasDebt}
                                    onClick={() => setConfirmDeleteId(c.id)}
                                    title={
                                      hasDebt
                                        ? 'Lunasi piutang sebelum menghapus pelanggan'
                                        : `Hapus ${c.name}`
                                    }
                                    className="p-2 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                                    aria-label={`Hapus ${c.name}`}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Android Cards */}
              <div className="md:hidden divide-y divide-slate-100">
                {filteredCustomers.map((c) => {
                  const hasDebt = Number(c.totalDebt) > 0;
                  return (
                    <div key={c.id} className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="text-sm font-semibold text-slate-900 truncate">
                            {c.name}
                          </div>
                          <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            {c.phone && (
                              <span className="inline-flex items-center gap-1 font-mono-num">
                                <Phone className="w-3 h-3" />
                                {c.phone}
                              </span>
                            )}
                            {c.address && (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {c.address}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div
                            className={`font-mono-num text-sm font-bold ${
                              hasDebt ? 'text-amber-700' : 'text-emerald-700'
                            }`}
                          >
                            {formatRupiah(c.totalDebt)}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {hasDebt ? 'Sisa Piutang' : 'Lunas'}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {hasDebt && (
                          <button
                            type="button"
                            onClick={() => openPayModal(c)}
                            className="min-h-[40px] flex-1 px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <Banknote className="w-3.5 h-3.5" />
                            <span>Bayar / Cicil</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openDebtModal(c)}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 inline-flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Kasbon</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openCustomerHistory(c.id)}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 inline-flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <History className="w-3.5 h-3.5" />
                          <span>Riwayat</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditCustomer(c)}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 inline-flex items-center justify-center cursor-pointer"
                          aria-label={`Ubah ${c.name}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : (
        /* Tab Riwayat Kasbon & Pembayaran */
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Receipt className="w-4 h-4 text-slate-500" />
              <h3 className="font-display font-semibold text-base text-slate-900">
                Buku Mutasi Kasbon &amp; Pelunasan
              </h3>
            </div>
            <span className="text-xs text-slate-500">
              Tersinkronisasi real-time (Admin &amp; Kasir)
            </span>
          </div>

          {receivablesLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Belum ada catatan kasbon atau pembayaran piutang yang sesuai filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                    <th className="py-3 px-4 whitespace-nowrap">No. Transaksi</th>
                    <th className="py-3 px-4 whitespace-nowrap">Pelanggan</th>
                    <th className="py-3 px-4 whitespace-nowrap">Jenis</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Nominal</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Sisa Piutang</th>
                    <th className="py-3 px-4">Catatan</th>
                    <th className="py-3 px-4 whitespace-nowrap">Petugas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredHistory.map((r) => {
                    const resolvedSource =
                      r.sourceType || (r.saleId ? 'sale' : 'manual');
                    const sourceBadge =
                      resolvedSource === 'ppob'
                        ? { label: 'PPOB', cls: 'bg-sky-50 text-sky-800 border-sky-200' }
                        : resolvedSource === 'mini_atm'
                        ? { label: 'Mini ATM', cls: 'bg-indigo-50 text-indigo-800 border-indigo-200' }
                        : resolvedSource === 'sale'
                        ? { label: 'Kasir', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' }
                        : { label: 'Manual', cls: 'bg-slate-50 text-slate-700 border-slate-200' };
                    return (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                        {r.transactionDate} · {r.transactionTime}
                      </td>
                      <td className="py-3 px-4 font-mono-num text-xs font-semibold text-slate-900 whitespace-nowrap">
                        <div>{r.transactionNumber}</div>
                        <span
                          className={`inline-block mt-0.5 px-1.5 py-0.5 rounded border text-[10px] font-sans font-semibold ${sourceBadge.cls}`}
                        >
                          {sourceBadge.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-900 whitespace-nowrap">
                        {r.customerName}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`text-xs font-semibold ${
                            r.type === 'debt' ? 'text-amber-700' : 'text-emerald-700'
                          }`}
                        >
                          {r.type === 'debt' ? 'Tambah Kasbon' : 'Pembayaran'}
                        </span>
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono-num font-semibold whitespace-nowrap ${
                          r.type === 'debt' ? 'text-amber-700' : 'text-emerald-700'
                        }`}
                      >
                        {r.type === 'debt' ? '+' : '-'}
                        {formatRupiah(r.amount)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-slate-700 whitespace-nowrap">
                        {formatRupiah(r.balanceAfter)}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 min-w-[200px]">
                        {r.notes || '-'}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {r.recordedByName}
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

      {/* Modal Tambah / Edit Pelanggan */}
      {showCustomerModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4">
          <form
            onSubmit={handleSaveCustomer}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-display font-semibold text-base text-slate-900">
                {editingCustomer ? 'Ubah Data Pelanggan' : 'Tambah Pelanggan Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowCustomerModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="cst-name" className="block text-xs font-medium text-slate-700">
                  Nama Pelanggan
                </label>
                <input
                  id="cst-name"
                  type="text"
                  required
                  maxLength={100}
                  value={custName}
                  onChange={(e) => setCustName(e.target.value)}
                  placeholder="Contoh: Ibu Siti / Pak Budi"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="cst-phone" className="block text-xs font-medium text-slate-700">
                  No. HP / WhatsApp (Opsional)
                </label>
                <input
                  id="cst-phone"
                  type="text"
                  maxLength={24}
                  value={custPhone}
                  onChange={(e) => setCustPhone(e.target.value)}
                  placeholder="08xxxxxxxxxx"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="cst-address" className="block text-xs font-medium text-slate-700">
                  Alamat / Keterangan Tempat (Opsional)
                </label>
                <input
                  id="cst-address"
                  type="text"
                  maxLength={200}
                  value={custAddress}
                  onChange={(e) => setCustAddress(e.target.value)}
                  placeholder="Contoh: RT 03 / Dekat Mushola"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              {!editingCustomer && (
                <div className="space-y-1">
                  <label htmlFor="cst-debt" className="block text-xs font-medium text-slate-700">
                    Saldo Piutang Awal (Rp, jika pindahan dari buku catatan)
                  </label>
                  <input
                    id="cst-debt"
                    type="number"
                    min="0"
                    step="any"
                    value={custOpeningDebt}
                    onChange={(e) => setCustOpeningDebt(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              )}

              <div className="space-y-1">
                <label htmlFor="cst-notes" className="block text-xs font-medium text-slate-700">
                  Catatan (Opsional)
                </label>
                <input
                  id="cst-notes"
                  type="text"
                  maxLength={200}
                  value={custNotes}
                  onChange={(e) => setCustNotes(e.target.value)}
                  placeholder="Contoh: Langganan beras & galon"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCustomerModal(false)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{submitting ? 'Menyimpan...' : 'Simpan'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Bayar / Cicil Piutang */}
      {payingCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4">
          <form
            onSubmit={handleRecordPayment}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Pembayaran / Cicilan Piutang
                </h3>
                <div className="text-xs text-slate-500">{payingCustomer.name}</div>
              </div>
              <button
                type="button"
                onClick={() => setPayingCustomer(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between">
              <span className="text-xs text-slate-600">Total Sisa Piutang</span>
              <span className="font-mono-num text-lg font-bold text-amber-700">
                {formatRupiah(payingCustomer.totalDebt)}
              </span>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="pay-amount" className="block text-xs font-medium text-slate-700">
                    Nominal Dibayar (Rp)
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setPayAmount(String(Math.round(payingCustomer.totalDebt / 2)))
                      }
                      className="text-[11px] font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer"
                    >
                      50%
                    </button>
                    <span className="text-slate-300" aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={() => setPayAmount(String(payingCustomer.totalDebt))}
                      className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 underline cursor-pointer"
                    >
                      Lunasi Semua
                    </button>
                  </div>
                </div>
                <input
                  id="pay-amount"
                  type="number"
                  required
                  min="1"
                  max={payingCustomer.totalDebt}
                  step="any"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="pay-acc" className="block text-xs font-medium text-slate-700">
                  Masuk ke Akun Kas / Rekening
                </label>
                <select
                  id="pay-acc"
                  required
                  value={payAccountId}
                  onChange={(e) => setPayAccountId(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {activeAccounts.length === 0 ? (
                    <option value="">(Belum ada akun kas aktif)</option>
                  ) : (
                    activeAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({formatRupiah(acc.balance)})
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="pay-notes" className="block text-xs font-medium text-slate-700">
                  Catatan Pembayaran (Opsional)
                </label>
                <input
                  id="pay-notes"
                  type="text"
                  maxLength={240}
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="Contoh: Cicilan ke-1 atau lunas transfer"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="flex items-center justify-between text-xs text-slate-600 pt-1">
                <span>Estimasi Sisa Piutang Setelah Bayar</span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {formatRupiah(
                    Math.max(0, payingCustomer.totalDebt - (Number(payAmount) || 0))
                  )}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayingCustomer(null)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={submitting || activeAccounts.length === 0}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{submitting ? 'Memproses...' : 'Simpan Pembayaran'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Tambah Kasbon Manual */}
      {debtCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4">
          <form
            onSubmit={handleRecordManualDebt}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Catat Kasbon Manual
                </h3>
                <div className="text-xs text-slate-500">
                  {debtCustomer.name} · Piutang saat ini {formatRupiah(debtCustomer.totalDebt)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDebtCustomer(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="manual-debt-amt" className="block text-xs font-medium text-slate-700">
                  Nominal Kasbon (Rp)
                </label>
                <input
                  id="manual-debt-amt"
                  type="number"
                  required
                  min="1"
                  step="any"
                  value={debtAmount}
                  onChange={(e) => setDebtAmount(e.target.value)}
                  placeholder="Contoh: 50000"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="manual-debt-notes" className="block text-xs font-medium text-slate-700">
                  Keterangan / Barang yang Diambil
                </label>
                <input
                  id="manual-debt-notes"
                  type="text"
                  required
                  maxLength={240}
                  value={debtNotes}
                  onChange={(e) => setDebtNotes(e.target.value)}
                  placeholder="Contoh: Beras 5kg + minyak 1L atau catatan lama"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDebtCustomer(null)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{submitting ? 'Menyimpan...' : 'Catat Kasbon'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
