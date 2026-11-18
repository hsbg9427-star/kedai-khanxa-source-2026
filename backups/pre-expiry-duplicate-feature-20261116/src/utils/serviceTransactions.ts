import type {
  MiniAtmBankFeeRule,
  MiniAtmFeeTier,
  MiniAtmPaymentChannel,
  MiniAtmSetting,
  MiniAtmTransaction,
  PpobTransaction,
} from '../types/database';
import { formatRupiah } from './formatters';
import { roundMoney } from './unitConversion';

export type MiniAtmServiceType = MiniAtmTransaction['serviceType'];
export type ActiveMiniAtmServiceType = 'tarik_tunai' | 'transfer';
export type PpobCategory = PpobTransaction['category'];
export type PpobStatus = PpobTransaction['status'];

// Menu aktif hanya Tarik Tunai & Transfer Bank (Setor Tunai dihapus dari menu layanan baru)
export const MINI_ATM_SERVICE_OPTIONS: {
  id: ActiveMiniAtmServiceType;
  label: string;
  shortDesc: string;
}[] = [
  {
    id: 'tarik_tunai',
    label: 'Tarik Tunai (QRIS / Kartu)',
    shortDesc: 'Pelanggan bayar lewat QRIS Warung (MDR 0,3%) atau Kartu/Transfer terverifikasi, warung serahkan uang tunai.',
  },
  {
    id: 'transfer',
    label: 'Transfer Bank',
    shortDesc: 'Pelanggan serahkan uang tunai + jasa, warung transfer dari rekening sumber dana.',
  },
];

export const COMMON_MINI_ATM_BANKS = [
  'BRI',
  'BCA',
  'Mandiri',
  'BNI',
  'BSI',
  'BTN',
  'SeaBank',
  'Bank Jago',
  'DANA',
  'OVO',
  'GoPay',
  'ShopeePay',
];

export const DEFAULT_MINI_ATM_FEE_TIERS: MiniAtmFeeTier[] = [
  { id: 'tier-1', serviceScope: 'all', minAmount: 1, maxAmount: 500000, adminFee: 5000 },
  { id: 'tier-2', serviceScope: 'all', minAmount: 500001, maxAmount: 1000000, adminFee: 10000 },
  { id: 'tier-3', serviceScope: 'all', minAmount: 1000001, maxAmount: 2500000, adminFee: 15000 },
  { id: 'tier-4', serviceScope: 'all', minAmount: 2500001, maxAmount: 0, adminFee: 20000 },
];

export const DEFAULT_MINI_ATM_BANK_FEES: MiniAtmBankFeeRule[] = [
  { bankName: 'BRI', defaultBankFee: 0 },
  { bankName: 'BCA', defaultBankFee: 2500 },
  { bankName: 'Mandiri', defaultBankFee: 2500 },
  { bankName: 'BNI', defaultBankFee: 2500 },
  { bankName: 'BSI', defaultBankFee: 2500 },
  { bankName: 'BTN', defaultBankFee: 2500 },
  { bankName: 'SeaBank', defaultBankFee: 0 },
  { bankName: 'Bank Jago', defaultBankFee: 0 },
  { bankName: 'DANA', defaultBankFee: 1000 },
  { bankName: 'OVO', defaultBankFee: 1000 },
  { bankName: 'GoPay', defaultBankFee: 1000 },
  { bankName: 'ShopeePay', defaultBankFee: 1000 },
];

export type MiniAtmSettingValues = Omit<MiniAtmSetting, 'id' | 'updatedByUid' | 'updatedByName' | 'updatedAt'>;

export function getDefaultMiniAtmSettings(): MiniAtmSettingValues {
  return {
    allowQrisTarikTunai: true,
    qrisProviderNote: 'Pastikan layanan Tarik Tunai QRIS sesuai ketentuan penyedia QRIS & mitra resmi warung.',
    qrisMdrPercent: 0.3,
    qrisInternalExtraThreshold: 500,
    qrisInternalExtraFee: 500,
    defaultTarikTunaiFee: 5000,
    defaultTransferFee: 5000,
    feeTiers: DEFAULT_MINI_ATM_FEE_TIERS.map((t) => ({ ...t })),
    bankFeeRules: DEFAULT_MINI_ATM_BANK_FEES.map((r) => ({ ...r })),
  };
}

