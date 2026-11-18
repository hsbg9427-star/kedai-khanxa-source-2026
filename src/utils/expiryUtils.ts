import type { Product, StockBatch } from '../types/database';
import { getTodayDateString } from './formatters';
import { roundQty } from './unitConversion';

export const ESTIMATED_EXPIRY_MONTHS = 6;
export const EXPIRY_WARNING_THRESHOLD_DAYS = 30;
export const EXPIRY_ESTIMATE_DISCLAIMER =
  'Perkiraan +6 bulan hanya tanggal estimasi berdasarkan tanggal awal, bukan jaminan tanggal kedaluwarsa sebenarnya. Selalu utamakan tanggal kedaluwarsa aktual pada kemasan bila tersedia.';

export type ExpiryStatus = 'AMAN' | 'MENDEKATI EXPIRED' | 'EXPIRED';

export function daysInCalendarMonth(year: number, month1To12: number): number {
  if (month1To12 === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  if ([4, 6, 9, 11].includes(month1To12)) {
    return 30;
  }
  return 31;
}

export function isValidYmd(dateStr?: string | null): boolean {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const maxD = daysInCalendarMonth(y, m);
  return d >= 1 && d <= maxD;
}

export function addCalendarMonths(
  startDateYmd: string,
  months: number = ESTIMATED_EXPIRY_MONTHS
): string {
  const safeStart = isValidYmd(startDateYmd) ? startDateYmd : getTodayDateString();
  const [origYear, origMonth, origDay] = safeStart.split('-').map(Number);
  const zeroBasedTotalMonths = origYear * 12 + (origMonth - 1) + months;
  const targetYear = Math.floor(zeroBasedTotalMonths / 12);
  const targetMonth = ((zeroBasedTotalMonths % 12) + 12) % 12 + 1;
  const maxDay = daysInCalendarMonth(targetYear, targetMonth);
  const targetDay = Math.min(origDay, maxDay);

  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(
    targetDay
  ).padStart(2, '0')}`;
}

export function computeEstimatedExpiryDate(startDateYmd?: string | null): string {
  const safeStart = startDateYmd && isValidYmd(startDateYmd) ? startDateYmd : getTodayDateString();
  return addCalendarMonths(safeStart, ESTIMATED_EXPIRY_MONTHS);
}

export function getEffectiveExpiryDate(
  estimatedExpiryDate: string,
  actualExpiryDate?: string | null
): string {
  if (actualExpiryDate && isValidYmd(actualExpiryDate)) {
    return actualExpiryDate;
  }
  return estimatedExpiryDate;
}

function toUtcEpochDays(ymd: string): number {
  const safe = isValidYmd(ymd) ? ymd : getTodayDateString();
  const [y, m, d] = safe.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function calculateDaysRemaining(
  effectiveExpiryDate: string,
  referenceDateYmd: string = getTodayDateString()
): number {
  return toUtcEpochDays(effectiveExpiryDate) - toUtcEpochDays(referenceDateYmd);
}

export function getExpiryStatus(
  effectiveExpiryDate: string,
  referenceDateYmd: string = getTodayDateString()
): ExpiryStatus {
  const daysRemaining = calculateDaysRemaining(effectiveExpiryDate, referenceDateYmd);
  if (daysRemaining > EXPIRY_WARNING_THRESHOLD_DAYS) {
    return 'AMAN';
  }
  if (daysRemaining >= 1) {
    return 'MENDEKATI EXPIRED';
  }
  return 'EXPIRED';
}

export function formatShortIdDate(ymd: string): string {
  if (!isValidYmd(ymd)) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
    'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
  ];
  return `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`;
}

export function formatDaysRemainingLabel(daysRemaining: number): string {
  if (daysRemaining > 0) {
    return `${daysRemaining} hari lagi`;
  }
  if (daysRemaining === 0) {
    return 'Kedaluwarsa hari ini';
  }
  return `Lewat ${Math.abs(daysRemaining)} hari`;
}

export interface EvaluatedBatchExpiry {
  effectiveExpiryDate: string;
  daysRemaining: number;
  expiryStatus: ExpiryStatus;
  isActualPackagingDate: boolean;
  needsDashboardAlert: boolean;
  remainingLabel: string;
}

export function evaluateBatchExpiry(
  batch: Pick<
    StockBatch,
    | 'estimatedExpiryDate'
    | 'actualExpiryDate'
    | 'effectiveExpiryDate'
    | 'remainingBaseQty'
    | 'status'
  >,
  referenceDateYmd: string = getTodayDateString()
): EvaluatedBatchExpiry {
  const isActualPackagingDate = Boolean(
    batch.actualExpiryDate && isValidYmd(batch.actualExpiryDate)
  );
  const effectiveExpiryDate = getEffectiveExpiryDate(
    batch.effectiveExpiryDate || batch.estimatedExpiryDate,
    batch.actualExpiryDate
  );
  const daysRemaining = calculateDaysRemaining(effectiveExpiryDate, referenceDateYmd);
  const expiryStatus = getExpiryStatus(effectiveExpiryDate, referenceDateYmd);
  const hasStock = Number(batch.remainingBaseQty) > 0.00001;
  const needsDashboardAlert =
    batch.status === 'active' &&
    hasStock &&
    (expiryStatus === 'MENDEKATI EXPIRED' || expiryStatus === 'EXPIRED');

  return {
    effectiveExpiryDate,
    daysRemaining,
    expiryStatus,
    isActualPackagingDate,
    needsDashboardAlert,
    remainingLabel: formatDaysRemainingLabel(daysRemaining),
  };
}

export interface ProductBatchSummary {
  productId: string;
  totalStock: number;
  trackedBatchStock: number;
  nonExpiredBatchStock: number;
  expiredBatchStock: number;
  unbatchedLegacyStock: number;
  safeSellableStock: number;
  expiredOnlyRemaining: number;
  activeNonExpiredBatches: (StockBatch & EvaluatedBatchExpiry)[];
  activeExpiredBatches: (StockBatch & EvaluatedBatchExpiry)[];
  allBatchesEvaluated: (StockBatch & EvaluatedBatchExpiry)[];
  nearestNonExpired?: StockBatch & EvaluatedBatchExpiry;
  nearestAlertBatch?: StockBatch & EvaluatedBatchExpiry;
  hasNearExpiry: boolean;
  hasExpiredStock: boolean;
}

export function summarizeProductBatches(
  product: Pick<Product, 'id' | 'stock'>,
  allBatches: StockBatch[],
  referenceDateYmd: string = getTodayDateString()
): ProductBatchSummary {
  const totalStock = Math.max(0, roundQty(Number(product.stock) || 0));
  const productBatches = allBatches
    .filter((b) => b.productId === product.id)
    .map((b) => ({
      ...b,
      ...evaluateBatchExpiry(b, referenceDateYmd),
    }))
    .sort((a, b) => a.effectiveExpiryDate.localeCompare(b.effectiveExpiryDate));

  const activePositive = productBatches.filter(
    (b) => b.status === 'active' && Number(b.remainingBaseQty) > 0.00001
  );

  const activeNonExpiredBatches = activePositive.filter(
    (b) => b.expiryStatus !== 'EXPIRED'
  );
  const activeExpiredBatches = activePositive.filter(
    (b) => b.expiryStatus === 'EXPIRED'
  );

  const nonExpiredBatchStock = roundQty(
    activeNonExpiredBatches.reduce((sum, b) => sum + Math.max(0, Number(b.remainingBaseQty) || 0), 0)
  );
  const expiredBatchStock = roundQty(
    activeExpiredBatches.reduce((sum, b) => sum + Math.max(0, Number(b.remainingBaseQty) || 0), 0)
  );
  const trackedBatchStock = roundQty(nonExpiredBatchStock + expiredBatchStock);
  const unbatchedLegacyStock = roundQty(Math.max(0, totalStock - trackedBatchStock));
  const safeSellableStock = roundQty(
    Math.min(totalStock, nonExpiredBatchStock + unbatchedLegacyStock)
  );
  const expiredOnlyRemaining = roundQty(
    Math.min(expiredBatchStock, Math.max(0, totalStock - safeSellableStock))
  );

  const alertBatches = activePositive.filter((b) => b.needsDashboardAlert);

  return {
    productId: product.id,
    totalStock,
    trackedBatchStock,
    nonExpiredBatchStock,
    expiredBatchStock,
    unbatchedLegacyStock,
    safeSellableStock,
    expiredOnlyRemaining,
    activeNonExpiredBatches,
    activeExpiredBatches,
    allBatchesEvaluated: productBatches,
    nearestNonExpired: activeNonExpiredBatches[0],
    nearestAlertBatch: alertBatches[0],
    hasNearExpiry: activeNonExpiredBatches.some((b) => b.expiryStatus === 'MENDEKATI EXPIRED'),
    hasExpiredStock: expiredBatchStock > 0.00001,
  };
}

export interface BatchDeductionAllocation {
  batchId: string;
  batchNumber: string;
  deductQty: number;
  remainingAfter: number;
  nextStatus: 'active' | 'depleted';
  isExpiredBatch: boolean;
  effectiveExpiryDate: string;
}

export interface FefoPlanResult {
  ok: boolean;
  blockedByExpired: boolean;
  usedExpiredBatches: boolean;
  safeAvailableQty: number;
  expiredAvailableQty: number;
  allocations: BatchDeductionAllocation[];
}

export function planFefoBatchDeduction(
  product: Pick<Product, 'id' | 'stock'>,
  allBatches: StockBatch[],
  requiredBaseQty: number,
  allowExpiredOverride: boolean,
  referenceDateYmd: string = getTodayDateString()
): FefoPlanResult {
  const summary = summarizeProductBatches(product, allBatches, referenceDateYmd);
  const needed = Math.max(0, roundQty(requiredBaseQty));
  const tolerance = 0.0001;

  if (needed <= tolerance) {
    return {
      ok: true,
      blockedByExpired: false,
      usedExpiredBatches: false,
      safeAvailableQty: summary.safeSellableStock,
      expiredAvailableQty: summary.expiredBatchStock,
      allocations: [],
    };
  }

  // Jika jumlah yang diminta melebihi stok aman (non-expired + legacy) dan ada stok expired,
  // maka penjualan menyentuh batch EXPIRED dan wajib disetujui Admin terlebih dahulu.
  if (
    needed > summary.safeSellableStock + tolerance &&
    summary.expiredBatchStock > tolerance &&
    !allowExpiredOverride
  ) {
    return {
      ok: false,
      blockedByExpired: true,
      usedExpiredBatches: false,
      safeAvailableQty: summary.safeSellableStock,
      expiredAvailableQty: summary.expiredBatchStock,
      allocations: [],
    };
  }

  const allocations: BatchDeductionAllocation[] = [];
  let remainingToDeduct = needed;

  // 1. Prioritas FEFO dari batch aktif yang belum expired
  for (const batch of summary.activeNonExpiredBatches) {
    if (remainingToDeduct <= tolerance) break;
    const avail = Math.max(0, roundQty(Number(batch.remainingBaseQty) || 0));
    if (avail <= tolerance) continue;
    const deduct = roundQty(Math.min(avail, remainingToDeduct));
    const after = roundQty(Math.max(0, avail - deduct));
    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      deductQty: deduct,
      remainingAfter: after <= tolerance ? 0 : after,
      nextStatus: after <= tolerance ? 'depleted' : 'active',
      isExpiredBatch: false,
      effectiveExpiryDate: batch.effectiveExpiryDate,
    });
    remainingToDeduct = roundQty(Math.max(0, remainingToDeduct - deduct));
  }

  // 2. Gunakan stok lama tanpa batch (legacy stock) jika masih dibutuhkan
  if (remainingToDeduct > tolerance && summary.unbatchedLegacyStock > tolerance) {
    const consumeLegacy = roundQty(Math.min(summary.unbatchedLegacyStock, remainingToDeduct));
    remainingToDeduct = roundQty(Math.max(0, remainingToDeduct - consumeLegacy));
  }

  // 3. Jika masih ada kebutuhan dan Admin menyetujui penjualan batch EXPIRED
  let usedExpiredBatches = false;
  if (remainingToDeduct > tolerance && summary.activeExpiredBatches.length > 0) {
    if (!allowExpiredOverride) {
      return {
        ok: false,
        blockedByExpired: true,
        usedExpiredBatches: false,
        safeAvailableQty: summary.safeSellableStock,
        expiredAvailableQty: summary.expiredBatchStock,
        allocations: [],
      };
    }

    for (const batch of summary.activeExpiredBatches) {
      if (remainingToDeduct <= tolerance) break;
      const avail = Math.max(0, roundQty(Number(batch.remainingBaseQty) || 0));
      if (avail <= tolerance) continue;
      const deduct = roundQty(Math.min(avail, remainingToDeduct));
      const after = roundQty(Math.max(0, avail - deduct));
      allocations.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        deductQty: deduct,
        remainingAfter: after <= tolerance ? 0 : after,
        nextStatus: after <= tolerance ? 'depleted' : 'active',
        isExpiredBatch: true,
        effectiveExpiryDate: batch.effectiveExpiryDate,
      });
      usedExpiredBatches = true;
      remainingToDeduct = roundQty(Math.max(0, remainingToDeduct - deduct));
    }
  }

  return {
    ok: true,
    blockedByExpired: false,
    usedExpiredBatches,
    safeAvailableQty: summary.safeSellableStock,
    expiredAvailableQty: summary.expiredBatchStock,
    allocations,
  };
}
