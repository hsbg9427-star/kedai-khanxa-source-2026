import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  Account,
  CashierClosing,
  CashierClosingReviewStatus,
  DigitalAccountAdjustment,
  MiniAtmTransaction,
  PpobTransaction,
  Receivable,
  Sale,
} from '../types/database';
import {
  computeCashierClosingBreakdown,
  evaluateClosingVariance,
  type CashierClosingBreakdown,
} from '../utils/cashierClosing';
import {
  createTransactionMetadata,
  generateSafeId,
  getTodayDateString,
} from '../utils/formatters';
import { roundMoney } from '../utils/unitConversion';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';

export interface ClosingSourceSnapshot {
  sales: Sale[];
  miniAtmTransactions: MiniAtmTransaction[];
  ppobTransactions: PpobTransaction[];
  receivables: Receivable[];
}

export async function fetchKasirClosingSourceData(
  targetCashierUid: string
): Promise<ClosingSourceSnapshot> {
  if (!targetCashierUid) {
    throw new Error('Identitas kasir wajib tersedia untuk menghitung closing.');
  }

  const [salesSnap, atmSnap, ppobSnap, recSnap] = await Promise.all([
    getDocs(
      query(
        collection(db, 'sales'),
        where('recordedByUid', '==', targetCashierUid),
        limit(400)
      )
    ),
    getDocs(
      query(
        collection(db, 'mini_atm_transactions'),
        where('recordedByUid', '==', targetCashierUid),
        limit(400)
      )
    ),
    getDocs(
      query(
        collection(db, 'ppob_transactions'),
        where('recordedByUid', '==', targetCashierUid),
        limit(400)
      )
    ),
    getDocs(
      query(
        collection(db, 'receivables'),
        where('recordedByUid', '==', targetCashierUid),
        limit(400)
      )
    ),
  ]);

  return {
    sales: salesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Sale, 'id'>) })),
    miniAtmTransactions: atmSnap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<MiniAtmTransaction, 'id'>),
    })),
    ppobTransactions: ppobSnap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<PpobTransaction, 'id'>),
    })),
    receivables: recSnap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Receivable, 'id'>),
    })),
  };
}

export function subscribeCashierClosings(
  isAdmin: boolean,
  userUid: string,
  onData: (rows: CashierClosing[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = isAdmin
    ? query(collection(db, 'cashier_closings'), orderBy('createdAt', 'desc'), limit(200))
    : query(collection(db, 'cashier_closings'), where('recordedByUid', '==', userUid), limit(100));

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: CashierClosing[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<CashierClosing, 'id'>),
      }));
      list.sort((a, b) =>
        `${b.transactionDate} ${b.transactionTime}`.localeCompare(
          `${a.transactionDate} ${a.transactionTime}`
        )
      );
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'cashier_closings');
    }
  );
}

export interface FinalizeClosingInput {
  shiftLabel?: string;
  periodStartDate: string;
  periodEndDate: string;
  openingCash: number;
  actualCash: number;
  notes?: string;
  applyAdjustment?: boolean;
  adjustmentDescription?: string;
  digitalAdjustments?: DigitalAccountAdjustment[];
  breakdown: CashierClosingBreakdown;
}