export function normalizeMiniAtmSettings(setting?: Partial<MiniAtmSetting> | null): MiniAtmSettingValues {
  const defaults = getDefaultMiniAtmSettings();
  if (!setting) return defaults;

  return {
    allowQrisTarikTunai: Boolean(setting.allowQrisTarikTunai),
    qrisProviderNote: String(setting.qrisProviderNote || ''),
    qrisMdrPercent:
      typeof setting.qrisMdrPercent === 'number' && Number.isFinite(setting.qrisMdrPercent)
        ? Math.max(0, Math.min(10, Number(setting.qrisMdrPercent.toFixed(4))))
        : defaults.qrisMdrPercent,
    qrisInternalExtraThreshold:
      typeof setting.qrisInternalExtraThreshold === 'number' &&
      Number.isFinite(setting.qrisInternalExtraThreshold)
        ? Math.max(0, roundMoney(setting.qrisInternalExtraThreshold))
        : defaults.qrisInternalExtraThreshold,
    qrisInternalExtraFee:
      typeof setting.qrisInternalExtraFee === 'number' && Number.isFinite(setting.qrisInternalExtraFee)
        ? Math.max(0, roundMoney(setting.qrisInternalExtraFee))
        : defaults.qrisInternalExtraFee,
    defaultTarikTunaiFee:
      typeof setting.defaultTarikTunaiFee === 'number' && Number.isFinite(setting.defaultTarikTunaiFee)
        ? Math.max(0, roundMoney(setting.defaultTarikTunaiFee))
        : defaults.defaultTarikTunaiFee,
    defaultTransferFee:
      typeof setting.defaultTransferFee === 'number' && Number.isFinite(setting.defaultTransferFee)
        ? Math.max(0, roundMoney(setting.defaultTransferFee))
        : defaults.defaultTransferFee,
    feeTiers:
      Array.isArray(setting.feeTiers) && setting.feeTiers.length > 0
        ? setting.feeTiers.map((t, idx) => ({
            id: String(t.id || `tier-${idx + 1}`),
            serviceScope:
              t.serviceScope === 'tarik_tunai' || t.serviceScope === 'transfer'
                ? t.serviceScope
                : 'all',
            minAmount: Math.max(0, roundMoney(Number(t.minAmount) || 0)),
            maxAmount: Math.max(0, roundMoney(Number(t.maxAmount) || 0)),
            adminFee: Math.max(0, roundMoney(Number(t.adminFee) || 0)),
            ...(typeof t.bankFee === 'number' && Number.isFinite(t.bankFee)
              ? { bankFee: Math.max(0, roundMoney(t.bankFee)) }
              : {}),
          }))
        : defaults.feeTiers,
    bankFeeRules:
      Array.isArray(setting.bankFeeRules) && setting.bankFeeRules.length > 0
        ? setting.bankFeeRules.map((r) => ({
            bankName: String(r.bankName || '').trim(),
            defaultBankFee: Math.max(0, roundMoney(Number(r.defaultBankFee) || 0)),
          }))
        : defaults.bankFeeRules,
  };
}

export interface ResolveMiniAtmFeesInput {
  serviceType: ActiveMiniAtmServiceType;
  bankName: string;
  principalAmount: number;
  settings?: Partial<MiniAtmSetting> | MiniAtmSettingValues | null;
}

export interface ResolveMiniAtmFeesResult {
  standardAdminFee: number;
  standardBankFee: number;
  matchedTierLabel: string;
}

