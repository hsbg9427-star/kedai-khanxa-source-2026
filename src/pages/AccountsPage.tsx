import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Wallet,
  History,
  AlertCircle,
  ArrowLeftRight,
  Banknote,
  Search,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type { Account, AccountType, CashLedger } from '../types/database';
import {
  createAccount,
  deleteAccount,
  subscribeCashLedger,
  updateAccount,
} from '../services/warungService';
import {
  recordCapitalAdjustment,
  transferBetweenAccounts,
} from '../services/financeService';
import { formatRupiah, getAccountTypeLabel } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';

interface AccountsPageProps {
  accounts: Account[];
  loading: boolean;
  hasPendingWrites: boolean;
}

const SOURCE_MODULE_LABELS: Record<string, string> = {
  sale: 'Penjualan Kasir',
  purchase: 'Pembelian Stok',
  mini_atm: 'Mini ATM',
  ppob: 'PPOB',
  expense: 'Pengeluaran',
  receivable: 'Piutang / Kasbon',
  capital: 'Modal / Penyesuaian',
  transfer: 'Mutasi Antar Akun',
  loan: 'Pinjaman Uang',
};

export function AccountsPage({ accounts, loading, hasPendingWrites }: AccountsPageProps) {
  const { user, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [subTab, setSubTab] = useState<'accounts' | 'ledger'>('accounts');
  const [ledgerRows, setLedgerRows] = useState<CashLedger[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('cash');
  const [accountNumber, setAccountNumber] = useState('');
  const [balance, setBalance] = useState('0');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Transfer Antar Akun
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNotes, setTransferNotes] = useState('');

  // Tambah / Tarik Modal
  const [showCapitalModal, setShowCapitalModal] = useState(false);
  const [capAccountId, setCapAccountId] = useState('');
  const [capDirection, setCapDirection] = useState<'in' | 'out'>('in');
  const [capAmount, setCapAmount] = useState('');
  const [capNotes, setCapNotes] = useState('');

  // Filter Mutasi Saldo
  const [ledgerAccountFilter, setLedgerAccountFilter] = useState('all');
  const [ledgerModuleFilter, setLedgerModuleFilter] = useState('all');
  const [ledgerSearch, setLedgerSearch] = useState('');

  const actionLockRef = useRef(false);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);

  const filteredLedgerRows = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase();
    return ledgerRows.filter((row) => {
      if (ledgerAccountFilter !== 'all' && row.accountId !== ledgerAccountFilter) return false;
      if (ledgerModuleFilter !== 'all' && row.sourceModule !== ledgerModuleFilter) return false;
      if (!q) return true;
      return (
        row.transactionNumber.toLowerCase().includes(q) ||
        row.accountName.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q)
      );
    });
  }, [ledgerRows, ledgerAccountFilter, ledgerModuleFilter, ledgerSearch]);

  useEffect(() => {
    if (!user || !isAdmin || subTab !== 'ledger') return;
    setLedgerLoading(true);
    const unsub = subscribeCashLedger(
      true,
      user.uid,
      (rows) => {
        setLedgerRows(rows);
        setLedgerLoading(false);
      },
      () => setLedgerLoading(false)
    );
    return () => unsub();
  }, [user, isAdmin, subTab]);

  if (!isAdmin) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>
          Akses ditolak. Pengelolaan Kas, Rekening Bank, dan Mutasi Saldo hanya dapat diakses oleh
          Admin.
        </span>
      </div>
    );
  }

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setType('cash');
    setAccountNumber('');
    setBalance('0');
    setIsActive(true);
    setShowForm(false);
  };

  const openEdit = (acc: Account) => {
    setEditingId(acc.id);
    setName(acc.name);
    setType(acc.type);
    setAccountNumber(acc.accountNumber || '');
    setBalance(String(acc.balance));
    setIsActive(acc.isActive);
    setShowForm(true);
    setFeedback(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin) return;
    if (!name.trim()) {
      setFeedback({ kind: 'err', text: 'Nama akun kas atau rekening wajib diisi.' });
      return;
    }

    const numericBalance = Number(balance);
    if (!Number.isFinite(numericBalance)) {
      setFeedback({ kind: 'err', text: 'Saldo awal harus berupa angka yang valid.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      if (editingId) {
        await updateAccount(
          editingId,
          {
            name,
            type,
            accountNumber,
            balance: numericBalance,
            isActive,
          },
          user.uid
        );
        setFeedback({
          kind: 'ok',
          text: isOnline
            ? 'Data akun kas/rekening berhasil diperbarui.'
            : 'Perubahan disimpan lokal (offline) dan akan disinkronkan otomatis saat online.',
        });
      } else {
        await createAccount(
          {
            name,
            type,
            accountNumber,
            balance: numericBalance,
          },
          user.uid
        );
        setFeedback({
          kind: 'ok',
          text: isOnline
            ? 'Akun kas/rekening baru berhasil ditambahkan.'
            : 'Akun disimpan lokal (offline) dan akan disinkronkan otomatis saat online.',
        });
      }
      resetForm();
    } catch (error) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!isAdmin) return;
    setSubmitting(true);
    try {
      await deleteAccount(id);
      setConfirmDeleteId(null);
      setFeedback({ kind: 'ok', text: 'Akun kas/rekening berhasil dihapus.' });
    } catch (error) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
    } finally {
      setSubmitting(false);
    }
  };

  const openTransferModal = () => {
    setFeedback(null);
    if (activeAccounts.length >= 2) {
      setFromAccountId(activeAccounts[0].id);
      setToAccountId(activeAccounts[1].id);
    } else if (activeAccounts.length === 1) {
      setFromAccountId(activeAccounts[0].id);
      setToAccountId(activeAccounts[0].id);
    }
    setTransferAmount('');
    setTransferNotes('');
    setShowTransferModal(true);
  };

  const handleTransferSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin || actionLockRef.current) return;
    const fromAcc = activeAccounts.find((a) => a.id === fromAccountId);
    const toAcc = activeAccounts.find((a) => a.id === toAccountId);
    if (!fromAcc || !toAcc) {
      setFeedback({ kind: 'err', text: 'Pilih akun asal dan tujuan mutasi yang valid.' });
      return;
    }

    actionLockRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await transferBetweenAccounts(
        {
          fromAccount: fromAcc,
          toAccount: toAcc,
          amount: Number(transferAmount) || 0,
          notes: transferNotes,
        },
        {
          uid: user.uid,
          displayName: user.displayName || 'Admin',
        }
      );
      setShowTransferModal(false);
      setFeedback({
        kind: 'ok',
        text: `Pindah saldo ${res.transactionNumber} dari ${fromAcc.name} ke ${toAcc.name} berhasil dicatat di Mutasi Saldo.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSubmitting(false);
      actionLockRef.current = false;
    }
  };

  const openCapitalModal = () => {
    setFeedback(null);
    if (activeAccounts.length > 0) {
      setCapAccountId(activeAccounts[0].id);
    }
    setCapDirection('in');
    setCapAmount('');
    setCapNotes('');
    setShowCapitalModal(true);
  };

  const handleCapitalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin || actionLockRef.current) return;
    const targetAcc = activeAccounts.find((a) => a.id === capAccountId);
    if (!targetAcc) {
      setFeedback({ kind: 'err', text: 'Pilih akun kas/rekening yang valid.' });
      return;
    }

    actionLockRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await recordCapitalAdjustment(
        {
          account: targetAcc,
          direction: capDirection,
          amount: Number(capAmount) || 0,
          notes: capNotes,
        },
        {
          uid: user.uid,
          displayName: user.displayName || 'Admin',
        }
      );
      setShowCapitalModal(false);
      setFeedback({
        kind: 'ok',
        text: `${capDirection === 'in' ? 'Penambahan modal' : 'Penarikan modal / prive'} ${
          res.transactionNumber
        } pada ${targetAcc.name} berhasil dicatat.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSubmitting(false);
      actionLockRef.current = false;
    }
  };

  const totalActiveBalance = accounts
    .filter((a) => a.isActive)
    .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs text-slate-500">
            Total Saldo Aktif
            {hasPendingWrites && (
              <>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span className="text-amber-700 font-medium">Menunggu sinkronisasi</span>
              </>
            )}
          </div>
          <div className="font-mono-num text-2xl font-bold text-slate-900">
            {formatRupiah(totalActiveBalance)}
          </div>
        </div>

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {activeAccounts.length >= 2 && (
              <button
                type="button"
                onClick={openTransferModal}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <ArrowLeftRight className="w-4 h-4" />
                <span>Pindah Saldo</span>
              </button>
            )}
            {activeAccounts.length >= 1 && (
              <button
                type="button"
                onClick={openCapitalModal}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Banknote className="w-4 h-4" />
                <span>Tambah / Tarik Modal</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (showForm) {
                  resetForm();
                } else {
                  setShowForm(true);
                  setFeedback(null);
                }
              }}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 transition-colors whitespace-nowrap cursor-pointer"
            >
              {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              <span>{showForm ? 'Tutup Form' : 'Tambah Kas / Rekening'}</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSubTab('accounts')}
          className={`min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
            subTab === 'accounts'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Wallet className="w-4 h-4" />
          <span>Daftar Kas &amp; Rekening</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('ledger')}
          className={`min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
            subTab === 'ledger'
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <History className="w-4 h-4" />
          <span>Riwayat Mutasi Saldo</span>
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

      {/* Form Tambah / Ubah Akun (Admin Only) */}
      {isAdmin && showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <h3 className="font-display font-semibold text-base text-slate-900">
            {editingId ? 'Ubah Data Akun Kas / Rekening' : 'Tambah Akun Kas / Rekening Baru'}
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="acc-name" className="block text-xs font-medium text-slate-700">
                Nama Akun
              </label>
              <input
                id="acc-name"
                type="text"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Contoh: Kas Laci Utama atau Rekening BRI"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="acc-type" className="block text-xs font-medium text-slate-700">
                Jenis Akun
              </label>
              <select
                id="acc-type"
                value={type}
                onChange={(e) => setType(e.target.value as AccountType)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="cash">Kas Tunai / Laci</option>
                <option value="bank">Rekening Bank (Mini ATM)</option>
                <option value="ewallet">Dompet Digital (E-Wallet)</option>
                <option value="ppob_deposit">Deposit Server PPOB</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="acc-number" className="block text-xs font-medium text-slate-700">
                Nomor Rekening / ID Akun (Opsional)
              </label>
              <input
                id="acc-number"
                type="text"
                maxLength={40}
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                placeholder="Contoh: 0123-01-004567-50-2"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="acc-balance" className="block text-xs font-medium text-slate-700">
                Saldo Saat Ini (Rp)
              </label>
              <input
                id="acc-balance"
                type="number"
                required
                step="1"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
          </div>

          {editingId && (
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
              />
              <span>Akun aktif digunakan untuk transaksi</span>
            </label>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={resetForm}
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
              <span>{submitting ? 'Menyimpan...' : 'Simpan Akun'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Daftar Akun */}
      {subTab === 'accounts' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h3 className="font-display font-semibold text-base text-slate-900">
              Daftar Akun Kas, Rekening Bank &amp; Deposit PPOB
            </h3>
          </div>

          {loading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : accounts.length === 0 ? (
            <div className="p-8 text-center space-y-3">
              <Wallet className="w-8 h-8 text-slate-400 mx-auto" />
              <div className="text-sm text-slate-600">
                Belum ada akun kas atau rekening bank yang tercatat di database.
              </div>
              {isAdmin && !showForm && (
                <button
                  type="button"
                  onClick={() => setShowForm(true)}
                  className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Buat Akun Kas Pertama</span>
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-5">Nama Akun</th>
                    <th className="py-3 px-5 whitespace-nowrap">Jenis</th>
                    <th className="py-3 px-5 whitespace-nowrap">Nomor / ID</th>
                    <th className="py-3 px-5 whitespace-nowrap">Status</th>
                    <th className="py-3 px-5 text-right whitespace-nowrap">Saldo</th>
                    {isAdmin && <th className="py-3 px-5 text-right whitespace-nowrap">Aksi</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {accounts.map((acc) => (
                    <tr key={acc.id} className="hover:bg-slate-50">
                      <td className="py-3.5 px-5 font-medium text-slate-900">{acc.name}</td>
                      <td className="py-3.5 px-5 text-slate-600 whitespace-nowrap">
                        {getAccountTypeLabel(acc.type)}
                      </td>
                      <td className="py-3.5 px-5 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                        {acc.accountNumber || '-'}
                      </td>
                      <td className="py-3.5 px-5 whitespace-nowrap">
                        <span
                          className={`text-xs font-medium ${
                            acc.isActive ? 'text-emerald-700' : 'text-slate-400'
                          }`}
                        >
                          {acc.isActive ? 'Aktif' : 'Nonaktif'}
                        </span>
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                        {formatRupiah(acc.balance)}
                      </td>
                      {isAdmin && (
                        <td className="py-3.5 px-5 text-right whitespace-nowrap">
                          {confirmDeleteId === acc.id ? (
                            <span className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleDelete(acc.id)}
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
                            <span className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEdit(acc)}
                                className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                                aria-label={`Ubah ${acc.name}`}
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(acc.id)}
                                className="p-2 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 cursor-pointer"
                                aria-label={`Hapus ${acc.name}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Riwayat Mutasi Saldo Kas &amp; Rekening (Terbaru)
              </h3>
              <p className="text-xs text-slate-500">
                Setiap pergerakan saldo dari kasir, QRIS bersih, Mini ATM, PPOB, pinjaman, pengeluaran, dan transfer tercatat otomatis.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={ledgerSearch}
                  onChange={(e) => setLedgerSearch(e.target.value)}
                  placeholder="Cari ref / keterangan..."
                  className="min-h-[38px] pl-9 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs w-44 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <select
                value={ledgerAccountFilter}
                onChange={(e) => setLedgerAccountFilter(e.target.value)}
                aria-label="Filter akun mutasi"
                className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="all">Semua Akun</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
              <select
                value={ledgerModuleFilter}
                onChange={(e) => setLedgerModuleFilter(e.target.value)}
                aria-label="Filter modul mutasi"
                className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="all">Semua Modul</option>
                {Object.entries(SOURCE_MODULE_LABELS).map(([k, lbl]) => (
                  <option key={k} value={k}>
                    {lbl}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {ledgerLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : filteredLedgerRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Belum ada mutasi saldo yang sesuai dengan filter ini.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                    <th className="py-3 px-4 whitespace-nowrap">No. Referensi</th>
                    <th className="py-3 px-4 whitespace-nowrap">Akun</th>
                    <th className="py-3 px-4 whitespace-nowrap">Modul</th>
                    <th className="py-3 px-4">Keterangan</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Mutasi</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Saldo Akhir</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredLedgerRows.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                        {row.transactionDate} · {row.transactionTime}
                      </td>
                      <td className="py-3 px-4 font-mono-num text-xs font-semibold text-slate-900 whitespace-nowrap">
                        {row.transactionNumber}
                      </td>
                      <td className="py-3 px-4 text-xs font-medium text-slate-900 whitespace-nowrap">
                        {row.accountName}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {SOURCE_MODULE_LABELS[row.sourceModule] || row.sourceModule}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700 min-w-[200px]">
                        {row.description}
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono-num font-semibold whitespace-nowrap ${
                          row.direction === 'in' ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {row.direction === 'in' ? '+' : '-'}
                        {formatRupiah(row.amount)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-slate-900 whitespace-nowrap">
                        {formatRupiah(row.balanceAfter)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modal Transfer / Pindah Saldo Antar Rekening */}
      {showTransferModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h4 className="font-display font-bold text-base text-slate-900">
                  Pindah Saldo Antar Kas / Rekening
                </h4>
                <p className="text-xs text-slate-500">
                  Contoh: setor tunai laci kas ke bank atau isi deposit PPOB dari rekening.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowTransferModal(false)}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleTransferSubmit} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="trf-from" className="block text-xs font-medium text-slate-700">
                  Dari Akun Sumber *
                </label>
                <select
                  id="trf-from"
                  value={fromAccountId}
                  onChange={(e) => setFromAccountId(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {activeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({formatRupiah(acc.balance)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="trf-to" className="block text-xs font-medium text-slate-700">
                  Ke Akun Tujuan *
                </label>
                <select
                  id="trf-to"
                  value={toAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {activeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({formatRupiah(acc.balance)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="trf-amount" className="block text-xs font-medium text-slate-700">
                  Nominal Pindah Saldo (Rp) *
                </label>
                <input
                  id="trf-amount"
                  type="number"
                  min="1"
                  step="any"
                  required
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                  placeholder="Contoh: 500000"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="trf-notes" className="block text-xs font-medium text-slate-700">
                  Catatan Mutasi (Opsional)
                </label>
                <input
                  id="trf-notes"
                  type="text"
                  maxLength={120}
                  value={transferNotes}
                  onChange={(e) => setTransferNotes(e.target.value)}
                  placeholder="Contoh: Topup deposit server PPOB"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowTransferModal(false)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60 cursor-pointer"
                >
                  {submitting ? 'Memproses...' : 'Catat Pindah Saldo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Tambah / Tarik Modal */}
      {showCapitalModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h4 className="font-display font-bold text-base text-slate-900">
                  Tambah atau Tarik Modal Usaha
                </h4>
                <p className="text-xs text-slate-500">
                  Suntikan modal atau penarikan pemilik tercatat rapi di Mutasi Saldo tanpa masuk omzet.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCapitalModal(false)}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCapitalSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCapDirection('in')}
                  className={`min-h-[44px] rounded-lg border text-xs font-semibold cursor-pointer ${
                    capDirection === 'in'
                      ? 'bg-emerald-700 border-emerald-700 text-white'
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  (+) Tambah Modal
                </button>
                <button
                  type="button"
                  onClick={() => setCapDirection('out')}
                  className={`min-h-[44px] rounded-lg border text-xs font-semibold cursor-pointer ${
                    capDirection === 'out'
                      ? 'bg-amber-700 border-amber-700 text-white'
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  (-) Tarik Modal / Prive
                </button>
              </div>

              <div className="space-y-1">
                <label htmlFor="cap-acc" className="block text-xs font-medium text-slate-700">
                  Akun Kas / Rekening *
                </label>
                <select
                  id="cap-acc"
                  value={capAccountId}
                  onChange={(e) => setCapAccountId(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {activeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({formatRupiah(acc.balance)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="cap-amount" className="block text-xs font-medium text-slate-700">
                  Nominal (Rp) *
                </label>
                <input
                  id="cap-amount"
                  type="number"
                  min="1"
                  step="any"
                  required
                  value={capAmount}
                  onChange={(e) => setCapAmount(e.target.value)}
                  placeholder="Contoh: 1000000"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="cap-notes" className="block text-xs font-medium text-slate-700">
                  Keterangan *
                </label>
                <input
                  id="cap-notes"
                  type="text"
                  required
                  maxLength={200}
                  value={capNotes}
                  onChange={(e) => setCapNotes(e.target.value)}
                  placeholder="Contoh: Tambah modal uang pecahan kasir"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCapitalModal(false)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60 cursor-pointer"
                >
                  {submitting ? 'Menyimpan...' : 'Simpan Mutasi Modal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
