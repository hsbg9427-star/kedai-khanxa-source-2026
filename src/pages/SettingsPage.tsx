import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Database,
  Download,
  FileText,
  History,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import { firebaseProjectInfo } from '../firebase';
import type {
  HppMethod,
  ResetAuditLog,
  ResetOptionType,
  StoreSetting,
} from '../types/database';
import { saveStoreSettings } from '../services/warungService';
import {
  RESET_CONFIRMATION_PHRASE,
  RESET_OPTIONS_META,
  computeOptionTargetCount,
  executeDataReset,
  exportOperationalBackup,
  fetchResetTargetCounts,
  subscribeResetLogs,
  triggerDownloadJson,
  type ResetExecutionResult,
  type ResetOptionMeta,
  type ResetTargetCounts,
} from '../services/resetService';
import type { RecordedSaleReceipt } from '../services/inventoryService';
import { getReadableFirestoreError } from '../utils/firestoreError';
import { DEFAULT_QRIS_FEE_PERCENT, getEffectiveQrisFeePercent } from '../utils/qrisFee';
import { formatQty, formatRupiah } from '../utils/formatters';
import { formatPosReceiptText, formatWhatsAppReceiptMessage } from '../utils/posReceipt';

interface SettingsPageProps {
  storeSetting: StoreSetting | null;
}

