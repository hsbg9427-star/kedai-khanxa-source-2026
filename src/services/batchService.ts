import {
  collection,
  deleteField,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Product, StockBatch, StockBatchSourceType } from '../types/database';
import { computeEstimatedExpiryDate, getEffectiveExpiryDate, isValidYmd } from '../utils/expiryUtils';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import {
  createTransactionMetadata,
  formatQty,
  generateSafeId,
  getTodayDateString,
} from '../utils/formatters';
import { roundQty, snapStockToProductPrecision } from '../utils/unitConversion';

export function subscribeStockBatches(
  onData: (batches: StockBatch[], hasPendingWrites: boolean) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'stock_batches'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: StockBatch[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<StockBatch, 'id'>),
      }));
      list.sort((a, b) => a.effectiveExpiryDate.localeCompare(b.effectiveExpiryDate));
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      const code = (error as { code?: string })?.code || '';
      const msg = error instanceof Error ? error.message : String(error);
      if (code === 'permission-denied' || msg.includes('Missing or insufficient permissions')) {
        console.warn(
          'Koleksi stock_batches belum dapat dibaca (menunggu deployment firestore.rules terbaru).'
        );
        onData([], false);
        return;
      }
      onError?.(error);
    }
  );
}

export interface BuildBatchInput {
  batchId?: string;
  productId: string;
  productName: string;
  productBrand?: string;
  productVariant?: string;
  baseUnit: string;
  sourceType: StockBatchSourceType;
  sourceRefId?: string;
  sourceNumber?: string;
  supplierName?: string;
  startDate: string;
  actualExpiryDate?: string;
  initialBaseQty: number;
  costPerBaseUnit?: number;
  user: { uid: string; displayName: string };
}