export function resolveMiniAtmStandardFees(input: ResolveMiniAtmFeesInput): ResolveMiniAtmFeesResult {
  const cfg = normalizeMiniAtmSettings(input.settings);
  const amount = Math.max(0, roundMoney(Number(input.principalAmount) || 0));
  const normalizedBank = input.bankName.trim().toLowerCase();

  const matchesRange = (t: MiniAtmFeeTier) =>
    amount >= t.minAmount && (t.maxAmount === 0 || amount <= t.maxAmount);

  // Prioritaskan aturan spesifik layanan dibanding 'all'
  const specificTier =
    amount > 0
      ? cfg.feeTiers.find((t) => t.serviceScope === input.serviceType && matchesRange(t))
      : undefined;
  const generalTier =
    amount > 0
      ? cfg.feeTiers.find((t) => t.serviceScope === 'all' && matchesRange(t))
      : undefined;
  const matchedTier = specificTier || generalTier;

  const standardAdminFee = matchedTier
    ? matchedTier.adminFee
    : input.serviceType === 'tarik_tunai'
    ? cfg.defaultTarikTunaiFee
    : cfg.defaultTransferFee;

  const bankRule = normalizedBank
    ? cfg.bankFeeRules.find((r) => r.bankName.trim().toLowerCase() === normalizedBank)
    : undefined;

  let standardBankFee = 0;
  if (input.serviceType === 'transfer') {
    standardBankFee = bankRule
      ? bankRule.defaultBankFee
      : typeof matchedTier?.bankFee === 'number'
      ? matchedTier.bankFee
      : 0;
  } else if (typeof matchedTier?.bankFee === 'number') {
    standardBankFee = matchedTier.bankFee;
  }

  const matchedTierLabel = matchedTier
    ? matchedTier.maxAmount > 0
      ? `Tier ${formatRupiah(matchedTier.minAmount)} – ${formatRupiah(matchedTier.maxAmount)}`
      : `Tier >= ${formatRupiah(matchedTier.minAmount)}`
    : 'Tarif Default';

  return {
    standardAdminFee: roundMoney(standardAdminFee),
    standardBankFee: roundMoney(standardBankFee),
    matchedTierLabel,
  };
}

export const PPOB_CATEGORY_OPTIONS: {
  id: PpobCategory;
  label: string;
  targetLabel: string;
  targetPlaceholder: string;
  providers: string[];
}[] = [
  {
    id: 'pulsa',
    label: 'Pulsa Reguler',
    targetLabel: 'Nomor HP Tujuan',
    targetPlaceholder: 'Contoh: 081234567890',
    providers: ['Telkomsel', 'Indosat', 'XL', 'Axis', 'Tri', 'Smartfren'],
  },
  {
    id: 'paket_data',
    label: 'Paket Data',
    targetLabel: 'Nomor HP Tujuan',
    targetPlaceholder: 'Contoh: 085212345678',
    providers: ['Telkomsel Data', 'Indosat Freedom', 'XL Xtra Combo', 'Axis Bronet', 'Tri Happy'],
  },
  {
    id: 'pln',
    label: 'Token / Tagihan PLN',
    targetLabel: 'ID Pelanggan / No. Meter PLN',
    targetPlaceholder: 'Contoh: 14123456789',
    providers: ['PLN Token Prabayar', 'PLN Tagihan Pascabayar'],
  },
  {
    id: 'ewallet',
    label: 'Top-Up E-Wallet',
    targetLabel: 'Nomor HP / ID Akun E-Wallet',
    targetPlaceholder: 'Contoh: 081234567890',
    providers: ['DANA', 'GoPay', 'OVO', 'ShopeePay', 'LinkAja'],
  },
  {
    id: 'pdam',
    label: 'Tagihan PDAM',
    targetLabel: 'Nomor Pelanggan PDAM',
    targetPlaceholder: 'Contoh: 001234567',
    providers: ['PDAM Kab/Kota', 'PDAM Tirta'],
  },
  {
    id: 'bpjs',
    label: 'BPJS Kesehatan',
    targetLabel: 'Nomor VA / Kartu BPJS',
    targetPlaceholder: 'Contoh: 8888801234567890',
    providers: ['BPJS Kesehatan', 'BPJS Ketenagakerjaan'],
  },
  {
    id: 'lainnya',
    label: 'Tagihan / Voucher Lainnya',
    targetLabel: 'ID Pelanggan / Nomor Tujuan',
    targetPlaceholder: 'Contoh: 1234567890',
    providers: ['Voucher Game', 'IndiHome / Internet', 'Multifinance'],
  },
];

export function getMiniAtmServiceLabel(type: MiniAtmServiceType): string {
  switch (type) {
    case 'tarik_tunai':
      return 'Tarik Tunai';
    case 'transfer':
      return 'Transfer Bank';
    case 'setor_tunai':
      return 'Setor Tunai (Arsip)';
    default:
      return type;
  }
}

export function getPpobCategoryLabel(category: PpobCategory): string {
  return PPOB_CATEGORY_OPTIONS.find((c) => c.id === category)?.label || category;
}

export function getPpobStatusLabel(status: PpobStatus): string {
  switch (status) {
    case 'completed':
      return 'Sukses';
    case 'pending':
      return 'Pending';
    case 'failed':
      return 'Gagal / Refund';
    default:
      return status;
  }
}