export function SettingsPage({ storeSetting }: SettingsPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline, firestoreStatus, offlinePersistenceEnabled, recheckConnection } = useNetwork();

  // 1. Pengaturan Identitas Kedai
  const [storeName, setStoreName] = useState(storeSetting?.storeName || 'KEDAI KHANXA');
  const [ownerName, setOwnerName] = useState(
    storeSetting?.ownerName || profile?.displayName || ''
  );
  const [address, setAddress] = useState(storeSetting?.address || '');
  const [phone, setPhone] = useState(storeSetting?.phone || '');
  const [receiptHeader, setReceiptHeader] = useState(storeSetting?.receiptHeader || '');
  const [receiptThankYou, setReceiptThankYou] = useState(
    storeSetting?.receiptThankYou || 'Terima kasih telah berbelanja di KEDAI KHANXA!'
  );
  const [receiptFooter, setReceiptFooter] = useState(
    storeSetting?.receiptFooter || 'Barang yang sudah dibeli tidak dapat ditukar kecuali perjanjian'
  );
  const [qrisFeePercent, setQrisFeePercent] = useState(
    String(getEffectiveQrisFeePercent(storeSetting))
  );
  const [hppMethod, setHppMethod] = useState<HppMethod>(
    storeSetting?.hppMethod === 'fifo' ? 'fifo' : 'moving_average'
  );
  const [dailySalesTarget, setDailySalesTarget] = useState(
    String(storeSetting?.dailySalesTarget ?? 0)
  );

  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Preview Struk Tab (thermal vs whatsapp)
  const [previewTab, setPreviewTab] = useState<'thermal' | 'whatsapp'>('thermal');

  // 2. State Reset Data (Hanya Admin)
  const [targetCounts, setTargetCounts] = useState<ResetTargetCounts | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [selectedOption, setSelectedOption] = useState<ResetOptionMeta | null>(null);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [confirmedRisk, setConfirmedRisk] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [resetResult, setResetResult] = useState<ResetExecutionResult | null>(null);
  const [auditLogs, setAuditLogs] = useState<ResetAuditLog[]>([]);

  useEffect(() => {
    if (storeSetting) {
      setStoreName(storeSetting.storeName);
      setOwnerName(storeSetting.ownerName);
      setAddress(storeSetting.address || '');
      setPhone(storeSetting.phone || '');
      setReceiptHeader(storeSetting.receiptHeader || '');
      setReceiptThankYou(
        storeSetting.receiptThankYou || 'Terima kasih telah berbelanja di KEDAI KHANXA!'
      );
      setReceiptFooter(
        storeSetting.receiptFooter || 'Barang yang sudah dibeli tidak dapat ditukar kecuali perjanjian'
      );
      setQrisFeePercent(String(getEffectiveQrisFeePercent(storeSetting)));
      setHppMethod(storeSetting.hppMethod === 'fifo' ? 'fifo' : 'moving_average');
      setDailySalesTarget(String(storeSetting.dailySalesTarget ?? 0));
    }
  }, [storeSetting]);

  // Muat hitungan data target & log audit jika admin
  const refreshCounts = async () => {
    if (!isAdmin) return;
    setLoadingCounts(true);
    try {
      const counts = await fetchResetTargetCounts();
      setTargetCounts(counts);
    } catch (err) {
      console.warn('Gagal memuat hitungan target reset:', err);
    } finally {
      setLoadingCounts(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      refreshCounts();
      const unsub = subscribeResetLogs(
        (logs) => setAuditLogs(logs),
        (err) => console.warn('Gagal membaca log audit reset:', err)
      );
      return () => unsub();
    }
  }, [isAdmin]);

  const parsedQrisFee = Number(qrisFeePercent.replace(',', '.'));
  const validQrisFee =
    Number.isFinite(parsedQrisFee) && parsedQrisFee >= 0 && parsedQrisFee <= 10
      ? Number(parsedQrisFee.toFixed(4))
      : DEFAULT_QRIS_FEE_PERCENT;
  const exampleQrisFee = Number((100000 * (validQrisFee / 100)).toFixed(2));
  const exampleQrisNet = Number((100000 - exampleQrisFee).toFixed(2));

  // Simulasi Struk untuk Live Preview
  const sampleReceipt: RecordedSaleReceipt = useMemo(
    () => ({
      saleId: 'sim-preview-01',
      transactionNumber: 'TRX-20261114-001',
      transactionDate: '2026-11-14',
      transactionTime: '14:35',
      recordedByName: profile?.displayName || 'Kasir KEDAI KHANXA',
      customerName: 'Bpk. Ahmad (Pelanggan)',
      items: [
        {
          name: 'Rokok Djarum Super',
          unitName: 'Bungkus',
          baseUnit: 'Bungkus',
          conversion: 1,
          baseQuantity: 1,
          priceTier: 'retail',
          quantity: 1,
          unitPrice: 24000,
          subtotal: 24000,
          profit: 3000,
        },
        {
          name: 'Minyak Goreng Bimoli',
          unitName: 'Liter',
          baseUnit: 'Ml',
          conversion: 1000,
          baseQuantity: 1000,
          priceTier: 'retail',
          quantity: 1,
          unitPrice: 18500,
          subtotal: 18500,
          profit: 2000,
        },
      ],
      subtotal: 42500,
      discount: 0,
      totalAmount: 42500,
      totalCost: 37500,
      totalProfit: 5000,
      paidAmount: 50000,
      changeAmount: 7500,
      paymentMethod: 'cash',
      cashPaidPart: 50000,
      qrisAmount: 0,
      qrisFeeRate: 0,
      qrisFeeAmount: 0,
      debtAmount: 0,
      netReceivedAmount: 42500,
    }),
    [profile?.displayName]
  );

  const previewThermalText = useMemo(() => {
    return formatPosReceiptText(sampleReceipt, {
      storeName: storeName || 'KEDAI KHANXA',
      ownerName,
      address,
      phone,
      receiptHeader,
      receiptThankYou,
      receiptFooter,
    });
  }, [sampleReceipt, storeName, ownerName, address, phone, receiptHeader, receiptThankYou, receiptFooter]);

  const previewWhatsAppText = useMemo(() => {
    return formatWhatsAppReceiptMessage(sampleReceipt, {
      storeName: storeName || 'KEDAI KHANXA',
      ownerName,
      address,
      phone,
      receiptHeader,
      receiptThankYou,
      receiptFooter,
    });
  }, [sampleReceipt, storeName, ownerName, address, phone, receiptHeader, receiptThankYou, receiptFooter]);

  // Simpan Pengaturan Identitas Kedai & Template Struk
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin) return;
    if (!storeName.trim() || !ownerName.trim()) {
      setFeedback({ kind: 'err', text: 'Nama warung dan nama pemilik wajib diisi.' });
      return;
    }
    if (!Number.isFinite(parsedQrisFee) || parsedQrisFee < 0 || parsedQrisFee > 10) {
      setFeedback({
        kind: 'err',
        text: 'Tarif potongan biaya QRIS harus berada di antara 0% sampai 10%.',
      });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      await saveStoreSettings(
        {
          storeName,
          ownerName,
          address,
          phone,
          receiptHeader,
          receiptThankYou,
          receiptFooter,
          qrisFeePercent: validQrisFee,
          hppMethod,
          dailySalesTarget: Math.max(0, Math.round(Number(dailySalesTarget) || 0)),
        },
        user.uid
      );
      setFeedback({
        kind: 'ok',
        text: isOnline
          ? 'Pengaturan kedai & template struk berhasil disimpan ke Cloud Firestore.'
          : 'Pengaturan disimpan lokal (offline) dan akan disinkronkan saat internet tersedia.',
      });
    } catch (error) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
    } finally {
      setSaving(false);
    }
  };

  // Unduh Backup JSON
  const handleDownloadBackup = async (type: ResetOptionType = 'all_operational') => {
    setIsBackingUp(true);
    try {
      const backup = await exportOperationalBackup(type, storeName || 'KEDAI KHANXA');
      triggerDownloadJson(backup.filename, backup.jsonString);
      setFeedback({
        kind: 'ok',
        text: `Cadangan data (${backup.totalItems} dokumen) berhasil diunduh: ${backup.filename}`,
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: `Gagal mencadangkan data: ${getReadableFirestoreError(err)}`,
      });
    } finally {
      setIsBackingUp(false);
    }
  };

  // Buka Modal Konfirmasi Reset
  const handleOpenConfirm = (opt: ResetOptionMeta) => {
    setSelectedOption(opt);
    setConfirmedRisk(false);
    setTypedConfirmation('');
    setIsConfirmModalOpen(true);
  };

  // Eksekusi Reset Data
  const handleExecuteReset = async () => {
    if (!selectedOption || !user || !isAdmin) return;

    if (selectedOption.requiresTypedPhrase) {
      if (typedConfirmation.trim() !== RESET_CONFIRMATION_PHRASE) {
        return;
      }
    } else {
      if (!confirmedRisk) return;
    }

    setIsResetting(true);
    try {
      const result = await executeDataReset({
        resetType: selectedOption.id,
        confirmationPhrase: typedConfirmation.trim(),
        user: {
          uid: user.uid,
          displayName: profile?.displayName || user.email || 'Admin',
        },
        storeName,
      });

      setResetResult(result);
      setIsConfirmModalOpen(false);
      setSelectedOption(null);
      await refreshCounts();
    } catch (err) {
      setResetResult({
        success: false,
        resetType: selectedOption.id,
        resetLabel: selectedOption.title,
        totalDeleted: 0,
        summary: `Terjadi kegagalan proses reset: ${getReadableFirestoreError(err)}`,
        executedAt: new Date().toISOString(),
        errors: [getReadableFirestoreError(err)],
      });
      setIsConfirmModalOpen(false);
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`p-4 rounded-xl border text-sm flex items-start justify-between gap-3 ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <div>{feedback.text}</div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-600 shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Bagian 1 & 2: Identitas Kedai & Template Struk Kustom */}
      <form onSubmit={handleSave} className="space-y-6">
        {/* Identitas Kedai */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="border-b border-slate-100 pb-3">
            <h3 className="font-display font-semibold text-base text-slate-900">
              Identitas &amp; Profil KEDAI KHANXA
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Informasi ini tampil pada header aplikasi, laporan keuangan, dan seluruh struk transaksi.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="st-name" className="block text-xs font-medium text-slate-700">
                Nama Kedai / Usaha
              </label>
              <input
                id="st-name"
                type="text"
                required
                disabled={!isAdmin}
                maxLength={100}
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="st-owner" className="block text-xs font-medium text-slate-700">
                Nama Pemilik
              </label>
              <input
                id="st-owner"
                type="text"
                required
                disabled={!isAdmin}
                maxLength={100}
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="st-phone" className="block text-xs font-medium text-slate-700">
                Nomor HP / WhatsApp
              </label>
              <input
                id="st-phone"
                type="text"
                disabled={!isAdmin}
                maxLength={24}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="08xxxxxxxxxx"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="st-qris-fee" className="block text-xs font-medium text-slate-700">
                Potongan Biaya QRIS (%)
              </label>
              <input
                id="st-qris-fee"
                type="number"
                step="0.01"
                min="0"
                max="10"
                disabled={!isAdmin}
                value={qrisFeePercent}
                onChange={(e) => setQrisFeePercent(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
              <p className="text-[11px] text-slate-500 font-mono-num">
                Tarif standar 0,3%. Simulasi Rp100.000 QRIS ({formatQty(validQrisFee)}%): potongan{' '}
                <strong>{formatRupiah(exampleQrisFee)}</strong> · bersih{' '}
                <strong className="text-emerald-700">{formatRupiah(exampleQrisNet)}</strong>.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="st-hpp-method" className="block text-xs font-medium text-slate-700">
                Metode Perhitungan HPP Laporan
              </label>
              <select
                id="st-hpp-method"
                disabled={!isAdmin}
                value={hppMethod}
                onChange={(e) =>
                  setHppMethod(e.target.value === 'fifo' ? 'fifo' : 'moving_average')
                }
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="moving_average">Moving Average (Rata-Rata Tertimbang)</option>
                <option value="fifo">FIFO (Masuk Pertama Keluar Pertama)</option>
              </select>
              <p className="text-[11px] text-slate-500">
                Dipakai pada Laporan Laba &amp; HPP Barang Terjual. Dapat diganti kapan saja tanpa mengubah data lama.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="st-daily-target" className="block text-xs font-medium text-slate-700">
                Target Penjualan Harian (Rp)
              </label>
              <input
                id="st-daily-target"
                type="number"
                min="0"
                step="50000"
                disabled={!isAdmin}
                value={dailySalesTarget}
                onChange={(e) => setDailySalesTarget(e.target.value)}
                placeholder="1000000"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
              <p className="text-[11px] text-slate-500">
                Ditampilkan sebagai indikator capaian penjualan harian di Dashboard Admin &amp; Kasir.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="st-addr" className="block text-xs font-medium text-slate-700">
                Alamat Lengkap Kedai
              </label>
              <textarea
                id="st-addr"
                rows={2}
                disabled={!isAdmin}
                maxLength={240}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Alamat lengkap KEDAI KHANXA..."
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>
          </div>
        </div>

        {/* Template Struk Kustom KEDAI KHANXA */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="border-b border-slate-100 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900 flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-700" />
                <span>Template Struk Kustom KEDAI KHANXA</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Sesuaikan slogan, ucapan terima kasih, dan catatan penukaran barang untuk cetak struk kasir dan pesan WhatsApp pelanggan.
              </p>
            </div>
            <div className="flex items-center gap-1.5 self-start sm:self-auto bg-slate-100 p-1 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setPreviewTab('thermal')}
                className={`px-3 py-1 rounded-md font-medium transition cursor-pointer ${
                  previewTab === 'thermal'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Struk Termal
              </button>
              <button
                type="button"
                onClick={() => setPreviewTab('whatsapp')}
                className={`px-3 py-1 rounded-md font-medium transition cursor-pointer ${
                  previewTab === 'whatsapp'
                    ? 'bg-white text-emerald-700 shadow-sm'
                    : 'text-slate-600 hover:text-emerald-700'
                }`}
              >
                WhatsApp
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Form Kolom Kiri */}
            <div className="lg:col-span-7 space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="st-header" className="block text-xs font-medium text-slate-700">
                  Header Tambahan / Slogan Struk
                </label>
                <input
                  id="st-header"
                  type="text"
                  disabled={!isAdmin}
                  maxLength={120}
                  value={receiptHeader}
                  onChange={(e) => setReceiptHeader(e.target.value)}
                  placeholder="Contoh: Solusi Kebutuhan Harian & Mini ATM Terpercaya"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <p className="text-[11px] text-slate-500">
                  Tampil tepat di bawah nama kedai pada header struk kasir dan pesan WhatsApp.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="st-thankyou" className="block text-xs font-medium text-slate-700">
                  Pesan Terima Kasih
                </label>
                <input
                  id="st-thankyou"
                  type="text"
                  disabled={!isAdmin}
                  maxLength={120}
                  value={receiptThankYou}
                  onChange={(e) => setReceiptThankYou(e.target.value)}
                  placeholder="Contoh: Terima kasih telah berbelanja di KEDAI KHANXA!"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <p className="text-[11px] text-slate-500">
                  Ucapan terima kasih yang dicetak di bagian bawah rincian pembayaran.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="st-footer" className="block text-xs font-medium text-slate-700">
                  Catatan Kaki Struk / Syarat Penukaran Barang
                </label>
                <textarea
                  id="st-footer"
                  rows={2}
                  disabled={!isAdmin}
                  maxLength={200}
                  value={receiptFooter}
                  onChange={(e) => setReceiptFooter(e.target.value)}
                  placeholder="Contoh: Barang yang sudah dibeli tidak dapat ditukar kecuali perjanjian."
                  className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <p className="text-[11px] text-slate-500">
                  Catatan kaki atau ketentuan retur belanja yang tampil di paling bawah struk.
                </p>
              </div>
            </div>

            {/* Simulasi Tampilan Struk Kanan */}
            <div className="lg:col-span-5 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-700 pb-2 border-b border-slate-200">
                <span className="flex items-center gap-1.5">
                  {previewTab === 'thermal' ? (
                    <FileText className="w-3.5 h-3.5 text-slate-600" />
                  ) : (
                    <Smartphone className="w-3.5 h-3.5 text-emerald-600" />
                  )}
                  {previewTab === 'thermal'
                    ? 'Simulasi Struk Kasir (Kertas 58mm)'
                    : 'Simulasi Format Pesan WhatsApp'}
                </span>
                <span className="text-[10px] text-slate-500 font-normal">Real-Time</span>
              </div>

              {previewTab === 'thermal' ? (
                <pre className="p-3 bg-white border border-slate-300 rounded-lg font-mono text-[11px] leading-tight text-slate-800 whitespace-pre overflow-x-auto shadow-inner max-h-[380px] select-all">
                  {previewThermalText}
                </pre>
              ) : (
                <div className="p-3 bg-emerald-50/60 border border-emerald-200 rounded-lg text-[12px] leading-relaxed text-slate-800 whitespace-pre-wrap overflow-y-auto max-h-[380px]">
                  {previewWhatsAppText}
                </div>
              )}
            </div>
          </div>

          {isAdmin ? (
            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="submit"
                disabled={saving}
                className="min-h-[44px] inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer shadow-sm"
              >
                <Check className="w-4 h-4" />
                <span>{saving ? 'Menyimpan...' : 'Simpan Pengaturan & Template Struk'}</span>
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-500 text-right">
              Hanya Admin yang dapat mengubah identitas dan template struk.
            </p>
          )}
        </div>
      </form>

      {/* Bagian 3: Informasi Koneksi Firebase & Offline */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-emerald-700" />
            <h3 className="font-display font-semibold text-base text-slate-900">
              Koneksi Cloud Firestore &amp; Sinkronisasi
            </h3>
          </div>
          <button
            type="button"
            onClick={recheckConnection}
            className="min-h-[40px] inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Uji Koneksi Server</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="text-slate-500">ID Proyek Firebase</div>
            <div className="font-mono-num font-semibold text-slate-900 break-all">
              {firebaseProjectInfo.projectId}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="text-slate-500">ID Database Firestore</div>
            <div className="font-mono-num font-semibold text-slate-900 break-all">
              {firebaseProjectInfo.databaseId}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="text-slate-500">Status Jaringan</div>
            <div className="font-medium text-slate-900">
              {isOnline ? 'Online' : 'Offline'} · {firestoreStatus === 'connected' ? 'Terhubung' : firestoreStatus}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="text-slate-500">Mode Offline Cache</div>
            <div className="font-medium text-slate-900">
              {offlinePersistenceEnabled ? 'Multi-Tab IndexedDB' : 'Memory Cache'}
            </div>
          </div>
        </div>
      </div>

      {/* Bagian 4: ZONA BAHAYA - RESET DATA KEDAI KHANXA (HANYA ADMIN) */}
      {isAdmin && (
        <div className="bg-white border-2 border-red-200 rounded-xl p-5 sm:p-6 space-y-6">
          {/* Header Zona Bahaya */}
          <div className="border-b border-red-100 pb-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-red-100 border border-red-300 flex items-center justify-center text-red-700 shrink-0">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-base text-red-900 flex items-center gap-2">
                    <span>Zona Bahaya: Reset Data KEDAI KHANXA</span>
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-red-600 text-white">
                      Khusus Admin
                    </span>
                  </h3>
                  <p className="text-xs text-red-700/90 mt-0.5">
                    Fitur pembersihan data transaksi dan operasional untuk memulai pembukuan baru atau menghapus data uji coba.
                  </p>
                </div>
              </div>

              {/* Tombol Backup Global */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={refreshCounts}
                  disabled={loadingCounts}
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingCounts ? 'animate-spin' : ''}`} />
                  <span>{loadingCounts ? 'Menghitung...' : 'Hitung Data'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDownloadBackup('all_operational')}
                  disabled={isBackingUp}
                  className="min-h-[40px] inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{isBackingUp ? 'Menyiapkan...' : 'Unduh Backup JSON'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Banner Perlindungan Data Sistem (DATA AMAN) */}
          <div className="bg-emerald-50/70 border border-emerald-200 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-emerald-900 text-xs font-semibold">
              <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>Data Sistem &amp; Keamanan yang Dilindungi (TIDAK AKAN PERNAH DIHAPUS):</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-[11px] text-emerald-900/90">
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Akun Admin &amp; Kasir (users, staff_invites)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Login, sandi &amp; autentikasi pengguna</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Hak akses &amp; role security rules Firestore</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Konfigurasi aplikasi &amp; identitas kedai</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Pengaturan satuan &amp; kategori produk</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Metode HPP &amp; potongan MDR QRIS</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Struktur akun kas, supplier &amp; database Firestore</span>
              </div>
              <div className="flex items-center gap-1.5 sm:col-span-2">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Seluruh modul aplikasi (Kasir, Produk, Stok Opname, Mini ATM, PPOB, Laporan) tetap utuh</span>
              </div>
            </div>
          </div>

          {/* Ringkasan Dokumen Aktif */}
          {targetCounts && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2">
              <div className="text-xs font-medium text-slate-700 flex items-center justify-between">
                <span>Ringkasan Dokumen Database Saat Ini</span>
                <span className="text-[11px] text-slate-500 font-mono-num">
                  Total Operasional: {computeOptionTargetCount('all_operational', targetCounts)} dokumen
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2 text-center text-xs">
                <div className="bg-white p-2 rounded border border-slate-200">
                  <div className="text-[10px] text-slate-500">Produk</div>
                  <div className="font-mono-num font-bold text-slate-800">{targetCounts.products}</div>
                </div>
                <div className="bg-white p-2 rounded border border-slate-200">
                  <div className="text-[10px] text-slate-500">Penjualan</div>
                  <div className="font-mono-num font-bold text-slate-800">{targetCounts.sales}</div>
                </div>
                <div className="bg-white p-2 rounded border border-slate-200">
                  <div className="text-[10px] text-slate-500">Pembelian</div>
                  <div className="font-mono-num font-bold text-slate-800">{targetCounts.purchases}</div>
                </div>
                <div className="bg-white p-2 rounded border border-slate-200">
                  <div className="text-[10px] text-slate-500">Buku Kas</div>
                  <div className="font-mono-num font-bold text-slate-800">{targetCounts.cash_ledger}</div>
                </div>
                <div className="bg-white p-2 rounded border border-slate-200">
                  <div className="text-[10px] text-slate-500">Pelanggan/Kasbon</div>
                  <div className="font-mono-num font-bold text-slate-800">
                    {targetCounts.customers + targetCounts.receivables}
                  </div>
                </div>
                <div className="bg-white p-2 rounded border border-slate-200">
                  <div className="text-[10px] text-slate-500">Mini ATM</div>
                  <div className="font-mono-num font-bold text-slate-800">{targetCounts.mini_atm_transactions}</div>
                </div>
                <div className="bg-white p-2 rounded border border-slate-200">
                  <div className="text-[10px] text-slate-500">PPOB</div>
                  <div className="font-mono-num font-bold text-slate-800">{targetCounts.ppob_transactions}</div>
                </div>
              </div>
            </div>
          )}

          {/* 9 Pilihan Reset Data */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Pilih Tindakan Reset Data Operasional (9 Pilihan):
            </h4>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {RESET_OPTIONS_META.map((opt) => {
                const targetDocCount = targetCounts
                  ? computeOptionTargetCount(opt.id, targetCounts)
                  : 0;

                const isAllOperational = opt.id === 'all_operational';

                return (
                  <div
                    key={opt.id}
                    className={`rounded-xl border p-4 transition flex flex-col justify-between ${
                      isAllOperational
                        ? 'bg-red-50/80 border-red-300 md:col-span-2'
                        : 'bg-white border-slate-200 hover:border-red-300'
                    }`}
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                              isAllOperational
                                ? 'bg-red-700 text-white'
                                : 'bg-slate-800 text-white'
                            }`}
                          >
                            {opt.number}
                          </span>
                          <h5
                            className={`text-sm font-semibold ${
                              isAllOperational ? 'text-red-950 font-bold' : 'text-slate-900'
                            }`}
                          >
                            {opt.title}
                          </h5>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              opt.dangerBadge === 'Kritis'
                                ? 'bg-red-600 text-white'
                                : 'bg-amber-100 text-amber-800 border border-amber-300'
                            }`}
                          >
                            {opt.dangerBadge}
                          </span>
                        </div>
                      </div>

                      <p className="text-xs text-slate-600 leading-relaxed">
                        {opt.description}
                      </p>

                      <div className="space-y-1 text-[11px] pt-1">
                        <div className="text-red-700 font-medium">
                          Dihapus: <span className="font-normal font-mono-num">{opt.targetCollections.join(', ')}</span>
                        </div>
                        <div className="text-emerald-700 font-medium">
                          Dipertahankan: <span className="font-normal">{opt.safeCollections.join(', ')}</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-3 mt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                      <span className="text-[11px] font-mono-num text-slate-500">
                        Target Dokumen: <strong>{targetDocCount}</strong>
                      </span>

                      <button
                        type="button"
                        onClick={() => handleOpenConfirm(opt)}
                        className={`min-h-[38px] inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition ${
                          isAllOperational
                            ? 'bg-red-700 hover:bg-red-800 text-white shadow-sm'
                            : 'border border-red-300 text-red-700 hover:bg-red-50'
                        }`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Pilih Reset Opsi {opt.number}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Riwayat Log Audit Reset */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700">
                <History className="w-4 h-4 text-slate-600" />
                <span>Riwayat Aktivitas Reset Data KEDAI KHANXA</span>
              </div>
              <span className="text-[11px] text-slate-500 font-mono-num">
                {auditLogs.length} aktivitas tercatat
              </span>
            </div>

            {auditLogs.length === 0 ? (
              <p className="text-xs text-slate-500 py-3 text-center italic">
                Belum ada catatan aktivitas reset data pada aplikasi ini.
              </p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {auditLogs.map((log) => {
                  const dateStr = log.createdAt?.toDate
                    ? log.createdAt.toDate().toLocaleString('id-ID')
                    : 'Baru saja';
                  return (
                    <div
                      key={log.id}
                      className="p-3 bg-white rounded-lg border border-slate-200 text-xs space-y-1"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                        <span className="font-semibold text-slate-900">{log.resetLabel}</span>
                        <span className="text-[10px] text-slate-500 font-mono-num">{dateStr}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-slate-600">
                        <span>
                          Admin: <strong>{log.recordedByName}</strong>
                        </span>
                        <span>•</span>
                        <span className="font-mono-num">
                          Item dihapus/diupdate: <strong>{log.itemsDeletedCount}</strong>
                        </span>
                      </div>
                      {log.details && (
                        <p className="text-[11px] text-slate-500 bg-slate-50 p-1.5 rounded font-mono-num break-words">
                          {log.details}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Konfirmasi Ganda (Step 2 - Konfirmasi Bahaya) */}
      {isConfirmModalOpen && selectedOption && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border-2 border-red-500 max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-2xl animate-in fade-in zoom-in-95">
            {/* Header Modal */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-100 border border-red-300 flex items-center justify-center text-red-600 shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-base text-red-900">
                    Konfirmasi Eksekusi Reset Data
                  </h3>
                  <p className="text-xs text-red-700 font-semibold">{selectedOption.title}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsConfirmModalOpen(false)}
                disabled={isResetting}
                className="text-slate-400 hover:text-slate-600 cursor-pointer p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Peringatan & Daftar Data */}
            <div className="space-y-3 text-xs">
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-900 leading-relaxed">
                <strong>PERINGATAN KERAS:</strong> Tindakan ini bersifat permanen dan tidak dapat dibatalkan.
                {targetCounts && (
                  <span className="font-mono-num block mt-1">
                    Estimasi <strong>{computeOptionTargetCount(selectedOption.id, targetCounts)}</strong>{' '}
                    dokumen akan dihapus dari Cloud Firestore.
                  </span>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="font-semibold text-slate-800">Daftar Data yang AKAN DIHAPUS:</div>
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg font-mono text-[11px] text-red-700 space-y-0.5">
                  {selectedOption.targetCollections.map((col) => (
                    <div key={col}>• Koleksi Firestore: {col}</div>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="font-semibold text-slate-800">Data Sistem yang TETAP AMAN:</div>
                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-[11px] text-emerald-800 space-y-0.5">
                  {selectedOption.safeCollections.map((col) => (
                    <div key={col}>✓ {col}</div>
                  ))}
                </div>
              </div>

              {/* Tombol Backup Sebelum Lanjut */}
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-between gap-2">
                <span className="text-[11px] text-amber-900 font-medium">
                  Disarankan mengunduh cadangan sebelum mengeksekusi reset:
                </span>
                <button
                  type="button"
                  onClick={() => handleDownloadBackup(selectedOption.id)}
                  disabled={isBackingUp || isResetting}
                  className="px-2.5 py-1 bg-white border border-amber-300 rounded text-xs font-semibold text-amber-900 hover:bg-amber-100 shrink-0 cursor-pointer"
                >
                  {isBackingUp ? 'Mengunduh...' : 'Unduh Backup Sekarang'}
                </button>
              </div>

              {/* Verifikasi Konfirmasi */}
              {selectedOption.requiresTypedPhrase ? (
                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <label
                    htmlFor="phrase-input"
                    className="block text-xs font-bold text-slate-800"
                  >
                    Ketik teks konfirmasi di bawah ini dengan tepat:
                  </label>
                  <div className="p-2 bg-slate-100 rounded text-center font-mono font-bold text-red-700 tracking-wider text-sm select-all">
                    {RESET_CONFIRMATION_PHRASE}
                  </div>
                  <input
                    id="phrase-input"
                    type="text"
                    disabled={isResetting}
                    value={typedConfirmation}
                    onChange={(e) => setTypedConfirmation(e.target.value)}
                    placeholder="Ketik persis RESET KEDAI KHANXA..."
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-red-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                  />
                  {typedConfirmation.trim() &&
                    typedConfirmation.trim() !== RESET_CONFIRMATION_PHRASE && (
                      <p className="text-[11px] text-red-600 font-medium">
                        Teks belum cocok. Wajib persis &quot;{RESET_CONFIRMATION_PHRASE}&quot;.
                      </p>
                    )}
                </div>
              ) : (
                <div className="pt-2 border-t border-slate-100">
                  <label className="flex items-start gap-2.5 text-xs text-slate-800 font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={isResetting}
                      checked={confirmedRisk}
                      onChange={(e) => setConfirmedRisk(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300 text-red-600 focus:ring-red-500 w-4 h-4 cursor-pointer"
                    />
                    <span>
                      Saya menyatakan bahwa saya adalah Admin berwenang dan menyetujui penghapusan data di atas secara permanen.
                    </span>
                  </label>
                </div>
              )}
            </div>

            {/* Tombol Aksi Modal */}
            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsConfirmModalOpen(false)}
                disabled={isResetting}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>

              <button
                type="button"
                onClick={handleExecuteReset}
                disabled={
                  isResetting ||
                  (selectedOption.requiresTypedPhrase
                    ? typedConfirmation.trim() !== RESET_CONFIRMATION_PHRASE
                    : !confirmedRisk)
                }
                className="min-h-[42px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-sm transition"
              >
                <Trash2 className="w-4 h-4" />
                <span>
                  {isResetting ? 'Sedang Menghapus Data...' : 'Konfirmasi & Hapus Permanen'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Laporan Hasil Reset */}
      {resetResult && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    resetResult.success
                      ? 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                      : 'bg-red-100 text-red-700 border border-red-300'
                  }`}
                >
                  {resetResult.success ? (
                    <Check className="w-5 h-5" />
                  ) : (
                    <AlertTriangle className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h3 className="font-display font-bold text-base text-slate-900">
                    {resetResult.success
                      ? 'Reset Data Berhasil Dijalankan'
                      : 'Laporan Kendala Reset Data'}
                  </h3>
                  <p className="text-xs text-slate-500">{resetResult.resetLabel}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setResetResult(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div
                className={`p-3 rounded-lg border leading-relaxed ${
                  resetResult.success
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border-red-200 text-red-900'
                }`}
              >
                <div className="font-semibold mb-1">
                  {resetResult.success
                    ? `Sukses memproses ${resetResult.totalDeleted} dokumen/operasi.`
                    : 'Proses reset mengalami beberapa kendala:'}
                </div>
                <div className="whitespace-pre-line font-mono-num">{resetResult.summary}</div>
              </div>

              {resetResult.errors && resetResult.errors.length > 0 && (
                <div className="space-y-1">
                  <div className="font-semibold text-red-700">Rincian Galat:</div>
                  <div className="p-2.5 bg-red-50 border border-red-200 rounded text-red-800 text-[11px] font-mono space-y-1 max-h-32 overflow-y-auto">
                    {resetResult.errors.map((er, idx) => (
                      <div key={idx}>• {er}</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-[11px] text-slate-500 font-mono-num">
                Waktu eksekusi: {new Date(resetResult.executedAt).toLocaleString('id-ID')}
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setResetResult(null)}
                className="min-h-[42px] px-5 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer"
              >
                Tutup Laporan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