export function buildStockBatchDocument(input: BuildBatchInput): {
  id: string;
  data: Record<string, unknown>;
} {
  const id = input.batchId || generateSafeId('bat');
  const startDate = isValidYmd(input.startDate) ? input.startDate : getTodayDateString();
  const estimatedExpiryDate = computeEstimatedExpiryDate(startDate);
  const cleanActual =
    input.actualExpiryDate && isValidYmd(input.actualExpiryDate)
      ? input.actualExpiryDate
      : undefined;
  const effectiveExpiryDate = getEffectiveExpiryDate(estimatedExpiryDate, cleanActual);
  const cleanQty = Math.max(0, roundQty(Number(input.initialBaseQty) || 0));
  const compactDate = startDate.replace(/-/g, '');
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const batchNumber = `BAT-${compactDate}-${suffix}`;

  const data: Record<string, unknown> = {
    batchNumber,
    productId: input.productId,
    productName: input.productName.trim().slice(0, 120),
    ...(input.productBrand?.trim()
      ? { productBrand: input.productBrand.trim().slice(0, 60) }
      : {}),
    ...(input.productVariant?.trim()
      ? { productVariant: input.productVariant.trim().slice(0, 80) }
      : {}),
    baseUnit: input.baseUnit.trim().slice(0, 24) || 'PCS',
    sourceType: input.sourceType,
    ...(input.sourceRefId ? { sourceRefId: input.sourceRefId.slice(0, 128) } : {}),
    ...(input.sourceNumber ? { sourceNumber: input.sourceNumber.slice(0, 40) } : {}),
    ...(input.supplierName?.trim()
      ? { supplierName: input.supplierName.trim().slice(0, 120) }
      : {}),
    startDate,
    estimatedExpiryDate,
    ...(cleanActual ? { actualExpiryDate: cleanActual } : {}),
    effectiveExpiryDate,
    initialBaseQty: cleanQty,
    remainingBaseQty: cleanQty,
    ...(input.costPerBaseUnit !== undefined && Number.isFinite(input.costPerBaseUnit)
      ? { costPerBaseUnit: Math.max(0, Number(input.costPerBaseUnit)) }
      : {}),
    status: cleanQty > 0 ? 'active' : 'depleted',
    recordedByUid: input.user.uid,
    recordedByName: input.user.displayName.trim().slice(0, 100) || 'Admin',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  return { id, data };
}

export async function updateBatchActualExpiry(
  batch: StockBatch,
  actualExpiryDate: string | null
): Promise<void> {
  const cleanActual = actualExpiryDate ? actualExpiryDate.trim() : '';
  if (cleanActual && !isValidYmd(cleanActual)) {
    throw new Error('Format tanggal kedaluwarsa kemasan tidak valid (gunakan YYYY-MM-DD).');
  }

  const nextEffective = getEffectiveExpiryDate(
    batch.estimatedExpiryDate,
    cleanActual || undefined
  );

  try {
    await updateDoc(doc(db, 'stock_batches', batch.id), {
      actualExpiryDate: cleanActual ? cleanActual : deleteField(),
      effectiveExpiryDate: nextEffective,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `stock_batches/${batch.id}`);
  }
}

export async function pullExpiredBatchStock(
  batch: StockBatch,
  product: Product | undefined,
  handlingNotes: string,
  user: { uid: string; displayName: string }
): Promise<void> {
  const today = getTodayDateString();
  const cleanNotes =
    handlingNotes.trim().slice(0, 240) ||
    `Penarikan batch kedaluwarsa ${batch.batchNumber} (ED ${batch.effectiveExpiryDate})`;
  const moveId = generateSafeId('stk');
  const meta = createTransactionMetadata('STK', user);

  const runOfflineFallback = async () => {
    const deductQty = Math.max(0, roundQty(Number(batch.remainingBaseQty) || 0));
    const currStock = Math.max(0, Number(product?.stock) || 0);
    const stockAfter = product
      ? snapStockToProductPrecision(Math.max(0, currStock - deductQty), product)
      : roundQty(Math.max(0, currStock - deductQty));
    const wb = writeBatch(db);

    wb.update(doc(db, 'stock_batches', batch.id), {
      remainingBaseQty: 0,
      status: 'pulled',
      handlingNotes: cleanNotes,
      handledDate: today,
      handledByUid: user.uid,
      handledByName: user.displayName.trim().slice(0, 100) || 'Admin',
      updatedAt: serverTimestamp(),
    });

    if (product && deductQty > 0) {
      wb.update(doc(db, 'products', product.id), {
        stock: stockAfter,
        updatedAt: serverTimestamp(),
      });
      wb.set(doc(db, 'stock_movements', moveId), {
        ...meta,
        productId: product.id,
        productName: product.name.slice(0, 120),
        baseUnit: product.unit.slice(0, 24),
        unitName: product.unit.slice(0, 24),
        unitQuantity: deductQty,
        conversion: 1,
        type: 'out',
        quantity: deductQty,
        stockBefore: currStock,
        stockAfter,
        referenceId: batch.id,
        notes: `${cleanNotes} (-${formatQty(deductQty)} ${product.unit})`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }
    await wb.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await runOfflineFallback();
      return;
    }

    try {
      await runTransaction(db, async (tx) => {
        const batchSnap = await tx.get(doc(db, 'stock_batches', batch.id));
        if (!batchSnap.exists()) {
          throw new Error('Data batch tidak ditemukan.');
        }
        const liveBatch = batchSnap.data() as StockBatch;
        const deductQty = Math.max(0, roundQty(Number(liveBatch.remainingBaseQty) || 0));
        const prodRef = doc(db, 'products', batch.productId);
        const prodSnap = await tx.get(prodRef);

        tx.update(doc(db, 'stock_batches', batch.id), {
          remainingBaseQty: 0,
          status: 'pulled',
          handlingNotes: cleanNotes,
          handledDate: today,
          handledByUid: user.uid,
          handledByName: user.displayName.trim().slice(0, 100) || 'Admin',
          updatedAt: serverTimestamp(),
        });

        if (prodSnap.exists() && deductQty > 0) {
          const liveProd = prodSnap.data() as Product;
          const stockBefore = Math.max(0, Number(liveProd.stock) || 0);
          const actualDeduct = roundQty(Math.min(stockBefore, deductQty));
          const stockAfter = snapStockToProductPrecision(
            Math.max(0, stockBefore - actualDeduct),
            liveProd
          );
          tx.update(prodRef, {
            stock: stockAfter,
            updatedAt: serverTimestamp(),
          });
          if (actualDeduct > 0) {
            tx.set(doc(db, 'stock_movements', moveId), {
              ...meta,
              productId: batch.productId,
              productName: liveProd.name.slice(0, 120),
              baseUnit: liveProd.unit.slice(0, 24),
              unitName: liveProd.unit.slice(0, 24),
              unitQuantity: actualDeduct,
              conversion: 1,
              type: 'out',
              quantity: actualDeduct,
              stockBefore,
              stockAfter,
              referenceId: batch.id,
              notes: `${cleanNotes} (-${formatQty(actualDeduct)} ${liveProd.unit})`.slice(0, 240),
              createdAt: serverTimestamp(),
            });
          }
        }
      });
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'unavailable' || code === 'failed-precondition') {
        await runOfflineFallback();
        return;
      }
      throw err;
    }
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `stock_batches/${batch.id}`);
  }
}

export async function markBatchHandledByAdmin(
  batch: StockBatch,
  handlingNotes: string,
  user: { uid: string; displayName: string }
): Promise<void> {
  const today = getTodayDateString();
  const cleanNotes =
    handlingNotes.trim().slice(0, 240) ||
    `Ditangani Admin pada ${today} untuk batch ${batch.batchNumber}`;

  try {
    await updateDoc(doc(db, 'stock_batches', batch.id), {
      status: 'handled',
      handlingNotes: cleanNotes,
      handledDate: today,
      handledByUid: user.uid,
      handledByName: user.displayName.trim().slice(0, 100) || 'Admin',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `stock_batches/${batch.id}`);
  }
}
