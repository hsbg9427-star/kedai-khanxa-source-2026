import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  CashLedger,
  Purchase,
  PurchaseItem,
  PurchaseReturn,
  Sale,
  SaleItem,
  SupplierPayment,
} from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';

export interface FullReportExtrasData {
  cashLedger: CashLedger[];
  purchases: Purchase[];
  purchaseReturns: PurchaseReturn[];
  supplierPayments: SupplierPayment[];
}

export function subscribeFullReportExtras(
  onData: (data: FullReportExtrasData) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const state: FullReportExtrasData = {
    cashLedger: [],
    purchases: [],
    purchaseReturns: [],
    supplierPayments: [],
  };

  const emit = () =>
    onData({
      cashLedger: state.cashLedger,
      purchases: state.purchases,
      purchaseReturns: state.purchaseReturns,
      supplierPayments: state.supplierPayments,
    });

  const unsubs: Unsubscribe[] = [
    onSnapshot(
      query(collection(db, 'cash_ledger'), orderBy('createdAt', 'desc'), limit(1000)),
      (snap) => {
        state.cashLedger = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<CashLedger, 'id'>),
        }));
        state.cashLedger.sort((a, b) =>
          `${b.transactionDate} ${b.transactionTime}`.localeCompare(
            `${a.transactionDate} ${a.transactionTime}`
          )
        );
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'cash_ledger');
      }
    ),
    onSnapshot(
      query(collection(db, 'purchases'), orderBy('transactionDate', 'desc'), limit(400)),
      (snap) => {
        state.purchases = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Purchase, 'id'>),
        }));
        state.purchases.sort((a, b) =>
          `${b.transactionDate} ${b.transactionTime}`.localeCompare(
            `${a.transactionDate} ${a.transactionTime}`
          )
        );
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'purchases');
      }
    ),
    onSnapshot(
      query(collection(db, 'purchase_returns'), orderBy('transactionDate', 'desc'), limit(300)),
      (snap) => {
        state.purchaseReturns = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<PurchaseReturn, 'id'>),
        }));
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'purchase_returns');
      }
    ),
    onSnapshot(
      query(collection(db, 'supplier_payments'), orderBy('transactionDate', 'desc'), limit(300)),
      (snap) => {
        state.supplierPayments = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<SupplierPayment, 'id'>),
        }));
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'supplier_payments');
      }
    ),
  ];

  return () => {
    unsubs.forEach((u) => u());
  };
}

export async function fetchMissingSaleItems(
  sales: Sale[],
  existingMap: Record<string, SaleItem[]>
): Promise<Record<string, SaleItem[]>> {
  const missing = sales.filter((s) => s.status === 'completed' && !existingMap[s.id]);
  if (missing.length === 0) return existingMap;

  const nextMap: Record<string, SaleItem[]> = { ...existingMap };
  const CHUNK = 25;

  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (sale) => {
        try {
          const snap = await getDocs(collection(db, 'sales', sale.id, 'items'));
          const rows: SaleItem[] = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<SaleItem, 'id'>),
          }));
          return { saleId: sale.id, rows };
        } catch (err) {
          handleFirestoreError(err, OperationType.LIST, `sales/${sale.id}/items`);
        }
      })
    );
    results.forEach(({ saleId, rows }) => {
      nextMap[saleId] = rows;
    });
  }

  return nextMap;
}

export async function fetchMissingPurchaseItems(
  purchases: Purchase[],
  existingMap: Record<string, PurchaseItem[]>
): Promise<Record<string, PurchaseItem[]>> {
  const missing = purchases.filter((p) => p.status === 'completed' && !existingMap[p.id]);
  if (missing.length === 0) return existingMap;

  const nextMap: Record<string, PurchaseItem[]> = { ...existingMap };
  const CHUNK = 25;

  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = purchases
      .filter((p) => p.status === 'completed' && !existingMap[p.id])
      .slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (pur) => {
        try {
          const snap = await getDocs(collection(db, 'purchases', pur.id, 'items'));
          const rows: PurchaseItem[] = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<PurchaseItem, 'id'>),
          }));
          return { purchaseId: pur.id, rows };
        } catch (err) {
          handleFirestoreError(err, OperationType.LIST, `purchases/${pur.id}/items`);
        }
      })
    );
    results.forEach(({ purchaseId, rows }) => {
      nextMap[purchaseId] = rows;
    });
  }

  return nextMap;
}
