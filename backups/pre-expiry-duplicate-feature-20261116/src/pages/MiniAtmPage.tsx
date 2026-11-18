import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Landmark,
  ArrowDownLeft,
  ArrowUpRight,
  Search,
  CheckCircle2,
  X,
  RotateCcw,
  Receipt,
  AlertCircle,
  WifiOff,
  QrCode,
  ShieldCheck,
  SlidersHorizontal,
  FileSpreadsheet,
  FileText,
  Upload,
  Eye,
  Plus,
  Trash2,
  History,
  BarChart3,
  ArrowRightLeft,
  Printer,
  Copy,
  Download,
  Share2,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type {
  Account,
  MiniAtmFeeAudit,
  MiniAtmFeeTier,
  MiniAtmPaymentChannel,
  MiniAtmTransaction,
  StoreSetting,
} from '../types/database';
import {
  recordMiniAtmTransaction,
  saveMiniAtmSettings,
  subscribeMiniAtmFeeAudits,
  subscribeMiniAtmSettings,
  subscribeMiniAtmTransactions,
  voidMiniAtmTransaction,
} from '../services/serviceModuleService';
import {
  calculateMiniAtmBreakdown,
  COMMON_MINI_ATM_BANKS,
  getDefaultMiniAtmSettings,
  getMiniAtmServiceLabel,
  MINI_ATM_SERVICE_OPTIONS,
  resolveMiniAtmStandardFees,
  type ActiveMiniAtmServiceType,
  type MiniAtmServiceType,
  type MiniAtmSettingValues,
} from '../utils/serviceTransactions';
import {
  buildMiniAtmReport,
  exportMiniAtmReportExcel,
  exportMiniAtmReportPdf,
  type MiniAtmReportPeriodType,
} from '../utils/miniAtmReports';
import { compressImageFile } from '../utils/imageHelper';
import { formatRupiah, generateSafeId, getTodayDateString } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import { formatMiniAtmReceiptText } from '../utils/posReceipt';
import {
  buildRawBtThermalUrl,
  downloadThermalReceiptPdf,
  printThermalReceiptText,
} from '../utils/receiptPrinter';

interface MiniAtmPageProps {
  accounts: Account[];
  storeSetting: StoreSetting | null;
}

type MiniAtmTab = 'transaksi' | 'riwayat' | 'laporan' | 'pengaturan';