export async function finalizeCashierClosing(
  input: FinalizeClosingInput,
  user: { uid: string; displayName: string }
): Promise<{ closingId: string; transactionNumber: string; closing: Omit<CashierClosing, 'createdAt' | 'updatedAt'> }> {
  if (!user.uid) {
    throw new Error('Sesi pengguna tidak valid.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodEndDate)) {
    throw new Error('Format tanggal periode closing tidak valid.');
  }
  if (input.periodStartDate > input.periodEndDate) {
    throw new Error('Tanggal awal periode tidak boleh lebih besar dari tanggal akhir.');
  }
  if (!Number.isFinite(input.actualCash) || input.actualCash < 0) {
    throw new Error('Jumlah uang fisik yang dihitung tidak boleh bernilai negatif.');
  }

  const openingCash = roundMoney(Math.max(0, Number(input.openingCash) || 0));
  const actualCash = roundMoney(Math.max(0, Number(input.actualCash) || 0));
  const variance = evaluateClosingVariance(input.breakdown.expectedCash, actualCash);
  const cleanShift = (input.shiftLabel || '').trim().slice(0, 60);
  const cleanNotes = (input.notes || '').trim().slice(0, 300);
  const applyAdjustment = Boolean(input.applyAdjustment);
  const cleanAdjustmentDesc = (input.adjustmentDescription || '').trim().slice(0, 300);
  const digitalAdjustments = input.digitalAdjustments || [];

  if (variance.status !== 'balance' && cleanNotes.length === 0) {
    throw new Error(
      `Terdapat selisih (${variance.statusLabel}). Masukkan catatan singkat penjelasan selisih sebelum finalisasi.`
    );
  }

  const closingId = generateSafeId('cls');
  const meta = createTransactionMetadata('CLS', user);

  const docPayload: Omit<CashierClosing, 'id' | 'createdAt' | 'updatedAt'> = {
    ...meta,
    ...(cleanShift ? { shiftLabel: cleanShift } : {}),
    periodStartDate: input.periodStartDate,
    periodEndDate: input.periodEndDate,
    openingCash,
    totalSalesAmount: input.breakdown.totalSalesAmount,
    retailTxCount: input.breakdown.retailTxCount,
    retailCashIn: input.breakdown.retailCashIn,
    retailQrisTotal: input.breakdown.retailQrisTotal,
    retailTransferTotal: input.breakdown.retailTransferTotal,
    retailDebtCreatedTotal: input.breakdown.retailDebtCreatedTotal,
    miniAtmTxCount: input.breakdown.miniAtmTxCount,
    miniAtmCashIn: input.breakdown.miniAtmCashIn,
    miniAtmCashOut: input.breakdown.miniAtmCashOut,
    miniAtmNonCashTotal: input.breakdown.miniAtmNonCashTotal,
    ppobTxCount: input.breakdown.ppobTxCount,
    ppobCashIn: input.breakdown.ppobCashIn,
    ppobNonCashTotal: input.breakdown.ppobNonCashTotal,
    receivablePaymentCount: input.breakdown.receivablePaymentCount,
    receivableCashIn: input.breakdown.receivableCashIn,
    receivableNonCashIn: input.breakdown.receivableNonCashIn,
    expectedCash: variance.expectedCash,
    actualCash: variance.actualCash,
    varianceAmount: variance.varianceAmount,
    status: variance.status,
    applyAdjustment,
    ...(cleanAdjustmentDesc ? { adjustmentDescription: cleanAdjustmentDesc } : {}),
    ...(digitalAdjustments.length > 0 ? { digitalAdjustments } : {}),
    ...(cleanNotes ? { notes: cleanNotes } : {}),
    isFinalized: true,
    reviewStatus: 'pending',
  };

  try {
    await setDoc(doc(db, 'cashier_closings', closingId), {
      ...docPayload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return {
      closingId,
      transactionNumber: meta.transactionNumber,
      closing: { id: closingId, ...docPayload },
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `cashier_closings/${closingId}`);
  }
}

export async function reviewCashierClosing(
  closingId: string,
  decision: {
    reviewStatus: CashierClosingReviewStatus;
    reviewNote?: string;
  },
  adminUser: { uid: string; displayName: string; isAdmin: boolean }
): Promise<void> {
  if (!adminUser.isAdmin) {
    throw new Error('Hanya Admin yang dapat melakukan pemeriksaan atau verifikasi closing kasir.');
  }
  if (!closingId) {
    throw new Error('ID closing kasir tidak valid.');
  }

  const cleanNote = (decision.reviewNote || '').trim().slice(0, 300);

  try {
    await updateDoc(doc(db, 'cashier_closings', closingId), {
      reviewStatus: decision.reviewStatus,
      ...(cleanNote ? { reviewNote: cleanNote } : { reviewNote: '' }),
      reviewedByUid: adminUser.uid,
      reviewedByName: adminUser.displayName.trim().slice(0, 100) || 'Admin',
      reviewedAtDate: getTodayDateString(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `cashier_closings/${closingId}`);
  }
}

export function computeLiveClosingBreakdown(
  snapshot: ClosingSourceSnapshot,
  accounts: Account[],
  targetCashierUid: string,
  periodStartDate: string,
  periodEndDate: string,
  openingCash: number
): CashierClosingBreakdown {
  return computeCashierClosingBreakdown({
    sales: snapshot.sales,
    miniAtmTransactions: snapshot.miniAtmTransactions,
    ppobTransactions: snapshot.ppobTransactions,
    receivables: snapshot.receivables,
    accounts,
    targetCashierUid,
    periodStartDate,
    periodEndDate,
    openingCash,
  });
}