export interface MiniAtmBreakdownInput {
  serviceType: MiniAtmServiceType;
  paymentChannel?: MiniAtmPaymentChannel;
  allowQrisTarikTunai?: boolean;
  qrisVerified?: boolean;
  qrisMdrRate?: number;
  qrisMdrAmountOverride?: number;
  qrisInternalExtraThreshold?: number;
  qrisInternalExtraFee?: number;
  qrisInternalExtraFeeOverride?: number;
  principalAmount: number;
  adminFee: number;
  bankFee: number;
}

export interface MiniAtmBreakdownResult {
  serviceType: MiniAtmServiceType;
  paymentChannel: MiniAtmPaymentChannel;
  principalAmount: number;
  adminFee: number;
  bankFee: number;
  qrisMdrRate: number;
  qrisMdrAmount: number;
  internalExtraFee: number;
  totalCustomerFee: number;
  netProfit: number;
  customerTotal: number;
  cashDelta: number;
  cashDirection: 'in' | 'out';
  cashLedgerAmount: number;
  bankDelta: number;
  bankDirection: 'in' | 'out';
  bankLedgerAmount: number;
}

export function calculateMiniAtmBreakdown(input: MiniAtmBreakdownInput): MiniAtmBreakdownResult {
  const principalAmount = roundMoney(Number(input.principalAmount) || 0);
  const adminFee = roundMoney(Number(input.adminFee) || 0);
  const bankFee = roundMoney(Number(input.bankFee) || 0);
  const paymentChannel: MiniAtmPaymentChannel =
    input.paymentChannel === 'qris' ? 'qris' : 'bank_transfer';

  if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
    throw new Error('Nominal pokok transaksi Mini ATM harus lebih dari Rp0.');
  }
  if (!Number.isFinite(adminFee) || adminFee < 0) {
    throw new Error('Biaya jasa warung tidak boleh bernilai negatif.');
  }
  if (!Number.isFinite(bankFee) || bankFee < 0) {
    throw new Error('Biaya bank/merchant tidak boleh bernilai negatif.');
  }

  if (paymentChannel === 'qris') {
    if (input.serviceType !== 'tarik_tunai') {
      throw new Error('Pembayaran QRIS pada Mini ATM hanya tersedia untuk layanan Tarik Tunai.');
    }
    if (!input.allowQrisTarikTunai) {
      throw new Error(
        'Fitur QRIS Tarik Tunai belum diaktifkan Admin karena memerlukan izin resmi penyedia QRIS.'
      );
    }
    if (!input.qrisVerified) {
      throw new Error(
        'Pembayaran QRIS wajib diverifikasi pada aplikasi/dashboard penyedia QRIS sebelum uang tunai diserahkan.'
      );
    }
  }

  const mdrRateRaw = Number(input.qrisMdrRate ?? 0.3);
  const qrisMdrRate =
    paymentChannel === 'qris'
      ? Math.max(0, Math.min(10, Number.isFinite(mdrRateRaw) ? Number(mdrRateRaw.toFixed(4)) : 0.3))
      : 0;

  const qrisMdrAmount =
    paymentChannel === 'qris'
      ? typeof input.qrisMdrAmountOverride === 'number' &&
        Number.isFinite(input.qrisMdrAmountOverride)
        ? roundMoney(Math.max(0, input.qrisMdrAmountOverride))
        : roundMoney(principalAmount * (qrisMdrRate / 100))
      : 0;

  const extraThreshold = Math.max(0, roundMoney(Number(input.qrisInternalExtraThreshold ?? 500)));
  const extraFeeSetting = Math.max(0, roundMoney(Number(input.qrisInternalExtraFee ?? 500)));

  // Jika MDR QRIS > Rp500, pelanggan dikenakan tambahan biaya internal warung Rp500 (BUKAN dipotong dari laba).
  const internalExtraFee =
    paymentChannel === 'qris'
      ? typeof input.qrisInternalExtraFeeOverride === 'number' &&
        Number.isFinite(input.qrisInternalExtraFeeOverride)
        ? roundMoney(Math.max(0, input.qrisInternalExtraFeeOverride))
        : qrisMdrAmount > extraThreshold
        ? extraFeeSetting
        : 0
      : 0;

  const totalCustomerFee = roundMoney(adminFee + internalExtraFee);
  const netProfit = roundMoney(adminFee + internalExtraFee - bankFee - qrisMdrAmount);

  if (input.serviceType === 'tarik_tunai') {
    if (internalExtraFee >= principalAmount) {
      throw new Error(
        'Nominal penarikan harus lebih besar daripada potongan biaya tambahan internal.'
      );
    }
    // Biaya tambahan internal (jika MDR > Rp500) dipotong langsung dari saldo yang di-QRIS-kan pelanggan,
    // sehingga tunai yang diserahkan kepada pelanggan = principalAmount - internalExtraFee, ditambah jasa warung adminFee.
    // Rekening bank / settlement QRIS warung menerima principalAmount dikurangi biaya bank & MDR QRIS.
    const customerTotal = roundMoney(principalAmount - internalExtraFee);
    const cashDelta = roundMoney(-customerTotal + adminFee);
    const bankDelta = roundMoney(principalAmount - bankFee - qrisMdrAmount);

    return {
      serviceType: input.serviceType,
      paymentChannel,
      principalAmount,
      adminFee,
      bankFee,
      qrisMdrRate,
      qrisMdrAmount,
      internalExtraFee,
      totalCustomerFee,
      netProfit,
      customerTotal,
      cashDelta,
      cashDirection: cashDelta >= 0 ? 'in' : 'out',
      cashLedgerAmount: roundMoney(Math.abs(cashDelta)),
      bankDelta,
      bankDirection: bankDelta >= 0 ? 'in' : 'out',
      bankLedgerAmount: roundMoney(Math.abs(bankDelta)),
    };
  }

  // Transfer Bank (serta kompatibilitas riwayat Setor Tunai lama):
  // Pelanggan menyerahkan tunai (pokok + jasa warung) ke Laci Kas,
  // sementara Rekening sumber dana warung mentransfer (pokok + biaya bank).
  const customerTotal = roundMoney(principalAmount + adminFee);
  const cashDelta = customerTotal;
  const bankDelta = roundMoney(-(principalAmount + bankFee));

  return {
    serviceType: input.serviceType,
    paymentChannel: 'bank_transfer',
    principalAmount,
    adminFee,
    bankFee,
    qrisMdrRate: 0,
    qrisMdrAmount: 0,
    internalExtraFee: 0,
    totalCustomerFee: adminFee,
    netProfit: roundMoney(adminFee - bankFee),
    customerTotal,
    cashDelta,
    cashDirection: 'in',
    cashLedgerAmount: cashDelta,
    bankDelta,
    bankDirection: 'out',
    bankLedgerAmount: roundMoney(Math.abs(bankDelta)),
  };
}

