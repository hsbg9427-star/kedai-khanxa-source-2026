import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  Product,
  StockMovement,
  StockOpname,
  StockOpnameItem,
} from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import {
  createTransactionMetadata,
  formatQty,
  generateSafeId,
} from '../utils/formatters';
import {
  computeItemVariance,
  computeMovementAdjustedFinalStock,
  computePhysicalStockBase,
  summarizeOpnameItems,
} from '../utils/stockOpnameMath';
import { roundQty, snapStockToProductPrecision } from '../utils/unitConversion';

export interface StockOpnameDraftEdit {
  physicalUnitName: string;
  physicalUnitQty: number;
  physicalSubUnitName?: string;
  physicalSubUnitQty?: number;
  systemStockAtCount: number;
  countedAtMs?: number;
  reason?: string;
  isCounted: boolean;
}

export function subscribeStockOpnames(
  onData: (opnames: StockOpname[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'stock_opnames'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: StockOpname[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<StockOpname, 'id'>),
      }));
      list.sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));
      onData(list);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'stock_opnames');
    }
  );
}

export function subscribeStockOpnameItems(
  opnameId: string,
  onData: (items: StockOpnameItem[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'stock_opnames', opnameId, 'items'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: StockOpnameItem[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<StockOpnameItem, 'id'>),
      }));
      list.sort((a, b) => a.productName.localeCompare(b.productName, 'id'));
      onData(list);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, `stock_opnames/${opnameId}/items`);
    }
  );
}