export function MiniAtmPage({ accounts, storeSetting }: MiniAtmPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [activeTab, setActiveTab] = useState<MiniAtmTab>('transaksi');
  const [transactions, setTransactions] = useState<MiniAtmTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasPendingWrites, setHasPendingWrites] = useState(false);

  // Settings & Audits
  const [miniAtmSettings, setMiniAtmSettings] = useState<MiniAtmSettingValues>(
    getDefaultMiniAtmSettings
  );
  const [settingsDraft, setSettingsDraft] = useState<MiniAtmSettingValues>(
    getDefaultMiniAtmSettings
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [newBankNameInput, setNewBankNameInput] = useState('');
  const [newBankFeeInput, setNewBankFeeInput] = useState('2500');
  const [feeAudits, setFeeAudits] = useState<MiniAtmFeeAudit[]>([]);

  // Form State (Hanya Tarik Tunai & Transfer Bank)
  const [serviceType, setServiceType] = useState<ActiveMiniAtmServiceType>('tarik_tunai');
  const [paymentChannel, setPaymentChannel] = useState<MiniAtmPaymentChannel>('qris');
  const [qrisVerified, setQrisVerified] = useState(false);
  const [transferVerified, setTransferVerified] = useState(false);
  const [bankName, setBankName] = useState('QRIS Merchant');
  const [targetAccountNumber, setTargetAccountNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [externalReferenceNumber, setExternalReferenceNumber] = useState('');
  const [transferProofDataUrl, setTransferProofDataUrl] = useState('');
  const [uploadingProof, setUploadingProof] = useState(false);
  const [principalAmount, setPrincipalAmount] = useState('');
  const [adminFee, setAdminFee] = useState('5000');
  const [bankFee, setBankFee] = useState('0');
  const [manualFeeTouched, setManualFeeTouched] = useState(false);
  const [feeOverrideReason, setFeeOverrideReason] = useState('');
  const [cashAccountId, setCashAccountId] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [manualBankAccountTouched, setManualBankAccountTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // History Filters & Modals
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'tarik_tunai_qris' | MiniAtmServiceType>('all');
  const [historyCashierUid, setHistoryCashierUid] = useState('all');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [receiptTx, setReceiptTx] = useState<MiniAtmTransaction | null>(null);
  const [receiptPrintNotice, setReceiptPrintNotice] = useState<string | null>(null);
  const [receiptCopied, setReceiptCopied] = useState(false);
  const [proofModalTx, setProofModalTx] = useState<MiniAtmTransaction | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // Admin Report Filters
  const todayDate = getTodayDateString();
  const [reportPeriodType, setReportPeriodType] = useState<MiniAtmReportPeriodType>('daily');
  const [reportAnchorDate, setReportAnchorDate] = useState(todayDate);
  const [reportAnchorMonth, setReportAnchorMonth] = useState(todayDate.slice(0, 7));
  const [reportAnchorYear, setReportAnchorYear] = useState(todayDate.slice(0, 4));
  const [reportStartDate, setReportStartDate] = useState(`${todayDate.slice(0, 7)}-01`);
  const [reportEndDate, setReportEndDate] = useState(todayDate);
  const [reportCashierUid, setReportCashierUid] = useState('all');
  const [reportServiceFilter, setReportServiceFilter] = useState<
    'all' | 'tarik_tunai_qris' | 'tarik_tunai' | 'transfer' | 'setor_tunai'
  >('all');

  const submitLockRef = useRef(false);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);
  const cashCandidates = useMemo(() => {
    const cash = activeAccounts.filter((a) => a.type === 'cash');
    return cash.length > 0 ? cash : activeAccounts;
  }, [activeAccounts]);
  const bankCandidates = useMemo(() => {
    const banks = activeAccounts.filter((a) => a.type === 'bank' || a.type === 'ewallet');
    return banks.length > 0 ? banks : activeAccounts;
  }, [activeAccounts]);
  const qrisCandidates = useMemo(() => {
    const qrisFirst = activeAccounts.filter(
      (a) =>
        a.id !== cashAccountId &&
        (a.type === 'ewallet' ||
          a.name.toLowerCase().includes('qris') ||
          a.name.toLowerCase().includes('dana'))
    );
    if (qrisFirst.length > 0) return qrisFirst;
    const banks = bankCandidates.filter((a) => a.id !== cashAccountId);
    return banks.length > 0 ? banks : activeAccounts;
  }, [activeAccounts, bankCandidates, cashAccountId]);

  useEffect(() => {
    if (!cashAccountId && cashCandidates.length > 0) {
      setCashAccountId(cashCandidates[0].id);
    }
  }, [cashCandidates, cashAccountId]);

  useEffect(() => {
    if (manualBankAccountTouched && bankAccountId) return;
    if (serviceType === 'tarik_tunai' && paymentChannel === 'qris') {
      if (qrisCandidates.length > 0) {
        setBankAccountId(qrisCandidates[0].id);
      }
      return;
    }
    const pureBanks = bankCandidates.filter((a) => a.id !== cashAccountId && a.type === 'bank');
    const fallback = bankCandidates.find((a) => a.id !== cashAccountId) || bankCandidates[0];
    if (pureBanks.length > 0) {
      setBankAccountId(pureBanks[0].id);
    } else if (fallback) {
      setBankAccountId(fallback.id);
    }
  }, [
    bankCandidates,
    qrisCandidates,
    bankAccountId,
    cashAccountId,
    serviceType,
    paymentChannel,
    manualBankAccountTouched,
  ]);

  // Subscribe transactions, settings, and fee audits
  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const unsubTx = subscribeMiniAtmTransactions(
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

    const unsubSettings = subscribeMiniAtmSettings(
      (cfg) => {
        setMiniAtmSettings(cfg);
        setSettingsDraft(cfg);
      },
      (err) => {
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
      }
    );

    const unsubAudits = isAdmin
      ? subscribeMiniAtmFeeAudits(
          true,
          user.uid,
          (rows) => setFeeAudits(rows),
          () => {
            // Silent fallback if index/rules pending
          }
        )
      : (() => {
          setFeeAudits([]);
          return () => {};
        })();

    return () => {
      unsubTx();
      unsubSettings();
      unsubAudits();
    };
  }, [isAdmin, user]);

  // Sinkronkan kanal pembayaran Tarik Tunai (default QRIS jika diizinkan Admin)
  useEffect(() => {
    if (serviceType !== 'tarik_tunai' || !miniAtmSettings.allowQrisTarikTunai) {
      setPaymentChannel('bank_transfer');
      setQrisVerified(false);
    }
  }, [serviceType, miniAtmSettings.allowQrisTarikTunai]);

  // Resolve standard fees automatically based on nominal, service, & bank
  const standardFeeInfo = useMemo(() => {
    return resolveMiniAtmStandardFees({
      serviceType,
      bankName,
      principalAmount: Number(principalAmount) || 0,
      settings: miniAtmSettings,
    });
  }, [serviceType, bankName, principalAmount, miniAtmSettings]);

  // Auto-sync standard fee into form unless Cashier/Admin manually overrode for current tx
  useEffect(() => {
    if (!manualFeeTouched) {
      setAdminFee(String(standardFeeInfo.standardAdminFee));
      setBankFee(String(standardFeeInfo.standardBankFee));
    }
  }, [standardFeeInfo, manualFeeTouched]);

  const appliedAdminFee = Math.max(0, Number(adminFee) || 0);
  const appliedBankFee = Math.max(0, Number(bankFee) || 0);
  const isFeeOverridden =
    Math.abs(appliedAdminFee - standardFeeInfo.standardAdminFee) > 0.009 ||
    Math.abs(appliedBankFee - standardFeeInfo.standardBankFee) > 0.009;

  const selectedCashAccount = activeAccounts.find((a) => a.id === cashAccountId) || null;
  const selectedBankAccount = activeAccounts.find((a) => a.id === bankAccountId) || null;

  // Preview breakdown (note: for live UI calculation before verification checkbox, show expected numbers)
  const previewBreakdown = useMemo(() => {
    const p = Number(principalAmount) || 0;
    if (p <= 0) return null;
    try {
      return calculateMiniAtmBreakdown({
        serviceType,
        paymentChannel,
        allowQrisTarikTunai: true,
        qrisVerified: true,
        qrisMdrRate: miniAtmSettings.qrisMdrPercent,
        qrisInternalExtraThreshold: miniAtmSettings.qrisInternalExtraThreshold,
        qrisInternalExtraFee: miniAtmSettings.qrisInternalExtraFee,
        principalAmount: p,
        adminFee: appliedAdminFee,
        bankFee: appliedBankFee,
      });
    } catch {
      return null;
    }
  }, [serviceType, paymentChannel, miniAtmSettings, principalAmount, appliedAdminFee, appliedBankFee]);

  const todayStats = useMemo(() => {
    const rows = transactions.filter(
      (t) => t.status === 'completed' && t.transactionDate === todayDate
    );
    return {
      count: rows.length,
      volume: rows.reduce((sum, r) => sum + (Number(r.principalAmount) || 0), 0),
      adminTotal: rows.reduce((sum, r) => sum + (Number(r.adminFee) || 0), 0),
      profitTotal: rows.reduce((sum, r) => sum + (Number(r.netProfit) || 0), 0),
    };
  }, [transactions, todayDate]);

  const hasLegacySetor = useMemo(
    () => transactions.some((t) => t.serviceType === 'setor_tunai'),
    [transactions]
  );

  const cashierOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const tx of transactions) {
      if (tx.recordedByUid) {
        map.set(tx.recordedByUid, tx.recordedByName || 'Kasir');
      }
    }
    return Array.from(map.entries()).map(([uid, name]) => ({ uid, name }));
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter((t) => {
      if (filterType === 'tarik_tunai_qris') {
        if (t.serviceType !== 'tarik_tunai' || t.paymentChannel !== 'qris') return false;
      } else if (filterType !== 'all' && t.serviceType !== filterType) {
        return false;
      }
      if (isAdmin && historyCashierUid !== 'all' && t.recordedByUid !== historyCashierUid) {
        return false;
      }
      if (!q) return true;
      return (
        t.transactionNumber.toLowerCase().includes(q) ||
        t.bankName.toLowerCase().includes(q) ||
        (t.customerName || '').toLowerCase().includes(q) ||
        (t.targetAccountNumber || '').toLowerCase().includes(q) ||
        (t.externalReferenceNumber || '').toLowerCase().includes(q)
      );
    });
  }, [transactions, searchQuery, filterType, isAdmin, historyCashierUid]);

  const adminReport = useMemo(() => {
    return buildMiniAtmReport(transactions, {
      periodType: reportPeriodType,
      anchorDate: reportAnchorDate,
      anchorMonth: reportAnchorMonth,
      anchorYear: reportAnchorYear,
      startDate: reportStartDate,
      endDate: reportEndDate,
      cashierUid: reportCashierUid,
      serviceFilter: reportServiceFilter,
    });
  }, [
    transactions,
    reportPeriodType,
    reportAnchorDate,
    reportAnchorMonth,
    reportAnchorYear,
    reportStartDate,
    reportEndDate,
    reportCashierUid,
    reportServiceFilter,
  ]);

  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accounts) map.set(acc.id, acc.name);
    return map;
  }, [accounts]);

  const handleProofUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingProof(true);
    setFeedback(null);
    try {
      const compressed = await compressImageFile(file);
      setTransferProofDataUrl(compressed);
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Gagal memproses gambar bukti transfer.',
      });
    } finally {
      setUploadingProof(false);
      e.target.value = '';
    }
  };

  const resetFormFeesToStandard = () => {
    setManualFeeTouched(false);
    setAdminFee(String(standardFeeInfo.standardAdminFee));
    setBankFee(String(standardFeeInfo.standardBankFee));
    setFeeOverrideReason('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || submitLockRef.current) return;
    setFeedback(null);

    if (!selectedCashAccount || !selectedBankAccount) {
      setFeedback({
        kind: 'err',
        text: 'Akun Laci Kas dan Rekening Bank wajib tersedia dan aktif terlebih dahulu.',
      });
      return;
    }

    if (selectedCashAccount.id === selectedBankAccount.id) {
      setFeedback({
        kind: 'err',
        text: 'Akun Laci Kas dan Rekening Bank tidak boleh sama.',
      });
      return;
    }

    if (serviceType === 'tarik_tunai' && paymentChannel === 'qris') {
      if (!miniAtmSettings.allowQrisTarikTunai) {
        setFeedback({
          kind: 'err',
          text: 'Fitur QRIS Tarik Tunai belum diaktifkan oleh Admin (memerlukan izin resmi penyedia QRIS).',
        });
        return;
      }
      if (!qrisVerified) {
        setFeedback({
          kind: 'err',
          text: 'Verifikasi pembayaran QRIS pada aplikasi Merchant QRIS resmi wajib dicentang sebelum uang tunai diberikan.',
        });
        return;
      }
    }

    if (serviceType === 'transfer' && !transferVerified) {
      setFeedback({
        kind: 'err',
        text: 'Konfirmasi verifikasi transfer berhasil wajib dicentang sebelum menyelesaikan transaksi Transfer Bank.',
      });
      return;
    }

    submitLockRef.current = true;
    setSaving(true);

    try {
      const result = await recordMiniAtmTransaction(
        {
          serviceType,
          paymentChannel: serviceType === 'tarik_tunai' ? paymentChannel : 'bank_transfer',
          allowQrisTarikTunai: miniAtmSettings.allowQrisTarikTunai,
          qrisVerified: serviceType === 'tarik_tunai' && paymentChannel === 'qris' ? qrisVerified : false,
          transferVerified: serviceType === 'transfer' ? transferVerified : false,
          qrisMdrRate: miniAtmSettings.qrisMdrPercent,
          qrisInternalExtraThreshold: miniAtmSettings.qrisInternalExtraThreshold,
          qrisInternalExtraFee: miniAtmSettings.qrisInternalExtraFee,
          bankName,
          targetAccountNumber,
          customerName,
          externalReferenceNumber,
          transferProofDataUrl,
          principalAmount: Number(principalAmount) || 0,
          adminFee: appliedAdminFee,
          bankFee: appliedBankFee,
          standardAdminFee: standardFeeInfo.standardAdminFee,
          standardBankFee: standardFeeInfo.standardBankFee,
          feeOverrideReason: isFeeOverridden ? feeOverrideReason : '',
          cashAccount: selectedCashAccount,
          bankAccount: selectedBankAccount,
          notes,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Kasir',
        }
      );

      setFeedback({
        kind: 'ok',
        text: isAdmin
          ? `Transaksi Mini ATM ${result.transactionNumber} berhasil dicatat. Laba bersih: ${formatRupiah(
              result.netProfit
            )}.`
          : `Transaksi Mini ATM ${result.transactionNumber} berhasil dicatat.`,
      });
      setPrincipalAmount('');
      setTargetAccountNumber('');
      setCustomerName('');
      setExternalReferenceNumber('');
      setTransferProofDataUrl('');
      setNotes('');
      setQrisVerified(false);
      setTransferVerified(false);
      setManualFeeTouched(false);
      setFeeOverrideReason('');
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSaving(false);
      submitLockRef.current = false;
    }
  };

  const handleVoid = async (txDoc: MiniAtmTransaction) => {
    if (!user || !isAdmin || voidingId) return;
    setFeedback(null);
    setVoidingId(txDoc.id);
    try {
      await voidMiniAtmTransaction(txDoc, accounts, {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Admin',
      });
      setFeedback({
        kind: 'ok',
        text: `Transaksi ${txDoc.transactionNumber} berhasil dibatalkan (Void) dan saldo kas/bank telah dikembalikan.`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setVoidingId(null);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin || savingSettings) return;
    setFeedback(null);
    setSavingSettings(true);
    try {
      await saveMiniAtmSettings(settingsDraft, {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Admin',
      });
      setFeedback({
        kind: 'ok',
        text: 'Pengaturan tarif Mini ATM & kebijakan QRIS berhasil disimpan. Transaksi lama tetap menggunakan tarif historisnya.',
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSavingSettings(false);
    }
  };

  const addTierRow = () => {
    const newTier: MiniAtmFeeTier = {
      id: generateSafeId('tier'),
      serviceScope: 'all',
      minAmount: 0,
      maxAmount: 0,
      adminFee: 5000,
    };
    setSettingsDraft((prev) => ({
      ...prev,
      feeTiers: [...prev.feeTiers, newTier],
    }));
  };

  const updateTierRow = (index: number, patch: Partial<MiniAtmFeeTier>) => {
    setSettingsDraft((prev) => ({
      ...prev,
      feeTiers: prev.feeTiers.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    }));
  };

  const removeTierRow = (index: number) => {
    setSettingsDraft((prev) => ({
      ...prev,
      feeTiers: prev.feeTiers.filter((_, i) => i !== index),
    }));
  };

  const addBankRule = () => {
    const name = newBankNameInput.trim();
    if (!name) return;
    const fee = Math.max(0, Number(newBankFeeInput) || 0);
    setSettingsDraft((prev) => {
      const existsIdx = prev.bankFeeRules.findIndex(
        (r) => r.bankName.trim().toLowerCase() === name.toLowerCase()
      );
      if (existsIdx >= 0) {
        return {
          ...prev,
          bankFeeRules: prev.bankFeeRules.map((r, idx) =>
            idx === existsIdx ? { bankName: name, defaultBankFee: fee } : r
          ),
        };
      }
      return {
        ...prev,
        bankFeeRules: [...prev.bankFeeRules, { bankName: name, defaultBankFee: fee }],
      };
    });
    setNewBankNameInput('');
    setNewBankFeeInput('2500');
  };

  const cashierFilterLabel =
    reportCashierUid === 'all'
      ? 'Semua Kasir'
      : cashierOptions.find((c) => c.uid === reportCashierUid)?.name || reportCashierUid;

  const bankChipsForMenu =
    serviceType === 'transfer'
      ? settingsDraft.bankFeeRules.length > 0
        ? settingsDraft.bankFeeRules.map((r) => r.bankName).slice(0, 10)
        : COMMON_MINI_ATM_BANKS.slice(0, 10)
      : COMMON_MINI_ATM_BANKS.slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Header & Navigasi Sub-Menu Internal Mini ATM */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Landmark className="w-5 h-5 text-emerald-700" />
            <h2 className="font-display font-bold text-lg text-slate-900">
              Mini ATM KEDAI KHANXA
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            Layanan Tarik Tunai &amp; Transfer Bank dengan tarif bertingkat, opsi QRIS terverifikasi,
            mutasi kas/rekening otomatis, dan log audit tarif.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isOnline && (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 font-medium mr-2">
              <WifiOff className="w-3.5 h-3.5" />
              <span>Offline</span>
            </span>
          )}
          {hasPendingWrites && (
            <span className="text-xs text-amber-700 font-medium mr-2">Menyinkronkan...</span>
          )}

          <div className="flex flex-wrap gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              type="button"
              onClick={() => setActiveTab('transaksi')}
              className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                activeTab === 'transaksi'
                  ? 'bg-white text-emerald-800 shadow-sm border border-slate-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              <span>Transaksi</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('riwayat')}
              className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                activeTab === 'riwayat'
                  ? 'bg-white text-emerald-800 shadow-sm border border-slate-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Riwayat</span>
            </button>
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setActiveTab('laporan')}
                  className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                    activeTab === 'laporan'
                      ? 'bg-white text-emerald-800 shadow-sm border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                  <span>Laporan Mini ATM</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('pengaturan')}
                  className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                    activeTab === 'pengaturan'
                      ? 'bg-white text-emerald-800 shadow-sm border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>Pengaturan &amp; Audit</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Strip Ringkasan Hari Ini */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Transaksi Hari Ini (Toko)</div>
          <div className="font-mono-num text-xl font-bold text-slate-900">
            {todayStats.count} Transaksi
          </div>
          <div className="text-[11px] text-slate-400">Tarik Tunai &amp; Transfer Bank</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Volume Pokok Hari Ini</div>
          <div className="font-mono-num text-xl font-bold text-slate-900">
            {formatRupiah(todayStats.volume)}
          </div>
          <div className="text-[11px] text-slate-400">Pokok layanan (bukan omzet/laba)</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Total Biaya Jasa Warung</div>
          <div className="font-mono-num text-xl font-bold text-slate-900">
            {formatRupiah(todayStats.adminTotal)}
          </div>
          <div className="text-[11px] text-slate-400">Sebelum biaya bank &amp; MDR QRIS</div>
        </div>
        {isAdmin ? (
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
            <div className="text-xs text-slate-500">Laba Bersih Mini ATM</div>
            <div className="font-mono-num text-xl font-bold text-emerald-700">
              {formatRupiah(todayStats.profitTotal)}
            </div>
            <div className="text-[11px] text-slate-400">Jasa + Tamb. Internal - Bank - MDR QRIS</div>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
            <div className="text-xs text-slate-500">Status Layanan QRIS Tarik Tunai</div>
            <div
              className={`text-sm font-bold ${
                miniAtmSettings.allowQrisTarikTunai ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {miniAtmSettings.allowQrisTarikTunai
                ? `Aktif (MDR ${miniAtmSettings.qrisMdrPercent}%)`
                : 'Belum Diaktifkan Admin'}
            </div>
            <div className="text-[11px] text-slate-400">Izin resmi penyedia QRIS</div>
          </div>
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

      {activeAccounts.length < 2 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800 flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Minimal 2 Akun Aktif Diperlukan</div>
            <p className="text-xs mt-0.5">
              Transaksi Mini ATM memerlukan 1 akun <strong>Laci Kas</strong> dan 1 akun{' '}
              <strong>Rekening Bank / E-Wallet</strong> yang berbeda. Hubungi Admin untuk membuat
              akun di menu Kas &amp; Rekening.
            </p>
          </div>
        </div>
      )}

      {/* TAB 1: TRANSAKSI */}
      {activeTab === 'transaksi' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Catat Transaksi Mini ATM Baru
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Menu layanan aktif hanya <strong>Tarik Tunai</strong> dan{' '}
                <strong>Transfer Bank</strong>.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Pilihan Layanan: HANYA Tarik Tunai & Transfer Bank */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">Jenis Layanan</label>
                <div className="grid grid-cols-2 gap-2.5">
                  {MINI_ATM_SERVICE_OPTIONS.map((opt) => {
                    const selected = serviceType === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setServiceType(opt.id);
                          setManualFeeTouched(false);
                          setManualBankAccountTouched(false);
                          setFeeOverrideReason('');
                          setQrisVerified(false);
                          setTransferVerified(false);
                          if (opt.id === 'tarik_tunai' && miniAtmSettings.allowQrisTarikTunai) {
                            setPaymentChannel('qris');
                            setBankName('QRIS Merchant');
                          } else {
                            setPaymentChannel('bank_transfer');
                            setBankName('BRI');
                          }
                        }}
                        className={`min-h-[44px] px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                          selected
                            ? 'bg-emerald-700 border-emerald-700 text-white'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-500">
                  {MINI_ATM_SERVICE_OPTIONS.find((o) => o.id === serviceType)?.shortDesc}
                </p>
              </div>

              {/* Kanal Bayar Tarik Tunai (QRIS Warung 0.3% vs Kartu/Transfer Bank) */}
              {serviceType === 'tarik_tunai' && (
                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-700">
                      Metode Pembayaran Pelanggan
                    </span>
                    <span className="text-[11px] text-slate-500">
                      MDR QRIS: {miniAtmSettings.qrisMdrPercent}%
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={!miniAtmSettings.allowQrisTarikTunai}
                      onClick={() => {
                        setPaymentChannel('qris');
                        setManualBankAccountTouched(false);
                        setBankName('QRIS Merchant');
                      }}
                      className={`min-h-[40px] px-2.5 py-1.5 rounded-lg border text-xs font-semibold inline-flex items-center justify-center gap-1.5 ${
                        !miniAtmSettings.allowQrisTarikTunai
                          ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
                          : paymentChannel === 'qris'
                          ? 'bg-white border-emerald-600 text-emerald-800 shadow-sm cursor-pointer'
                          : 'bg-white/60 border-slate-200 text-slate-600 hover:bg-white cursor-pointer'
                      }`}
                    >
                      <QrCode className="w-3.5 h-3.5" />
                      <span>QRIS Warung</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPaymentChannel('bank_transfer');
                        setManualBankAccountTouched(false);
                        setQrisVerified(false);
                        if (bankName.toLowerCase().includes('qris')) setBankName('BRI');
                      }}
                      className={`min-h-[40px] px-2.5 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer ${
                        paymentChannel === 'bank_transfer'
                          ? 'bg-white border-emerald-600 text-emerald-800 shadow-sm'
                          : 'bg-white/60 border-slate-200 text-slate-600 hover:bg-white'
                      }`}
                    >
                      Kartu / Transfer Bank
                    </button>
                  </div>

                  {!miniAtmSettings.allowQrisTarikTunai && (
                    <p className="text-[11px] text-amber-700">
                      QRIS Tarik Tunai dinonaktifkan Admin. Aktifkan di Pengaturan &amp; Audit
                      sesuai ketentuan penyedia QRIS resmi.
                    </p>
                  )}

                  {paymentChannel === 'qris' && miniAtmSettings.allowQrisTarikTunai && (
                    <div className="space-y-2 pt-1 border-t border-slate-200">
                      <div className="text-[11px] text-slate-600 space-y-0.5">
                        <div>
                          • MDR QRIS ({miniAtmSettings.qrisMdrPercent}%) adalah biaya merchant. Jika
                          MDR &gt; {formatRupiah(miniAtmSettings.qrisInternalExtraThreshold)},{' '}
                          <strong>biaya tambahan internal</strong> sebesar{' '}
                          <strong className="font-mono-num">
                            {formatRupiah(miniAtmSettings.qrisInternalExtraFee)}
                          </strong>{' '}
                          <strong>dipotong dari saldo yang di-QRIS-kan</strong> (mengurangi tunai
                          diterima pelanggan, bukan memotong laba).
                        </div>
                        {previewBreakdown && previewBreakdown.qrisMdrAmount > 0 && (
                          <div>
                            • Estimasi MDR QRIS:{' '}
                            <strong className="font-mono-num">
                              {formatRupiah(previewBreakdown.qrisMdrAmount)}
                            </strong>
                            {previewBreakdown.internalExtraFee > 0 && (
                              <span className="text-emerald-800">
                                {' '}
                                (Potongan internal{' '}
                                <strong className="font-mono-num">
                                  -{formatRupiah(previewBreakdown.internalExtraFee)}
                                </strong>{' '}
                                dari saldo QRIS → tunai diberikan{' '}
                                <strong className="font-mono-num">
                                  {formatRupiah(previewBreakdown.customerTotal)}
                                </strong>
                                )
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <label className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-900 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={qrisVerified}
                          onChange={(e) => setQrisVerified(e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-emerald-400 text-emerald-700 focus:ring-emerald-600"
                        />
                        <span>
                          <strong>Verifikasi QRIS Resmi:</strong> Dana QRIS sudah dicek langsung dan{' '}
                          <u>benar-benar masuk</u> di aplikasi penyedia QRIS sebelum uang tunai
                          diberikan ke pelanggan.
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              )}

              {/* Bank Tujuan / Asal */}
              <div className="space-y-1.5">
                <label htmlFor="atm-bank" className="block text-xs font-medium text-slate-700">
                  {serviceType === 'transfer' ? 'Bank Tujuan Transfer *' : 'Bank / Penyedia Kartu *'}
                </label>
                <input
                  id="atm-bank"
                  type="text"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  required
                  maxLength={60}
                  placeholder={
                    serviceType === 'tarik_tunai' && paymentChannel === 'qris'
                      ? 'Contoh: QRIS DANA / QRIS BCA / QRIS Merchant'
                      : 'Contoh: BRI, BCA, Mandiri, DANA'
                  }
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {bankChipsForMenu.map((b) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => setBankName(b)}
                      className={`px-2 py-1 rounded text-[11px] font-medium border cursor-pointer ${
                        bankName.toLowerCase() === b.toLowerCase()
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                          : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </div>

              {/* Rekening Tujuan & Nama Penerima */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="atm-target" className="block text-xs font-medium text-slate-700">
                    {serviceType === 'transfer'
                      ? 'No. Rekening Tujuan *'
                      : 'No. Kartu / Referensi (Opsional)'}
                  </label>
                  <input
                    id="atm-target"
                    type="text"
                    value={targetAccountNumber}
                    onChange={(e) => setTargetAccountNumber(e.target.value)}
                    required={serviceType === 'transfer'}
                    maxLength={40}
                    placeholder="Contoh: 12340100..."
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="atm-cust" className="block text-xs font-medium text-slate-700">
                    {serviceType === 'transfer' ? 'Nama Penerima *' : 'Nama Pelanggan (Opsional)'}
                  </label>
                  <input
                    id="atm-cust"
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    required={serviceType === 'transfer'}
                    maxLength={100}
                    placeholder={
                      serviceType === 'transfer' ? 'Nama pemilik rekening tujuan' : 'Nama pelanggan'
                    }
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              </div>

              {/* Nominal Pokok */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="atm-principal"
                    className="block text-xs font-medium text-slate-700"
                  >
                    {serviceType === 'tarik_tunai'
                      ? 'Nominal Penarikan (Rp) *'
                      : 'Nominal Transfer (Rp) *'}
                  </label>
                  <span className="text-[11px] text-emerald-700 font-medium">
                    {standardFeeInfo.matchedTierLabel}
                  </span>
                </div>
                <input
                  id="atm-principal"
                  type="number"
                  min="1"
                  step="any"
                  value={principalAmount}
                  onChange={(e) => setPrincipalAmount(e.target.value)}
                  required
                  placeholder="Contoh: 500000"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              {/* Biaya Jasa Warung & Biaya Bank (Dapat diubah kasir khusus transaksi ini) */}
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label
                      htmlFor="atm-admin-fee"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Biaya Jasa Warung (Rp)
                    </label>
                    <input
                      id="atm-admin-fee"
                      type="number"
                      min="0"
                      step="any"
                      value={adminFee}
                      onChange={(e) => {
                        setManualFeeTouched(true);
                        setAdminFee(e.target.value);
                      }}
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                    <div className="text-[11px] text-slate-500">
                      Standar: {formatRupiah(standardFeeInfo.standardAdminFee)}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="atm-bank-fee"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Biaya Bank / Antarbank (Rp)
                    </label>
                    <input
                      id="atm-bank-fee"
                      type="number"
                      min="0"
                      step="any"
                      value={bankFee}
                      onChange={(e) => {
                        setManualFeeTouched(true);
                        setBankFee(e.target.value);
                      }}
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                    <div className="text-[11px] text-slate-500">
                      Standar: {formatRupiah(standardFeeInfo.standardBankFee)}
                    </div>
                  </div>
                </div>

                {isFeeOverridden && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2 text-xs text-amber-900">
                      <span>
                        <strong>Tarif Diubah Manual</strong> khusus transaksi ini (tarif standar
                        tetap). Dicatat atas nama <strong>{profile?.displayName || 'Kasir'}</strong>.
                      </span>
                      <button
                        type="button"
                        onClick={resetFormFeesToStandard}
                        className="shrink-0 underline font-semibold text-amber-800 cursor-pointer"
                      >
                        Reset
                      </button>
                    </div>
                    <input
                      type="text"
                      value={feeOverrideReason}
                      onChange={(e) => setFeeOverrideReason(e.target.value)}
                      maxLength={200}
                      placeholder="Catatan alasan ubah tarif (opsional, misal: pelanggan tetap)"
                      className="w-full min-h-[38px] px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-xs focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                )}
              </div>

              {/* Nomor Referensi & Bukti Transfer (Khusus Transfer atau QRIS RRN) */}
              <div className="space-y-2">
                <div className="space-y-1">
                  <label htmlFor="atm-ext-ref" className="block text-xs font-medium text-slate-700">
                    {serviceType === 'transfer'
                      ? 'Nomor Referensi Transfer (Opsional)'
                      : 'No. Referensi / RRN QRIS atau EDC (Opsional)'}
                  </label>
                  <input
                    id="atm-ext-ref"
                    type="text"
                    value={externalReferenceNumber}
                    onChange={(e) => setExternalReferenceNumber(e.target.value)}
                    maxLength={80}
                    placeholder="Contoh: REF-20261114-0091 / RRN"
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700">
                    {serviceType === 'transfer'
                      ? 'Bukti Transfer (Opsional)'
                      : 'Arsip Foto / Screenshot Bukti (Opsional, Bukan Verifikasi Otomatis)'}
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 text-xs font-medium text-slate-700 cursor-pointer">
                      <Upload className="w-3.5 h-3.5" />
                      <span>
                        {uploadingProof
                          ? 'Mengompres...'
                          : transferProofDataUrl
                          ? 'Ganti Foto Bukti'
                          : 'Unggah Foto Bukti'}
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleProofUpload}
                        className="hidden"
                      />
                    </label>
                    {transferProofDataUrl && (
                      <button
                        type="button"
                        onClick={() => setTransferProofDataUrl('')}
                        className="min-h-[40px] px-2.5 py-1 rounded-lg border border-red-200 text-xs text-red-700 hover:bg-red-50 cursor-pointer"
                      >
                        Hapus Bukti
                      </button>
                    )}
                  </div>
                  {transferProofDataUrl && (
                    <img
                      src={transferProofDataUrl}
                      alt="Pratinjau bukti transaksi"
                      className="h-24 w-auto rounded-lg border border-slate-200 object-cover"
                    />
                  )}
                </div>

                {serviceType === 'transfer' && (
                  <label className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={transferVerified}
                      onChange={(e) => setTransferVerified(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-emerald-400 text-emerald-700 focus:ring-emerald-600"
                    />
                    <span>
                      <strong>Verifikasi Transfer Berhasil:</strong> Transfer dari rekening sumber
                      dana warung ke rekening tujuan sudah dicek dan <u>berhasil terkirim</u>.
                    </span>
                  </label>
                )}
              </div>

              {/* Pilihan Akun Laci Kas & Rekening Sumber/QRIS */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="atm-cash-acc" className="block text-xs font-medium text-slate-700">
                    Akun Laci Kas *
                  </label>
                  <select
                    id="atm-cash-acc"
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

                <div className="space-y-1">
                  <label htmlFor="atm-bank-acc" className="block text-xs font-medium text-slate-700">
                    {serviceType === 'transfer'
                      ? 'Rekening Sumber Dana Warung *'
                      : paymentChannel === 'qris'
                      ? 'Akun Penerima Dana QRIS (Neto) *'
                      : 'Rekening Bank Agen *'}
                  </label>
                  <select
                    id="atm-bank-acc"
                    value={bankAccountId}
                    onChange={(e) => {
                      setManualBankAccountTouched(true);
                      setBankAccountId(e.target.value);
                    }}
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

              <div className="space-y-1">
                <label htmlFor="atm-notes" className="block text-xs font-medium text-slate-700">
                  Catatan (Opsional)
                </label>
                <input
                  id="atm-notes"
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={240}
                  placeholder="Keterangan tambahan bila ada"
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              {/* Ringkasan Kalkulasi Real-Time */}
              {previewBreakdown && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2 text-xs">
                  {serviceType === 'tarik_tunai' && previewBreakdown.internalExtraFee > 0 && (
                    <>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-600">Saldo yang Di-QRIS-kan</span>
                        <span className="font-mono-num font-semibold text-slate-900">
                          {formatRupiah(previewBreakdown.principalAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-emerald-800">
                        <span>Potongan Biaya Internal (dari Saldo QRIS)</span>
                        <span className="font-mono-num font-semibold">
                          -{formatRupiah(previewBreakdown.internalExtraFee)}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">
                      {serviceType === 'tarik_tunai'
                        ? 'Uang Diberikan ke Pelanggan'
                        : 'Total Dibayar Pelanggan'}
                    </span>
                    <span className="font-mono-num font-bold text-sm text-slate-900">
                      {formatRupiah(previewBreakdown.customerTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">Biaya Jasa Warung</span>
                    <span className="font-mono-num font-semibold text-slate-900">
                      {formatRupiah(previewBreakdown.adminFee)}
                    </span>
                  </div>

                  {isAdmin && (
                    <>
                      <div className="pt-1 border-t border-slate-200 flex justify-between items-center">
                        <span className="text-slate-600">
                          Mutasi {selectedCashAccount?.name || 'Laci Kas'}
                        </span>
                        <span
                          className={`font-mono-num font-semibold ${
                            previewBreakdown.cashDelta >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {previewBreakdown.cashDelta >= 0 ? '+' : '-'}
                          {formatRupiah(Math.abs(previewBreakdown.cashDelta))}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-600">
                          Mutasi {selectedBankAccount?.name || 'Rekening Bank'}
                        </span>
                        <span
                          className={`font-mono-num font-semibold ${
                            previewBreakdown.bankDelta >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {previewBreakdown.bankDelta >= 0 ? '+' : '-'}
                          {formatRupiah(Math.abs(previewBreakdown.bankDelta))}
                        </span>
                      </div>
                      {previewBreakdown.qrisMdrAmount > 0 && (
                        <div className="flex justify-between items-center text-amber-800">
                          <span>MDR QRIS Merchant ({previewBreakdown.qrisMdrRate}%)</span>
                          <span className="font-mono-num font-semibold">
                            -{formatRupiah(previewBreakdown.qrisMdrAmount)}
                          </span>
                        </div>
                      )}
                      <div className="pt-2 border-t border-slate-200 flex justify-between items-center">
                        <span className="font-semibold text-slate-800">Laba Bersih Mini ATM</span>
                        <span
                          className={`font-mono-num text-sm font-bold ${
                            previewBreakdown.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {formatRupiah(previewBreakdown.netProfit)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={saving || activeAccounts.length < 2}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60 transition-colors cursor-pointer"
              >
                <span>{saving ? 'Menyimpan Transaksi...' : 'Simpan Transaksi Mini ATM'}</span>
              </button>
            </form>
          </section>

          {/* Ringkasan Riwayat Cepat */}
          <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Transaksi Mini ATM Terbaru
                </h3>
                <p className="text-xs text-slate-500">
                  {isAdmin
                    ? 'Seluruh transaksi toko (Tarik Tunai & Transfer Bank).'
                    : 'Hanya menampilkan transaksi yang Anda catat.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(['all', 'tarik_tunai_qris', 'tarik_tunai', 'transfer'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFilterType(t)}
                    className={`min-h-[34px] px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer ${
                      filterType === t
                        ? 'bg-emerald-700 border-emerald-700 text-white'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {t === 'all'
                      ? 'Semua'
                      : t === 'tarik_tunai_qris'
                      ? 'Tarik Tunai QRIS'
                      : t === 'tarik_tunai'
                      ? 'Tarik Tunai'
                      : 'Transfer Bank'}
                  </button>
                ))}
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
                Belum ada transaksi Mini ATM yang sesuai filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 whitespace-nowrap">No. Trx &amp; Waktu</th>
                      <th className="py-3 px-4 whitespace-nowrap">Layanan &amp; Tujuan</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Nominal</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">
                        {isAdmin ? 'Jasa / Laba' : 'Biaya Jasa'}
                      </th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredTransactions.slice(0, 20).map((tx) => {
                      const isVoid = tx.status === 'void';
                      return (
                        <tr key={tx.id} className={`hover:bg-slate-50 ${isVoid ? 'opacity-60' : ''}`}>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <div className="font-mono-num text-xs font-semibold text-slate-900">
                              {tx.transactionNumber}
                            </div>
                            <div className="font-mono-num text-[11px] text-slate-500">
                              {tx.transactionDate} · {tx.transactionTime}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="inline-flex items-center gap-1.5 font-medium text-slate-900 text-xs">
                              {tx.serviceType === 'tarik_tunai' ? (
                                <ArrowUpRight className="w-3.5 h-3.5 text-red-600 shrink-0" />
                              ) : (
                                <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                              )}
                              <span>
                                {getMiniAtmServiceLabel(tx.serviceType)} · {tx.bankName}
                              </span>
                              {tx.paymentChannel === 'qris' && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-[10px] font-semibold text-emerald-800">
                                  QRIS
                                </span>
                              )}
                              {tx.feeOverridden && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-[10px] font-semibold text-amber-800">
                                  Tarif Manual
                                </span>
                              )}
                            </div>
                            {(tx.customerName || tx.targetAccountNumber) && (
                              <div className="text-[11px] text-slate-500 truncate max-w-[220px]">
                                {tx.customerName || ''}
                                {tx.customerName && tx.targetAccountNumber ? ' · ' : ''}
                                {tx.targetAccountNumber || ''}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                            {formatRupiah(tx.principalAmount)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num whitespace-nowrap">
                            <div className="text-xs text-slate-700">
                              Jasa {formatRupiah(tx.adminFee)}
                            </div>
                            {isAdmin && (
                              <div className="text-[11px] font-semibold text-emerald-700">
                                Laba {formatRupiah(tx.netProfit)}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              {tx.transferProofDataUrl && (
                                <button
                                  type="button"
                                  onClick={() => setProofModalTx(tx)}
                                  className="min-h-[34px] inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 text-xs text-slate-700 hover:bg-slate-100 cursor-pointer"
                                  title="Lihat bukti transfer"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setReceiptTx(tx)}
                                className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                              >
                                <Receipt className="w-3.5 h-3.5" />
                                <span>Struk</span>
                              </button>
                              {isAdmin && !isVoid && (
                                <button
                                  type="button"
                                  disabled={voidingId === tx.id}
                                  onClick={() => handleVoid(tx)}
                                  className="min-h-[34px] inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                                  title="Batalkan transaksi & balikkan saldo"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
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
          </section>
        </div>
      )}

      {/* TAB 2: RIWAYAT LENGKAP (TERPISAH TARIK TUNAI & TRANSFER BANK) */}
      {activeTab === 'riwayat' && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Riwayat Transaksi Mini ATM
              </h3>
              <p className="text-xs text-slate-500">
                {isAdmin
                  ? 'Pisahkan riwayat Tarik Tunai dan Transfer Bank, periksa bukti transfer, dan filter per kasir.'
                  : 'Menampilkan riwayat Tarik Tunai & Transfer Bank toko (tersinkronisasi real-time Admin & Kasir).'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari no. trx / bank / penerima / ref..."
                  className="min-h-[40px] pl-9 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs w-56 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <select
                value={filterType}
                onChange={(e) =>
                  setFilterType(
                    e.target.value as 'all' | 'tarik_tunai_qris' | MiniAtmServiceType
                  )
                }
                aria-label="Filter jenis layanan Mini ATM"
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="all">Semua Layanan</option>
                <option value="tarik_tunai_qris">Riwayat Tarik Tunai QRIS</option>
                <option value="tarik_tunai">Tarik Tunai (Semua)</option>
                <option value="transfer">Riwayat Transfer Bank</option>
                {hasLegacySetor && <option value="setor_tunai">Setor Tunai (Arsip Lama)</option>}
              </select>

              {isAdmin && (
                <select
                  value={historyCashierUid}
                  onChange={(e) => setHistoryCashierUid(e.target.value)}
                  aria-label="Filter kasir"
                  className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  <option value="all">Semua Kasir</option>
                  {cashierOptions.map((c) => (
                    <option key={c.uid} value={c.uid}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {filteredTransactions.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Tidak ada transaksi yang cocok dengan pencarian atau filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">No. Trx &amp; Waktu</th>
                    <th className="py-3 px-4 whitespace-nowrap">Layanan &amp; Kanal</th>
                    <th className="py-3 px-4 whitespace-nowrap">Tujuan / Penerima / Ref</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Nominal</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Jasa &amp; Potongan</th>
                    {isAdmin && (
                      <th className="py-3 px-4 text-right whitespace-nowrap">Laba Bersih</th>
                    )}
                    <th className="py-3 px-4 whitespace-nowrap">Petugas</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredTransactions.map((tx) => {
                    const isVoid = tx.status === 'void';
                    return (
                      <tr key={tx.id} className={`hover:bg-slate-50 ${isVoid ? 'opacity-60' : ''}`}>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono-num text-xs font-semibold text-slate-900">
                            {tx.transactionNumber}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {tx.transactionDate} · {tx.transactionTime}
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="text-xs font-semibold text-slate-900">
                            {getMiniAtmServiceLabel(tx.serviceType)} · {tx.bankName}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {tx.paymentChannel === 'qris' && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-[10px] font-semibold text-emerald-800">
                                QRIS ({tx.qrisMdrRate ?? 0.3}%)
                              </span>
                            )}
                            {tx.feeOverridden && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-[10px] font-semibold text-amber-800">
                                Tarif Diubah
                              </span>
                            )}
                            {isVoid && (
                              <span className="px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-[10px] font-semibold text-red-700">
                                Void
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600">
                          <div>{tx.customerName || '-'}</div>
                          {tx.targetAccountNumber && (
                            <div className="font-mono-num text-[11px] text-slate-500">
                              Rek: {tx.targetAccountNumber}
                            </div>
                          )}
                          {tx.externalReferenceNumber && (
                            <div className="font-mono-num text-[11px] text-slate-500">
                              Ref: {tx.externalReferenceNumber}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                          {formatRupiah(tx.principalAmount)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-xs whitespace-nowrap">
                          <div className="text-slate-800">
                            Jasa {formatRupiah(tx.adminFee)}
                            {(tx.internalExtraFee || 0) > 0 && (
                              <span className="text-emerald-700">
                                {' '}
                                + {formatRupiah(tx.internalExtraFee || 0)}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Bank {formatRupiah(tx.bankFee)}
                            {(tx.qrisMdrAmount || 0) > 0 &&
                              ` · MDR ${formatRupiah(tx.qrisMdrAmount || 0)}`}
                          </div>
                        </td>
                        {isAdmin && (
                          <td className="py-3 px-4 text-right font-mono-num font-bold text-emerald-700 whitespace-nowrap">
                            {formatRupiah(tx.netProfit)}
                          </td>
                        )}
                        <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                          {tx.recordedByName}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            {tx.transferProofDataUrl && (
                              <button
                                type="button"
                                onClick={() => setProofModalTx(tx)}
                                className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs text-slate-700 hover:bg-slate-100 cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>Bukti</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setReceiptTx(tx)}
                              className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                            >
                              <Receipt className="w-3.5 h-3.5" />
                              <span>Struk</span>
                            </button>
                            {isAdmin && !isVoid && (
                              <button
                                type="button"
                                disabled={voidingId === tx.id}
                                onClick={() => handleVoid(tx)}
                                className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Void</span>
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
        </section>
      )}

      {/* TAB 3: LAPORAN MINI ATM (KHUSUS ADMIN) */}
      {activeTab === 'laporan' && isAdmin && (
        <div className="space-y-5">
          {/* Filter Bar Laporan */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Laporan Lengkap Mini ATM
                </h3>
                <p className="text-xs text-slate-500">
                  Rekap Harian, Bulanan, Tahunan, dan filter kasir dengan pemisahan Jasa Warung,
                  Tambahan Pelanggan (&gt;Rp500), Biaya Bank, dan MDR QRIS.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
                >
                  <Printer className="w-4 h-4" />
                  <span>Cetak</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    exportMiniAtmReportExcel(
                      storeSetting?.storeName || 'KEDAI KHANXA',
                      adminReport,
                      cashierFilterLabel
                    )
                  }
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  <span>Ekspor Excel</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    exportMiniAtmReportPdf(
                      storeSetting?.storeName || 'KEDAI KHANXA',
                      adminReport,
                      cashierFilterLabel
                    )
                  }
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
                >
                  <FileText className="w-4 h-4" />
                  <span>Unduh PDF</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="space-y-1">
                <label className="block text-[11px] font-medium text-slate-600">Periode</label>
                <select
                  value={reportPeriodType}
                  onChange={(e) => setReportPeriodType(e.target.value as MiniAtmReportPeriodType)}
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                >
                  <option value="daily">Harian</option>
                  <option value="monthly">Bulanan</option>
                  <option value="yearly">Tahunan</option>
                  <option value="range">Rentang Tanggal</option>
                </select>
              </div>

              {reportPeriodType === 'daily' && (
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-600">Tanggal</label>
                  <input
                    type="date"
                    value={reportAnchorDate}
                    onChange={(e) => setReportAnchorDate(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs"
                  />
                </div>
              )}

              {reportPeriodType === 'monthly' && (
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-600">Bulan</label>
                  <input
                    type="month"
                    value={reportAnchorMonth}
                    onChange={(e) => setReportAnchorMonth(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs"
                  />
                </div>
              )}

              {reportPeriodType === 'yearly' && (
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-600">Tahun</label>
                  <input
                    type="number"
                    min="2020"
                    max="2099"
                    value={reportAnchorYear}
                    onChange={(e) => setReportAnchorYear(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num"
                  />
                </div>
              )}

              {reportPeriodType === 'range' && (
                <>
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Dari Tanggal
                    </label>
                    <input
                      type="date"
                      value={reportStartDate}
                      onChange={(e) => setReportStartDate(e.target.value)}
                      className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Sampai Tanggal
                    </label>
                    <input
                      type="date"
                      value={reportEndDate}
                      onChange={(e) => setReportEndDate(e.target.value)}
                      className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs"
                    />
                  </div>
                </>
              )}

              <div className="space-y-1">
                <label className="block text-[11px] font-medium text-slate-600">Filter Kasir</label>
                <select
                  value={reportCashierUid}
                  onChange={(e) => setReportCashierUid(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                >
                  <option value="all">Semua Kasir</option>
                  {cashierOptions.map((c) => (
                    <option key={c.uid} value={c.uid}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] font-medium text-slate-600">
                  Jenis Layanan
                </label>
                <select
                  value={reportServiceFilter}
                  onChange={(e) =>
                    setReportServiceFilter(
                      e.target.value as
                        | 'all'
                        | 'tarik_tunai_qris'
                        | 'tarik_tunai'
                        | 'transfer'
                        | 'setor_tunai'
                    )
                  }
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                >
                  <option value="all">Semua Layanan</option>
                  <option value="tarik_tunai_qris">Tarik Tunai QRIS</option>
                  <option value="tarik_tunai">Tarik Tunai (Semua)</option>
                  <option value="transfer">Transfer Bank</option>
                  {hasLegacySetor && <option value="setor_tunai">Setor Tunai (Arsip)</option>}
                </select>
              </div>
            </div>
          </div>

          {/* KPI Laporan */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
              <div className="text-xs text-slate-500">Total Nominal Transaksi</div>
              <div className="font-mono-num text-lg font-bold text-slate-900">
                {formatRupiah(adminReport.summary.totalNominal)}
              </div>
              <div className="text-[11px] text-slate-400">
                {adminReport.summary.totalCount} trx (Tarik: {adminReport.summary.tarikTunaiCount},
                Transfer: {adminReport.summary.transferCount})
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
              <div className="text-xs text-slate-500">Total Biaya Jasa</div>
              <div className="font-mono-num text-lg font-bold text-slate-900">
                {formatRupiah(adminReport.summary.totalAdminFee)}
              </div>
              <div className="text-[11px] text-slate-400">Pendapatan jasa bruto warung</div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
              <div className="text-xs text-slate-500">Total Biaya Bank</div>
              <div className="font-mono-num text-lg font-bold text-red-700">
                {formatRupiah(adminReport.summary.totalBankFee)}
              </div>
              <div className="text-[11px] text-slate-400">Admin transfer/antarbank</div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
              <div className="text-xs text-slate-500">MDR QRIS Merchant</div>
              <div className="font-mono-num text-lg font-bold text-amber-700">
                {formatRupiah(adminReport.summary.totalQrisMdr)}
              </div>
              <div className="text-[11px] text-emerald-700">
                + Tamb. Pelanggan (&gt;Rp500): {formatRupiah(adminReport.summary.totalInternalExtraFee)}
              </div>
            </div>

            <div className="bg-white border border-emerald-200 bg-emerald-50/40 rounded-xl p-4 space-y-1">
              <div className="text-xs font-medium text-emerald-800">Keuntungan Bersih</div>
              <div className="font-mono-num text-lg font-bold text-emerald-700">
                {formatRupiah(adminReport.summary.totalNetProfit)}
              </div>
              <div className="text-[11px] text-emerald-700/80">{adminReport.periodLabel}</div>
            </div>
          </div>

          {/* Tabel Rekap Per Kasir */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200">
              <h4 className="font-display font-semibold text-sm text-slate-900">
                Rekap Mini ATM per Kasir ({adminReport.periodLabel})
              </h4>
            </div>
            {adminReport.cashierBreakdown.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Belum ada transaksi selesai pada periode ini.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Kasir</th>
                      <th className="py-3 px-4 text-right">Trx</th>
                      <th className="py-3 px-4 text-right">Nominal Pokok</th>
                      <th className="py-3 px-4 text-right">Biaya Jasa</th>
                      <th className="py-3 px-4 text-right">+Tamb (&gt;Rp500)</th>
                      <th className="py-3 px-4 text-right">Biaya Bank</th>
                      <th className="py-3 px-4 text-right">MDR QRIS</th>
                      <th className="py-3 px-4 text-right">Laba Bersih</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {adminReport.cashierBreakdown.map((c) => (
                      <tr key={c.uid} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-semibold text-slate-900">{c.name}</td>
                        <td className="py-3 px-4 text-right font-mono-num">{c.count}</td>
                        <td className="py-3 px-4 text-right font-mono-num">
                          {formatRupiah(c.totalNominal)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num">
                          {formatRupiah(c.totalAdminFee)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-emerald-700">
                          +{formatRupiah(c.totalInternalExtraFee)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-red-700">
                          {formatRupiah(c.totalBankFee)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-amber-700">
                          {formatRupiah(c.totalQrisMdr)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-bold text-emerald-700">
                          {formatRupiah(c.totalNetProfit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Rincian Transaksi Periode Laporan */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <h4 className="font-display font-semibold text-sm text-slate-900">
                Rincian Transaksi Mini ATM ({adminReport.rows.length} transaksi)
              </h4>
              <span className="text-xs text-slate-500">{adminReport.periodLabel}</span>
            </div>
            {adminReport.rows.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Tidak ada transaksi selesai pada filter laporan ini.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                      <th className="py-2.5 px-4 whitespace-nowrap">Tanggal &amp; No. Trx</th>
                      <th className="py-2.5 px-4 whitespace-nowrap">Layanan</th>
                      <th className="py-2.5 px-4 whitespace-nowrap">Kasir</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Nominal Pokok</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Jasa + Tamb.</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Biaya Bank</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">MDR QRIS</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Laba Bersih</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {adminReport.rows.map((tx) => (
                      <tr key={tx.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="font-mono-num font-semibold text-slate-900">
                            {tx.transactionNumber}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {tx.transactionDate} · {tx.transactionTime}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          {getMiniAtmServiceLabel(tx.serviceType)} · {tx.bankName}
                          {tx.paymentChannel === 'qris' ? ' (QRIS)' : ''}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap text-slate-700">
                          {tx.recordedByName}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono-num whitespace-nowrap">
                          {formatRupiah(tx.principalAmount)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono-num whitespace-nowrap">
                          <div>{formatRupiah(tx.adminFee + (tx.internalExtraFee || 0))}</div>
                          {(tx.internalExtraFee || 0) > 0 && (
                            <div className="text-[10px] text-emerald-700">
                              (+Tamb {formatRupiah(tx.internalExtraFee || 0)})
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono-num text-red-700 whitespace-nowrap">
                          {formatRupiah(tx.bankFee)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono-num text-amber-700 whitespace-nowrap">
                          {formatRupiah(tx.qrisMdrAmount || 0)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono-num font-bold text-emerald-700 whitespace-nowrap">
                          {formatRupiah(tx.netProfit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: PENGATURAN TARIF & LOG AUDIT (KHUSUS ADMIN) */}
      {activeTab === 'pengaturan' && isAdmin && (
        <div className="space-y-6">
          <form
            onSubmit={handleSaveSettings}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-6"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Pengaturan Tarif Mini ATM &amp; Kebijakan QRIS
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Perubahan tarif standar hanya berlaku untuk transaksi baru. Transaksi lama tetap
                  mempertahankan tarif pada saat transaksi dibuat.
                </p>
              </div>
              <button
                type="submit"
                disabled={savingSettings}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 disabled:opacity-60 cursor-pointer shrink-0"
              >
                {savingSettings ? 'Menyimpan...' : 'Simpan Pengaturan Mini ATM'}
              </button>
            </div>

            {/* Kebijakan QRIS Tarik Tunai */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <ShieldCheck className="w-4 h-4 text-emerald-700" />
                    <span>Kebijakan QRIS untuk Tarik Tunai</span>
                  </div>
                  <p className="text-xs text-slate-600">
                    Aktifkan fitur QRIS Tarik Tunai hanya jika penyedia QRIS resmi mengizinkan
                    transaksi penarikan tunai. Jika MDR QRIS melebihi batas, biaya tambahan internal
                    dipotong langsung dari saldo yang di-QRIS-kan pelanggan (tidak memotong laba
                    warung).
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={settingsDraft.allowQrisTarikTunai}
                    onChange={(e) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        allowQrisTarikTunai: e.target.checked,
                      }))
                    }
                    className="h-5 w-5 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                  />
                  <span className="text-xs font-semibold text-slate-800">
                    {settingsDraft.allowQrisTarikTunai ? 'Diizinkan' : 'Nonaktif'}
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-700">
                    Tarif MDR QRIS (%)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    step="0.01"
                    value={settingsDraft.qrisMdrPercent}
                    onChange={(e) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        qrisMdrPercent: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono-num"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-700">
                    Batas MDR Internal (Rp)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={settingsDraft.qrisInternalExtraThreshold}
                    onChange={(e) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        qrisInternalExtraThreshold: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono-num"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-700">
                    Biaya Internal (Potong Saldo QRIS Jika MDR &gt; Batas) (Rp)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={settingsDraft.qrisInternalExtraFee}
                    onChange={(e) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        qrisInternalExtraFee: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono-num"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] font-medium text-slate-700">
                  Catatan Izin Penyedia QRIS (Opsional)
                </label>
                <input
                  type="text"
                  maxLength={200}
                  value={settingsDraft.qrisProviderNote || ''}
                  onChange={(e) =>
                    setSettingsDraft((prev) => ({ ...prev, qrisProviderNote: e.target.value }))
                  }
                  placeholder="Contoh: Diizinkan oleh penyedia QRIS merchant resmi per..."
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs"
                />
              </div>
            </div>

            {/* Tingkatan Biaya Jasa Berdasarkan Nominal */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="font-semibold text-sm text-slate-900">
                    Biaya Jasa Warung Bertingkat (Tier Nominal)
                  </h4>
                  <p className="text-xs text-slate-500">
                    Isi Batas Atas <strong>0</strong> untuk menyatakan tanpa batas maksimal.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addTierRow}
                  className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Tambah Tier</span>
                </button>
              </div>

              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <th className="py-2.5 px-3">Layanan</th>
                      <th className="py-2.5 px-3">Nominal Min (Rp)</th>
                      <th className="py-2.5 px-3">Nominal Max (Rp)</th>
                      <th className="py-2.5 px-3">Biaya Jasa (Rp)</th>
                      <th className="py-2.5 px-3 text-right">Hapus</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {settingsDraft.feeTiers.map((tier, idx) => (
                      <tr key={tier.id || idx}>
                        <td className="py-2 px-3">
                          <select
                            value={tier.serviceScope}
                            onChange={(e) =>
                              updateTierRow(idx, {
                                serviceScope: e.target.value as MiniAtmFeeTier['serviceScope'],
                              })
                            }
                            className="min-h-[36px] px-2 py-1 rounded border border-slate-300 bg-white text-xs"
                          >
                            <option value="all">Semua Layanan</option>
                            <option value="tarik_tunai">Tarik Tunai</option>
                            <option value="transfer">Transfer Bank</option>
                          </select>
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="number"
                            min="0"
                            value={tier.minAmount}
                            onChange={(e) =>
                              updateTierRow(idx, { minAmount: Math.max(0, Number(e.target.value) || 0) })
                            }
                            className="w-32 min-h-[36px] px-2 py-1 rounded border border-slate-300 font-mono-num"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="number"
                            min="0"
                            value={tier.maxAmount}
                            onChange={(e) =>
                              updateTierRow(idx, { maxAmount: Math.max(0, Number(e.target.value) || 0) })
                            }
                            className="w-32 min-h-[36px] px-2 py-1 rounded border border-slate-300 font-mono-num"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="number"
                            min="0"
                            value={tier.adminFee}
                            onChange={(e) =>
                              updateTierRow(idx, { adminFee: Math.max(0, Number(e.target.value) || 0) })
                            }
                            className="w-28 min-h-[36px] px-2 py-1 rounded border border-slate-300 font-mono-num font-semibold"
                          />
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => removeTierRow(idx)}
                            className="p-1.5 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                            aria-label="Hapus tier"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pengaturan Biaya Bank Berdasarkan Bank Tujuan */}
            <div className="space-y-3">
              <div>
                <h4 className="font-semibold text-sm text-slate-900">
                  Biaya Bank Berdasarkan Bank Tujuan (Transfer Bank)
                </h4>
                <p className="text-xs text-slate-500">
                  Biaya bank terisi otomatis saat memilih bank tujuan pada menu Transfer Bank.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={newBankNameInput}
                  onChange={(e) => setNewBankNameInput(e.target.value)}
                  placeholder="Nama bank / e-wallet (mis. CIMB)"
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs w-52"
                />
                <input
                  type="number"
                  min="0"
                  value={newBankFeeInput}
                  onChange={(e) => setNewBankFeeInput(e.target.value)}
                  placeholder="Biaya bank (Rp)"
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num w-32"
                />
                <button
                  type="button"
                  onClick={addBankRule}
                  className="min-h-[38px] inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-slate-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Tambah / Perbarui Bank</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {settingsDraft.bankFeeRules.map((rule, idx) => (
                  <div
                    key={`${rule.bankName}-${idx}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 bg-slate-50"
                  >
                    <span className="text-xs font-semibold text-slate-800 truncate">
                      {rule.bankName}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="0"
                        value={rule.defaultBankFee}
                        onChange={(e) => {
                          const val = Math.max(0, Number(e.target.value) || 0);
                          setSettingsDraft((prev) => ({
                            ...prev,
                            bankFeeRules: prev.bankFeeRules.map((r, i) =>
                              i === idx ? { ...r, defaultBankFee: val } : r
                            ),
                          }));
                        }}
                        className="w-24 min-h-[32px] px-2 py-1 rounded border border-slate-300 bg-white text-xs font-mono-num text-right"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSettingsDraft((prev) => ({
                            ...prev,
                            bankFeeRules: prev.bankFeeRules.filter((_, i) => i !== idx),
                          }))
                        }
                        className="p-1 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                        aria-label={`Hapus ${rule.bankName}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </form>

          {/* Log Audit Perubahan Tarif oleh Kasir / Admin */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Log Audit Perubahan Tarif per Transaksi
              </h3>
              <p className="text-xs text-slate-500">
                Mencatat setiap perubahan biaya jasa atau biaya bank oleh kasir/admin saat transaksi
                berlangsung (tarif standar tidak ikut berubah).
              </p>
            </div>
            {feeAudits.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Belum ada perubahan tarif manual yang tercatat.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                      <th className="py-3 px-4 whitespace-nowrap">Waktu &amp; No. Trx</th>
                      <th className="py-3 px-4 whitespace-nowrap">Pengguna</th>
                      <th className="py-3 px-4 whitespace-nowrap">Layanan &amp; Nominal</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Jasa (Awal → Baru)</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Bank (Awal → Baru)</th>
                      <th className="py-3 px-4">Keterangan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {feeAudits.map((a) => (
                      <tr key={a.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono-num font-semibold text-slate-900">
                            {a.transactionNumber}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {a.transactionDate} · {a.transactionTime}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-semibold text-slate-900 whitespace-nowrap">
                          {a.recordedByName}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div>
                            {getMiniAtmServiceLabel(a.serviceType)} · {a.bankName}
                          </div>
                          <div className="font-mono-num text-[11px] text-slate-500">
                            {formatRupiah(a.principalAmount)}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num whitespace-nowrap">
                          <span className="text-slate-500">{formatRupiah(a.standardAdminFee)}</span>
                          <span className="mx-1 text-slate-400">→</span>
                          <span className="font-bold text-amber-800">
                            {formatRupiah(a.appliedAdminFee)}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num whitespace-nowrap">
                          <span className="text-slate-500">{formatRupiah(a.standardBankFee)}</span>
                          <span className="mx-1 text-slate-400">→</span>
                          <span className="font-bold text-amber-800">
                            {formatRupiah(a.appliedBankFee)}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-600">{a.reason || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Bukti Transfer */}
      {proofModalTx && proofModalTx.transferProofDataUrl && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h4 className="font-display font-bold text-sm text-slate-900">
                  Bukti Transfer {proofModalTx.transactionNumber}
                </h4>
                <p className="text-xs text-slate-500">
                  {proofModalTx.bankName} · {proofModalTx.customerName || '-'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setProofModalTx(null)}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <img
              src={proofModalTx.transferProofDataUrl}
              alt="Bukti transfer Mini ATM"
              className="w-full max-h-96 object-contain rounded-lg border border-slate-200"
            />
            {proofModalTx.externalReferenceNumber && (
              <div className="text-xs text-slate-600">
                No. Referensi Bank:{' '}
                <strong className="font-mono-num">{proofModalTx.externalReferenceNumber}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Struk Mini ATM */}
      {receiptTx && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h4 className="font-display font-bold text-base text-slate-900">
                  {storeSetting?.storeName || 'KEDAI KHANXA'}
                </h4>
                <p className="text-xs text-slate-500">Bukti Layanan Mini ATM</p>
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
                <span className="text-slate-500">No. Transaksi</span>
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
                <span className="text-slate-500">Layanan</span>
                <span className="font-semibold text-slate-900">
                  {getMiniAtmServiceLabel(receiptTx.serviceType)} · {receiptTx.bankName}
                  {receiptTx.paymentChannel === 'qris' ? ' (QRIS)' : ''}
                </span>
              </div>
              {receiptTx.targetAccountNumber && (
                <div className="flex justify-between">
                  <span className="text-slate-500">No. Rekening / Tujuan</span>
                  <span className="font-mono-num text-slate-900">
                    {receiptTx.targetAccountNumber}
                  </span>
                </div>
              )}
              {receiptTx.customerName && (
                <div className="flex justify-between">
                  <span className="text-slate-500">
                    {receiptTx.serviceType === 'transfer' ? 'Penerima' : 'Pelanggan'}
                  </span>
                  <span className="text-slate-900">{receiptTx.customerName}</span>
                </div>
              )}
              {receiptTx.externalReferenceNumber && (
                <div className="flex justify-between">
                  <span className="text-slate-500">No. Referensi Bank</span>
                  <span className="font-mono-num text-slate-900">
                    {receiptTx.externalReferenceNumber}
                  </span>
                </div>
              )}
              <div className="pt-2 border-t border-slate-200 flex justify-between">
                <span className="text-slate-600">
                  {receiptTx.serviceType === 'tarik_tunai' && receiptTx.paymentChannel === 'qris'
                    ? 'Saldo yang Di-QRIS-kan'
                    : 'Nominal Pokok'}
                </span>
                <span className="font-mono-num font-semibold text-slate-900">
                  {formatRupiah(receiptTx.principalAmount)}
                </span>
              </div>
              {(receiptTx.internalExtraFee || 0) > 0 && (
                <div className="flex justify-between text-amber-800">
                  <span>Potongan Biaya Internal (dari Saldo QRIS)</span>
                  <span className="font-mono-num font-semibold">
                    -{formatRupiah(receiptTx.internalExtraFee || 0)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-600">Biaya Jasa Warung</span>
                <span className="font-mono-num text-slate-900">
                  {formatRupiah(receiptTx.adminFee)}
                </span>
              </div>
              <div className="flex justify-between text-sm font-bold text-emerald-700 pt-1 border-t border-slate-200">
                <span>
                  {receiptTx.serviceType === 'tarik_tunai'
                    ? 'Tunai Diterima Pelanggan'
                    : 'Total Dibayar Pelanggan'}
                </span>
                <span className="font-mono-num">
                  {formatRupiah(
                    receiptTx.serviceType === 'tarik_tunai'
                      ? Math.max(0, receiptTx.principalAmount - (receiptTx.internalExtraFee || 0))
                      : receiptTx.principalAmount + receiptTx.adminFee
                  )}
                </span>
              </div>
              {isAdmin && (receiptTx.qrisMdrAmount || 0) > 0 && (
                <div className="pt-1 text-[11px] text-amber-800 flex justify-between">
                  <span>Potongan MDR QRIS Merchant</span>
                  <span className="font-mono-num">
                    -{formatRupiah(receiptTx.qrisMdrAmount || 0)}
                  </span>
                </div>
              )}
              <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500 space-y-0.5">
                <div>
                  Kas: {accountNameMap.get(receiptTx.cashAccountId) || receiptTx.cashAccountId} ·
                  Rek: {accountNameMap.get(receiptTx.bankAccountId) || receiptTx.bankAccountId}
                </div>
                <div>Petugas: {receiptTx.recordedByName}</div>
                {receiptTx.notes && <div>Catatan: {receiptTx.notes}</div>}
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
                  const text = formatMiniAtmReceiptText(receiptTx, storeSetting);
                  const outcome = await printThermalReceiptText(text, {
                    title: `Struk Mini ATM ${receiptTx.transactionNumber}`,
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
                    formatMiniAtmReceiptText(receiptTx, storeSetting),
                    `Struk_MiniATM_${receiptTx.transactionNumber}`,
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
                  const text = formatMiniAtmReceiptText(receiptTx, storeSetting);
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
                href={buildRawBtThermalUrl(formatMiniAtmReceiptText(receiptTx, storeSetting))}
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