export interface PpobBreakdownInput {
  capitalPrice: number;
  sellPrice: number;
  adminFee: number;
}

export interface PpobBreakdownResult {
  capitalPrice: number;
  sellPrice: number;
  adminFee: number;
  customerTotal: number;
  netProfit: number;
  depositDelta: number;
  cashReceiptDelta: number;
}

export function calculatePpobBreakdown(input: PpobBreakdownInput): PpobBreakdownResult {
  const capitalPrice = roundMoney(Number(input.capitalPrice) || 0);
  const sellPrice = roundMoney(Number(input.sellPrice) || 0);
  const adminFee = roundMoney(Number(input.adminFee) || 0);

  if (!Number.isFinite(capitalPrice) || capitalPrice < 0) {
    throw new Error('Harga modal deposit PPOB tidak boleh bernilai negatif.');
  }
  if (!Number.isFinite(sellPrice) || sellPrice < 0) {
    throw new Error('Harga jual PPOB tidak boleh bernilai negatif.');
  }
  if (!Number.isFinite(adminFee) || adminFee < 0) {
    throw new Error('Biaya admin PPOB tidak boleh bernilai negatif.');
  }

  const customerTotal = roundMoney(sellPrice + adminFee);
  if (customerTotal <= 0 && capitalPrice <= 0) {
    throw new Error('Nominal transaksi PPOB harus lebih dari Rp0.');
  }

  const netProfit = roundMoney(customerTotal - capitalPrice);

  return {
    capitalPrice,
    sellPrice,
    adminFee,
    customerTotal,
    netProfit,
    depositDelta: roundMoney(-capitalPrice),
    cashReceiptDelta: customerTotal,
  };
}