export async function createStockOpnameSession(params: {
  title: string;
  categoryFilterId?: string;
  categoryFilterName?: string;
  notes?: string;
  products: Product[];
  user: { uid: string; displayName: string };
}): Promise<string> {
  const { title, categoryFilterId, categoryFilterName, notes, products, user } = params;
  const targetProducts = products.filter(
    (p) => p.isActive && (!categoryFilterId || p.categoryId === categoryFilterId)
  );

  if (targetProducts.length === 0) {
    throw new Error('Tidak ada produk aktif yang sesuai untuk sesi stok opname ini.');
  }

  const opnameId = generateSafeId('opn');
  const meta = createTransactionMetadata('OPN', user);
  const startedAtMs = Date.now();
  const cleanTitle = (title.trim() || `Stok Opname ${meta.transactionDate}`).slice(0, 120);

  const headerPayload = {
    ...meta,
    title: cleanTitle,
    ...(categoryFilterId ? { categoryFilterId } : {}),
    ...(categoryFilterName ? { categoryFilterName: categoryFilterName.slice(0, 60) } : {}),
    status: 'draft' as const,
    startedAtMs,
    lastSavedAt: serverTimestamp(),
    totalProducts: targetProducts.length,
    countedProducts: 0,
    matchedCount: 0,
    surplusCount: 0,
    deficitCount: 0,
    totalVarianceValue: 0,
    ...(notes?.trim() ? { notes: notes.trim().slice(0, 300) } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    const CHUNK_SIZE = 350;
    for (let i = 0; i < targetProducts.length; i += CHUNK_SIZE) {
      const chunk = targetProducts.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);

      if (i === 0) {
        batch.set(doc(db, 'stock_opnames', opnameId), headerPayload);
      }

      for (const product of chunk) {
        const cleanStock = snapStockToProductPrecision(Math.max(0, Number(product.stock) || 0), product);
        batch.set(doc(db, 'stock_opnames', opnameId, 'items', product.id), {
          opnameId,
          productId: product.id,
          sku: product.sku.slice(0, 40),
          ...(product.barcode ? { barcode: product.barcode.slice(0, 64) } : {}),
          productName: product.name.slice(0, 120),
          categoryId: product.categoryId,
          categoryName: product.categoryName.slice(0, 60),
          baseUnit: product.unit.slice(0, 24),
          costPrice: Math.max(0, Number(product.costPrice) || 0),
          systemStockAtStart: cleanStock,
          systemStockAtCount: cleanStock,
          movementSinceStart: 0,
          physicalUnitName: product.unit.slice(0, 24),
          physicalUnitQty: 0,
          varianceBase: 0,
          varianceStatus: 'uncounted',
          isCounted: false,
          recordedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    }

    return opnameId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `stock_opnames/${opnameId}`);
  }
}

export async function syncMissingProductsToDraft(params: {
  opname: StockOpname;
  existingItems: StockOpnameItem[];
  products: Product[];
  user: { uid: string; displayName: string };
}): Promise<number> {
  const { opname, existingItems, products, user } = params;
  if (opname.status !== 'draft') return 0;

  const existingIds = new Set(existingItems.map((i) => i.productId));
  const missingProducts = products.filter(
    (p) =>
      p.isActive &&
      (!opname.categoryFilterId || p.categoryId === opname.categoryFilterId) &&
      !existingIds.has(p.id)
  );

  if (missingProducts.length === 0) return 0;

  try {
    const CHUNK_SIZE = 350;
    for (let i = 0; i < missingProducts.length; i += CHUNK_SIZE) {
      const chunk = missingProducts.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);

      for (const product of chunk) {
        const cleanStock = snapStockToProductPrecision(Math.max(0, Number(product.stock) || 0), product);
        batch.set(doc(db, 'stock_opnames', opname.id, 'items', product.id), {
          opnameId: opname.id,
          productId: product.id,
          sku: product.sku.slice(0, 40),
          ...(product.barcode ? { barcode: product.barcode.slice(0, 64) } : {}),
          productName: product.name.slice(0, 120),
          categoryId: product.categoryId,
          categoryName: product.categoryName.slice(0, 60),
          baseUnit: product.unit.slice(0, 24),
          costPrice: Math.max(0, Number(product.costPrice) || 0),
          systemStockAtStart: cleanStock,
          systemStockAtCount: cleanStock,
          movementSinceStart: 0,
          physicalUnitName: product.unit.slice(0, 24),
          physicalUnitQty: 0,
          varianceBase: 0,
          varianceStatus: 'uncounted',
          isCounted: false,
          recordedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      }

      if (i + CHUNK_SIZE >= missingProducts.length) {
        batch.update(doc(db, 'stock_opnames', opname.id), {
          totalProducts: existingItems.length + missingProducts.length,
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    }
    return missingProducts.length;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `stock_opnames/${opname.id}`);
  }
}

function buildResolvedItemState(
  item: StockOpnameItem,
  edit: StockOpnameDraftEdit | undefined,
  liveProduct: Product | undefined
) {
  const productMeta: Product =
    liveProduct ||
    ({
      id: item.productId,
      sku: item.sku,
      name: item.productName,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      unit: item.baseUnit,
      costPrice: item.costPrice,
      sellPrice: 0,
      stock: item.systemStockAtCount,
      minStock: 0,
      isActive: true,
      createdByUid: item.recordedByUid,
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt,
    } as Product);

  const liveStock = liveProduct
    ? snapStockToProductPrecision(Math.max(0, Number(liveProduct.stock) || 0), productMeta)
    : item.systemStockAtCount;
  const movementSinceStart = roundQty(liveStock - item.systemStockAtStart);

  if (!edit) {
    return {
      productMeta,
      liveStock,
      movementSinceStart,
      isCounted: item.isCounted,
      physicalUnitName: item.physicalUnitName,
      physicalUnitQty: item.physicalUnitQty,
      physicalSubUnitName: item.physicalSubUnitName,
      physicalSubUnitQty: item.physicalSubUnitQty,
      physicalStockBase: item.physicalStockBase,
      systemStockAtCount: item.systemStockAtCount,
      varianceBase: item.varianceBase,
      varianceStatus: item.varianceStatus,
      reason: item.reason || '',
      countedAtMs: item.countedAtMs,
    };
  }

  const physicalStockBase = edit.isCounted
    ? computePhysicalStockBase(
        productMeta,
        edit.physicalUnitName,
        edit.physicalUnitQty,
        edit.physicalSubUnitName,
        edit.physicalSubUnitQty
      )
    : undefined;

  const baseline = snapStockToProductPrecision(Math.max(0, edit.systemStockAtCount), productMeta);
  const { varianceBase, varianceStatus } = computeItemVariance(
    physicalStockBase,
    baseline,
    productMeta
  );

  return {
    productMeta,
    liveStock,
    movementSinceStart,
    isCounted: edit.isCounted,
    physicalUnitName: edit.physicalUnitName || item.baseUnit,
    physicalUnitQty: Math.max(0, Number(edit.physicalUnitQty) || 0),
    physicalSubUnitName:
      edit.physicalSubUnitName && Number(edit.physicalSubUnitQty) > 0
        ? edit.physicalSubUnitName
        : undefined,
    physicalSubUnitQty:
      edit.physicalSubUnitName && Number(edit.physicalSubUnitQty) > 0
        ? Math.max(0, Number(edit.physicalSubUnitQty) || 0)
        : undefined,
    physicalStockBase,
    systemStockAtCount: baseline,
    varianceBase,
    varianceStatus,
    reason: (edit.reason || '').trim().slice(0, 240),
    countedAtMs: edit.isCounted ? edit.countedAtMs || Date.now() : undefined,
  };
}

export async function saveStockOpnameDraft(params: {
  opname: StockOpname;
  items: StockOpnameItem[];
  edits: Record<string, StockOpnameDraftEdit>;
  productsById: Map<string, Product>;
  notes?: string;
}): Promise<void> {
  const { opname, items, edits, productsById, notes } = params;
  if (opname.status !== 'draft') {
    throw new Error('Stok opname yang sudah difinalisasi tidak dapat diubah lagi.');
  }

  const resolvedAll = items.map((item) => ({
    item,
    resolved: buildResolvedItemState(item, edits[item.productId], productsById.get(item.productId)),
    isDirty: Boolean(edits[item.productId]),
  }));

  const summary = summarizeOpnameItems(
    resolvedAll.map((r) => ({
      isCounted: r.resolved.isCounted,
      varianceStatus: r.resolved.varianceStatus,
      varianceBase: r.resolved.varianceBase,
      costPrice: r.item.costPrice,
    }))
  );

  const dirtyRows = resolvedAll.filter((r) => r.isDirty);

  try {
    const CHUNK_SIZE = 350;
    if (dirtyRows.length === 0) {
      const batch = writeBatch(db);
      batch.update(doc(db, 'stock_opnames', opname.id), {
        countedProducts: summary.countedProducts,
        matchedCount: summary.matchedCount,
        surplusCount: summary.surplusCount,
        deficitCount: summary.deficitCount,
        totalVarianceValue: summary.totalVarianceValue,
        ...(notes !== undefined ? { notes: notes.trim().slice(0, 300) } : {}),
        lastSavedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      return;
    }

    for (let i = 0; i < dirtyRows.length; i += CHUNK_SIZE) {
      const chunk = dirtyRows.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);

      for (const { item, resolved } of chunk) {
        const payload: Record<string, unknown> = {
          opnameId: item.opnameId,
          productId: item.productId,
          sku: item.sku,
          ...(item.barcode ? { barcode: item.barcode } : {}),
          productName: item.productName,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          baseUnit: item.baseUnit,
          costPrice: item.costPrice,
          systemStockAtStart: item.systemStockAtStart,
          systemStockAtCount: resolved.systemStockAtCount,
          movementSinceStart: resolved.movementSinceStart,
          physicalUnitName: resolved.physicalUnitName.slice(0, 24),
          physicalUnitQty: resolved.physicalUnitQty,
          ...(resolved.physicalSubUnitName
            ? {
                physicalSubUnitName: resolved.physicalSubUnitName.slice(0, 24),
                physicalSubUnitQty: resolved.physicalSubUnitQty,
              }
            : {}),
          ...(resolved.physicalStockBase !== undefined
            ? { physicalStockBase: resolved.physicalStockBase }
            : {}),
          varianceBase: resolved.varianceBase,
          varianceStatus: resolved.varianceStatus,
          ...(resolved.reason ? { reason: resolved.reason } : {}),
          isCounted: resolved.isCounted,
          ...(resolved.countedAtMs ? { countedAtMs: resolved.countedAtMs } : {}),
          recordedByUid: item.recordedByUid,
          updatedAt: serverTimestamp(),
        };

        batch.set(doc(db, 'stock_opnames', opname.id, 'items', item.id), payload);
      }

      if (i + CHUNK_SIZE >= dirtyRows.length) {
        batch.update(doc(db, 'stock_opnames', opname.id), {
          countedProducts: summary.countedProducts,
          matchedCount: summary.matchedCount,
          surplusCount: summary.surplusCount,
          deficitCount: summary.deficitCount,
          totalVarianceValue: summary.totalVarianceValue,
          ...(notes !== undefined ? { notes: notes.trim().slice(0, 300) } : {}),
          lastSavedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `stock_opnames/${opname.id}`);
  }
}

export async function deleteDraftStockOpname(opnameId: string): Promise<void> {
  try {
    const itemsSnap = await getDocs(collection(db, 'stock_opnames', opnameId, 'items'));
    const docsToDelete = itemsSnap.docs;
    const CHUNK_SIZE = 350;

    if (docsToDelete.length === 0) {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'stock_opnames', opnameId));
      await batch.commit();
      return;
    }

    for (let i = 0; i < docsToDelete.length; i += CHUNK_SIZE) {
      const chunk = docsToDelete.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      for (const d of chunk) {
        batch.delete(doc(db, 'stock_opnames', opnameId, 'items', d.id));
      }
      if (i + CHUNK_SIZE >= docsToDelete.length) {
        batch.delete(doc(db, 'stock_opnames', opnameId));
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `stock_opnames/${opnameId}`);
  }
}

export async function finalizeStockOpname(params: {
  opname: StockOpname;
  items: StockOpnameItem[];
  edits: Record<string, StockOpnameDraftEdit>;
  productsById: Map<string, Product>;
  notes?: string;
  user: { uid: string; displayName: string };
}): Promise<{
  adjustedCount: number;
  matchedCount: number;
  surplusCount: number;
  deficitCount: number;
}> {
  const { opname, items, edits, productsById, notes, user } = params;

  if (opname.status !== 'draft') {
    throw new Error('Stok opname ini sudah difinalisasi sebelumnya.');
  }

  const resolvedEntries = items.map((item) => ({
    item,
    resolved: buildResolvedItemState(item, edits[item.productId], productsById.get(item.productId)),
  }));

  const countedEntries = resolvedEntries.filter((e) => e.resolved.isCounted);
  if (countedEntries.length === 0) {
    throw new Error('Minimal 1 produk harus diisi stok fisiknya sebelum melakukan finalisasi.');
  }

  const summary = summarizeOpnameItems(
    resolvedEntries.map((r) => ({
      isCounted: r.resolved.isCounted,
      varianceStatus: r.resolved.varianceStatus,
      varianceBase: r.resolved.varianceBase,
      costPrice: r.item.costPrice,
    }))
  );

  const finalizeMeta = createTransactionMetadata('OPF', user);
  let adjustedCount = 0;

  try {
    // Maksimal 90 item dihitung per runTransaction (read product + write product + write movement + write opnameItem <= 360 ops)
    const TX_CHUNK = 90;

    for (let i = 0; i < countedEntries.length; i += TX_CHUNK) {
      const chunk = countedEntries.slice(i, i + TX_CHUNK);
      const isLastChunk = i + TX_CHUNK >= countedEntries.length;

      await runTransaction(db, async (tx) => {
        // 1. Pastikan opname masih draft saat transaksi dimulai
        const opnameRef = doc(db, 'stock_opnames', opname.id);
        const opnameSnap = await tx.get(opnameRef);
        if (!opnameSnap.exists()) {
          throw new Error('Dokumen sesi stok opname tidak ditemukan.');
        }
        if ((opnameSnap.data() as StockOpname).status !== 'draft') {
          throw new Error('Sesi stok opname sudah difinalisasi oleh perangkat lain.');
        }

        // 2. Baca seluruh dokumen produk terbaru secara atomik
        const productDocs = await Promise.all(
          chunk.map((entry) => tx.get(doc(db, 'products', entry.item.productId)))
        );

        const plannedUpdates: {
          entry: (typeof chunk)[number];
          liveProduct: Product;
          currentSnapped: number;
          finalStock: number;
          netAdjustmentFromLive: number;
          movementSinceStart: number;
        }[] = [];

        for (let idx = 0; idx < chunk.length; idx++) {
          const entry = chunk[idx];
          const pSnap = productDocs[idx];
          if (!pSnap.exists()) {
            throw new Error(`Produk "${entry.item.productName}" tidak lagi ditemukan di master produk.`);
          }
          const liveProduct = { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) };

          const { currentSnapped, finalStock, netAdjustmentFromLive } =
            computeMovementAdjustedFinalStock(
              liveProduct.stock,
              entry.resolved.varianceBase,
              liveProduct
            );

          const movementSinceStart = roundQty(currentSnapped - entry.item.systemStockAtStart);

          plannedUpdates.push({
            entry,
            liveProduct,
            currentSnapped,
            finalStock,
            netAdjustmentFromLive,
            movementSinceStart,
          });
        }

        // 3. Terapkan pembaruan stok produk, catatan mutasi penyesuaian, dan item opname
        for (const plan of plannedUpdates) {
          const { entry, liveProduct, currentSnapped, finalStock, netAdjustmentFromLive, movementSinceStart } =
            plan;
          const { item, resolved } = entry;

          const hasStockChange = Math.abs(finalStock - currentSnapped) > 1e-5;
          if (hasStockChange) {
            adjustedCount++;
            tx.update(doc(db, 'products', liveProduct.id), {
              stock: finalStock,
              updatedAt: serverTimestamp(),
            });

            const moveId = generateSafeId('stk');
            const moveMeta = createTransactionMetadata('OPN', user);
            const moveAfterCount = roundQty(currentSnapped - resolved.systemStockAtCount);
            const reasonSuffix = resolved.reason ? ` · Alasan: ${resolved.reason}` : '';
            const moveNote =
              Math.abs(moveAfterCount) > 1e-5
                ? `Opname ${opname.transactionNumber}: fisik ${formatQty(
                    resolved.physicalStockBase ?? 0
                  )} ${liveProduct.unit}, mutasi selama opname ${
                    moveAfterCount > 0 ? '+' : ''
                  }${formatQty(moveAfterCount)} -> stok akhir ${formatQty(finalStock)}${reasonSuffix}`
                : `Opname ${opname.transactionNumber}: selisih ${
                    resolved.varianceBase > 0 ? '+' : ''
                  }${formatQty(resolved.varianceBase)} ${liveProduct.unit}${reasonSuffix}`;

            tx.set(doc(db, 'stock_movements', moveId), {
              ...moveMeta,
              productId: liveProduct.id,
              productName: liveProduct.name.slice(0, 120),
              baseUnit: liveProduct.unit.slice(0, 24),
              unitName: resolved.physicalUnitName.slice(0, 24),
              unitQuantity: resolved.physicalUnitQty,
              conversion: 1,
              type: 'adjustment',
              quantity: roundQty(Math.abs(netAdjustmentFromLive)),
              stockBefore: currentSnapped,
              stockAfter: finalStock,
              referenceId: opname.id,
              notes: moveNote.slice(0, 240),
              createdAt: serverTimestamp(),
            });
          }

          tx.set(doc(db, 'stock_opnames', opname.id, 'items', item.id), {
            opnameId: item.opnameId,
            productId: item.productId,
            sku: item.sku,
            ...(item.barcode ? { barcode: item.barcode } : {}),
            productName: item.productName,
            categoryId: item.categoryId,
            categoryName: item.categoryName,
            baseUnit: item.baseUnit,
            costPrice: item.costPrice,
            systemStockAtStart: item.systemStockAtStart,
            systemStockAtCount: resolved.systemStockAtCount,
            movementSinceStart,
            physicalUnitName: resolved.physicalUnitName.slice(0, 24),
            physicalUnitQty: resolved.physicalUnitQty,
            ...(resolved.physicalSubUnitName
              ? {
                  physicalSubUnitName: resolved.physicalSubUnitName.slice(0, 24),
                  physicalSubUnitQty: resolved.physicalSubUnitQty,
                }
              : {}),
            ...(resolved.physicalStockBase !== undefined
              ? { physicalStockBase: resolved.physicalStockBase }
              : {}),
            varianceBase: resolved.varianceBase,
            varianceStatus: resolved.varianceStatus,
            finalStockApplied: finalStock,
            ...(resolved.reason ? { reason: resolved.reason } : {}),
            isCounted: true,
            ...(resolved.countedAtMs ? { countedAtMs: resolved.countedAtMs } : {}),
            recordedByUid: item.recordedByUid,
            updatedAt: serverTimestamp(),
          });
        }

        // 4. Pada batch terakhir, kunci status header opname menjadi 'finalized'
        if (isLastChunk) {
          tx.update(opnameRef, {
            status: 'finalized',
            finalizedAt: serverTimestamp(),
            finalizedByUid: user.uid,
            finalizedByName: (user.displayName || 'Admin').slice(0, 100),
            finalizedDate: finalizeMeta.transactionDate,
            finalizedTime: finalizeMeta.transactionTime,
            countedProducts: summary.countedProducts,
            matchedCount: summary.matchedCount,
            surplusCount: summary.surplusCount,
            deficitCount: summary.deficitCount,
            totalVarianceValue: summary.totalVarianceValue,
            ...(notes !== undefined ? { notes: notes.trim().slice(0, 300) } : {}),
            updatedAt: serverTimestamp(),
          });
        }
      });
    }

    return {
      adjustedCount,
      matchedCount: summary.matchedCount,
      surplusCount: summary.surplusCount,
      deficitCount: summary.deficitCount,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      !(error as { code?: string })?.code &&
      !error.message.includes('Missing or insufficient permissions') &&
      !error.message.includes('permission-denied')
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `stock_opnames/${opname.id}`);
  }
}

export function subscribeMovementsDuringOpname(
  startedAtMs: number,
  onData: (movements: StockMovement[]) => void
): Unsubscribe {
  const q = query(collection(db, 'stock_movements'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const filtered: StockMovement[] = [];
      for (const d of snap.docs) {
        const data = d.data() as Omit<StockMovement, 'id'>;
        const createdMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
        if (createdMs >= startedAtMs - 1000) {
          filtered.push({ id: d.id, ...data });
        }
      }
      onData(filtered);
    },
    () => {}
  );
}
