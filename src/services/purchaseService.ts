import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  Account,
  Product,
  Purchase,
  PurchaseItem,
  PurchaseReturn,
  StockBatch,
  Supplier,
  SupplierPayment,
} from '../types/database';
import { buildStockBatchDocument } from './batchService';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import { createTransactionMetadata, formatQty, formatRupiah, generateSafeId } from '../utils/formatters';
import {
  calculatePurchaseSettlement,
  computePurchaseDraft,
  computePurchaseReturnPlan,
  getPurchaseDebtAmount,
  type PurchaseDraftLineInput,
  type PurchasePaymentMethod,
} from '../utils/purchaseCalculations';
import { roundMoney, roundQty } from '../utils/unitConversion';
import { roundUnitCost } from '../utils/purchaseCalculations';

function isOfflineTransactionError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (error as { code?: string })?.code || '';
  return code === 'unavailable' || code === 'failed-precondition';
}

export function subscribeSuppliers(
  onData: (suppliers: Supplier[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'suppliers'), orderBy('name', 'asc'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Supplier[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Supplier, 'id'>),
      }));
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'suppliers');
    }
  );
}

export function subscribePurchases(
  onData: (purchases: Purchase[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'purchases'), orderBy('transactionDate', 'desc'), limit(300));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Purchase[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Purchase, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'purchases');
    }
  );
}

export function subscribeSupplierPayments(
  onData: (payments: SupplierPayment[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'supplier_payments'), orderBy('transactionDate', 'desc'), limit(250));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: SupplierPayment[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<SupplierPayment, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'supplier_payments');
    }
  );
}

export function subscribePurchaseReturns(
  onData: (returns: PurchaseReturn[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'purchase_returns'), orderBy('transactionDate', 'desc'), limit(250));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: PurchaseReturn[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<PurchaseReturn, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'purchase_returns');
    }
  );
}

export async function fetchPurchaseItems(purchaseId: string): Promise<PurchaseItem[]> {
  try {
    const snap = await getDocs(collection(db, 'purchases', purchaseId, 'items'));
    return snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<PurchaseItem, 'id'>),
    }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `purchases/${purchaseId}/items`);
  }
}

export interface SupplierPayload {
  name: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export async function createSupplier(
  payload: SupplierPayload,
  userUid: string
): Promise<Supplier> {
  const cleanName = payload.name.trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('Nama pemasok wajib diisi.');
  }

  const supplierId = generateSafeId('sup');
  const cleanPhone = (payload.phone || '').trim().slice(0, 24);
  const cleanAddress = (payload.address || '').trim().slice(0, 200);
  const cleanNotes = (payload.notes || '').trim().slice(0, 200);

  const docBody = {
    name: cleanName,
    ...(cleanPhone ? { phone: cleanPhone } : {}),
    ...(cleanAddress ? { address: cleanAddress } : {}),
    ...(cleanNotes ? { notes: cleanNotes } : {}),
    totalDebt: 0,
    createdByUid: userUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'suppliers', supplierId), docBody);
    return {
      id: supplierId,
      name: cleanName,
      ...(cleanPhone ? { phone: cleanPhone } : {}),
      ...(cleanAddress ? { address: cleanAddress } : {}),
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      totalDebt: 0,
      createdByUid: userUid,
      createdAt: docBody.createdAt as Supplier['createdAt'],
      updatedAt: docBody.updatedAt as Supplier['updatedAt'],
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `suppliers/${supplierId}`);
  }
}

export async function updateSupplier(
  supplierId: string,
  payload: SupplierPayload
): Promise<void> {
  const cleanName = payload.name.trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('Nama pemasok wajib diisi.');
  }

  try {
    await updateDoc(doc(db, 'suppliers', supplierId), {
      name: cleanName,
      phone: (payload.phone || '').trim().slice(0, 24),
      address: (payload.address || '').trim().slice(0, 200),
      notes: (payload.notes || '').trim().slice(0, 200),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `suppliers/${supplierId}`);
  }
}

export async function deleteSupplier(supplier: Supplier): Promise<void> {
  if (roundMoney(Number(supplier.totalDebt) || 0) > 0) {
    throw new Error(
      `Pemasok "${supplier.name}" masih memiliki sisa utang sebesar ${formatRupiah(
        supplier.totalDebt
      )}. Lunasi utang terlebih dahulu sebelum menghapus.`
    );
  }
  try {
    await deleteDoc(doc(db, 'suppliers', supplier.id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `suppliers/${supplier.id}`);
  }
}

export interface RecordPurchaseInput {
  supplier?: Supplier | null;
  supplierName: string;
  invoiceNumber?: string;
  purchaseDate: string; // YYYY-MM-DD
  lines: PurchaseDraftLineInput[];
  discount: number;
  extraCost: number;
  paymentMethod: PurchasePaymentMethod;
  paidAmount?: number;
  account?: Account | null;
  notes?: string;
  existingPurchases?: Purchase[];
}

export async function recordPurchaseTransaction(
  input: RecordPurchaseInput,
  user: { uid: string; displayName: string }
): Promise<{ purchaseId: string; transactionNumber: string; totalAmount: number; debtAmount: number }> {
  const cleanSupplierName = (input.supplier?.name || input.supplierName || '').trim().slice(0, 120);
  if (!cleanSupplierName) {
    throw new Error('Pilih atau masukkan nama pemasok terlebih dahulu.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.purchaseDate)) {
    throw new Error('Tanggal pembelian harus berformat YYYY-MM-DD.');
  }

  const cleanInvoiceNumber = (input.invoiceNumber || '').trim().slice(0, 60);
  if (cleanInvoiceNumber && input.existingPurchases) {
    const duplicate = input.existingPurchases.find(
      (p) =>
        p.status === 'completed' &&
        (p.invoiceNumber || '').trim().toLowerCase() === cleanInvoiceNumber.toLowerCase() &&
        ((input.supplier && p.supplierId === input.supplier.id) ||
          p.supplierName.trim().toLowerCase() === cleanSupplierName.toLowerCase())
    );
    if (duplicate) {
      throw new Error(
        `Nomor faktur "${cleanInvoiceNumber}" dari pemasok "${cleanSupplierName}" sudah tercatat (${duplicate.transactionNumber}). Cegah pencatatan ganda.`
      );
    }
  }

  // Server check duplikasi faktur bila online dan nomor faktur diisi
  if (cleanInvoiceNumber && (typeof navigator === 'undefined' || navigator.onLine)) {
    const dupQuery = query(
      collection(db, 'purchases'),
      where('invoiceNumber', '==', cleanInvoiceNumber),
      limit(10)
    );
    const dupSnap = await getDocs(dupQuery);
    const dupOnline = dupSnap.docs.find((d) => {
      const p = d.data() as Purchase;
      return (
        p.status === 'completed' &&
        ((input.supplier && p.supplierId === input.supplier.id) ||
          p.supplierName.trim().toLowerCase() === cleanSupplierName.toLowerCase())
      );
    });
    if (dupOnline) {
      const dupData = dupOnline.data() as Purchase;
      throw new Error(
        `Nomor faktur "${cleanInvoiceNumber}" dari pemasok "${cleanSupplierName}" sudah tercatat (${dupData.transactionNumber}).`
      );
    }
  }

  const draft = computePurchaseDraft(input.lines, input.discount, input.extraCost);
  const settlement = calculatePurchaseSettlement({
    totalAmount: draft.totalAmount,
    paymentMethod: input.paymentMethod,
    paidAmount: input.paidAmount,
  });

  if (settlement.paidAmount > 0 && !input.account) {
    throw new Error('Pilih akun kas/DANA/rekening bank sumber pembayaran pembelian.');
  }
  if (settlement.paidAmount > 0 && input.account && !input.account.isActive) {
    throw new Error(`Akun "${input.account.name}" sedang nonaktif.`);
  }

  const purchaseId = generateSafeId('pur');
  const meta = {
    ...createTransactionMetadata('PMB', user),
    transactionDate: input.purchaseDate,
  };
  const cleanNotes = (input.notes || '').trim().slice(0, 240);

  const applyPurchaseWrites = (
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    },
    liveProducts: Map<string, Product>,
    liveAccount: Account | null,
    liveSupplier: Supplier | null
  ) => {
    // Re-compute draft against live product states so HPP & stock stay exact if concurrent update happened
    const liveInputs = input.lines.map((l) => ({
      ...l,
      product: liveProducts.get(l.product.id) || l.product,
    }));
    const liveDraft = computePurchaseDraft(liveInputs, input.discount, input.extraCost);

    if (settlement.paidAmount > 0 && liveAccount) {
      const balBefore = roundMoney(Number(liveAccount.balance) || 0);
      if (balBefore < settlement.paidAmount) {
        throw new Error(
          `Saldo ${liveAccount.name} (${formatRupiah(balBefore)}) tidak mencukupi untuk pembayaran pembelian ${formatRupiah(
            settlement.paidAmount
          )}.`
        );
      }
      const balAfter = roundMoney(balBefore - settlement.paidAmount);
      writer.update(doc(db, 'accounts', liveAccount.id), {
        balance: balAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });

      const ledgerId = generateSafeId('ldg');
      writer.set(doc(db, 'cash_ledger', ledgerId), {
        ...meta,
        accountId: liveAccount.id,
        accountName: liveAccount.name.slice(0, 80),
        direction: 'out',
        amount: settlement.paidAmount,
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        sourceModule: 'purchase',
        referenceId: purchaseId,
        description: `Pembelian ${cleanSupplierName}${
          cleanInvoiceNumber ? ` (Faktur ${cleanInvoiceNumber})` : ''
        } · ${meta.transactionNumber}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

    writer.set(doc(db, 'purchases', purchaseId), {
      ...meta,
      ...(cleanInvoiceNumber ? { invoiceNumber: cleanInvoiceNumber } : {}),
      ...(liveSupplier ? { supplierId: liveSupplier.id } : {}),
      supplierName: cleanSupplierName,
      subtotal: liveDraft.subtotal,
      discount: liveDraft.discount,
      extraCost: liveDraft.extraCost,
      totalAmount: liveDraft.totalAmount,
      paidAmount: settlement.paidAmount,
      debtAmount: settlement.debtAmount,
      returnedAmount: 0,
      paymentMethod: settlement.paymentMethod,
      paymentStatus: settlement.paymentStatus,
      ...(liveAccount && settlement.paidAmount > 0
        ? { accountId: liveAccount.id, accountName: liveAccount.name.slice(0, 80) }
        : {}),
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      status: 'completed',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (liveSupplier && settlement.debtAmount > 0) {
      const prevSupplierDebt = roundMoney(Math.max(0, Number(liveSupplier.totalDebt) || 0));
      writer.update(doc(db, 'suppliers', liveSupplier.id), {
        totalDebt: roundMoney(prevSupplierDebt + settlement.debtAmount),
        updatedAt: serverTimestamp(),
      });
    }

    // Items + Stock Batches + Stock Movements
    liveDraft.lines.forEach((line, idx) => {
      const itemId = generateSafeId(`pit${idx}`);
      writer.set(doc(db, 'purchases', purchaseId, 'items', itemId), {
        purchaseId,
        productId: line.product.id,
        productName: line.product.name.slice(0, 120),
        unitName: line.unitName.slice(0, 24),
        baseUnit: line.baseUnit.slice(0, 24),
        conversion: line.conversion,
        baseQuantity: line.baseQuantity,
        quantity: line.quantity,
        unitCost: line.unitCost,
        lineDiscount: line.lineDiscount,
        allocatedExtraCost: line.allocatedExtraCost,
        netLineTotal: line.netLineTotal,
        effectiveBaseUnitCost: line.effectiveBaseUnitCost,
        hppBefore: line.hppBefore,
        hppAfter: line.hppAfter,
        subtotal: line.afterLineDiscount,
        recordedByUid: user.uid,
        createdAt: serverTimestamp(),
      });

      const batchDoc = buildStockBatchDocument({
        productId: line.product.id,
        productName: line.product.name,
        productBrand: line.product.brand,
        productVariant: line.product.variant,
        baseUnit: line.baseUnit,
        sourceType: 'purchase',
        sourceRefId: purchaseId,
        sourceNumber: meta.transactionNumber,
        supplierName: cleanSupplierName,
        startDate: input.purchaseDate,
        actualExpiryDate: line.actualExpiryDate,
        initialBaseQty: line.baseQuantity,
        costPerBaseUnit: line.effectiveBaseUnitCost,
        user,
      });
      writer.set(doc(db, 'stock_batches', batchDoc.id), batchDoc.data);

      const moveId = generateSafeId(`stk${idx}`);
      const convNote =
        line.conversion !== 1
          ? ` (${formatQty(line.quantity)} ${line.unitName} = ${formatQty(line.baseQuantity)} ${line.baseUnit})`
          : ` (${formatQty(line.quantity)} ${line.unitName})`;
      writer.set(doc(db, 'stock_movements', moveId), {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-${idx + 1}`.slice(0, 40),
        productId: line.product.id,
        productName: line.product.name.slice(0, 120),
        baseUnit: line.baseUnit.slice(0, 24),
        unitName: line.unitName.slice(0, 24),
        unitQuantity: line.quantity,
        conversion: line.conversion,
        type: 'in',
        quantity: line.baseQuantity,
        stockBefore: line.stockBefore,
        stockAfter: line.stockAfter,
        referenceId: purchaseId,
        notes: `Pembelian ${cleanSupplierName}${
          cleanInvoiceNumber ? ` #${cleanInvoiceNumber}` : ''
        }${convNote} · Batch ${batchDoc.data.batchNumber}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    });

    // Update each distinct product once + log HPP change if changed
    liveDraft.productUpdates.forEach((upd, idx) => {
      writer.update(doc(db, 'products', upd.product.id), {
        stock: upd.stockAfter,
        costPrice: upd.hppAfter,
        updatedAt: serverTimestamp(),
      });

      if (upd.hppChanged) {
        const priceId = generateSafeId(`prc${idx}`);
        writer.set(doc(db, 'price_history', priceId), {
          ...meta,
          transactionNumber: `HPP-${meta.transactionNumber.slice(4)}-${idx + 1}`.slice(0, 40),
          productId: upd.product.id,
          productName: upd.product.name.slice(0, 120),
          baseUnit: upd.product.unit.slice(0, 24),
          changeType: 'update',
          costPriceBefore: upd.hppBefore,
          costPriceAfter: upd.hppAfter,
          sellPriceBefore: roundMoney(Math.max(0, Number(upd.product.sellPrice) || 0)),
          sellPriceAfter: roundMoney(Math.max(0, Number(upd.product.sellPrice) || 0)),
          ...(upd.product.wholesalePrice !== undefined
            ? {
                wholesalePriceBefore: roundMoney(Math.max(0, Number(upd.product.wholesalePrice) || 0)),
                wholesalePriceAfter: roundMoney(Math.max(0, Number(upd.product.wholesalePrice) || 0)),
              }
            : {}),
          summary: `HPP rata-rata tertimbang (Pembelian ${meta.transactionNumber}): ${formatRupiah(
            upd.hppBefore
          )} → ${formatRupiah(upd.hppAfter)}/${upd.product.unit}`.slice(0, 300),
          createdAt: serverTimestamp(),
        });
      }
    });
  };

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    const localProdMap = new Map<string, Product>();
    input.lines.forEach((l) => localProdMap.set(l.product.id, l.product));
    applyPurchaseWrites(batch, localProdMap, input.account || null, input.supplier || null);
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const uniqueProdIds = Array.from(new Set(input.lines.map((l) => l.product.id)));
          const prodSnaps = await Promise.all(
            uniqueProdIds.map((pid) => tx.get(doc(db, 'products', pid)))
          );
          const accSnap =
            settlement.paidAmount > 0 && input.account
              ? await tx.get(doc(db, 'accounts', input.account.id))
              : null;
          const supSnap = input.supplier
            ? await tx.get(doc(db, 'suppliers', input.supplier.id))
            : null;

          const liveProducts = new Map<string, Product>();
          uniqueProdIds.forEach((pid, idx) => {
            const pSnap = prodSnaps[idx];
            if (!pSnap.exists()) {
              throw new Error('Salah satu produk yang dipilih sudah tidak ditemukan di database.');
            }
            liveProducts.set(pid, { id: pid, ...(pSnap.data() as Omit<Product, 'id'>) });
          });

          let liveAccount: Account | null = null;
          if (accSnap) {
            if (!accSnap.exists()) {
              throw new Error('Akun kas/rekening yang dipilih tidak ditemukan.');
            }
            liveAccount = { id: accSnap.id, ...(accSnap.data() as Omit<Account, 'id'>) };
          }

          let liveSupplier: Supplier | null = null;
          if (supSnap) {
            if (!supSnap.exists()) {
              throw new Error('Data pemasok tidak ditemukan.');
            }
            liveSupplier = { id: supSnap.id, ...(supSnap.data() as Omit<Supplier, 'id'>) };
          }

          applyPurchaseWrites(tx, liveProducts, liveAccount, liveSupplier);
        });
      } catch (err) {
        if (isOfflineTransactionError(err)) {
          await executeOfflineBatch();
        } else {
          throw err;
        }
      }
    }

    return {
      purchaseId,
      transactionNumber: meta.transactionNumber,
      totalAmount: draft.totalAmount,
      debtAmount: settlement.debtAmount,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `purchases/${purchaseId}`);
  }
}

export interface RecordSupplierDebtPaymentInput {
  purchase: Purchase;
  supplier?: Supplier | null;
  amount: number;
  account: Account;
  notes?: string;
}

export async function recordSupplierDebtPayment(
  input: RecordSupplierDebtPaymentInput,
  user: { uid: string; displayName: string }
): Promise<{ paymentId: string; transactionNumber: string; debtAfter: number }> {
  if (input.purchase.status === 'void') {
    throw new Error('Faktur pembelian ini berstatus dibatalkan.');
  }

  const cleanAmount = roundMoney(Number(input.amount) || 0);
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
    throw new Error('Nominal pembayaran utang harus lebih dari Rp0.');
  }

  if (!input.account.isActive) {
    throw new Error(`Akun "${input.account.name}" sedang nonaktif.`);
  }

  const paymentId = generateSafeId('spay');
  const ledgerId = generateSafeId('ldg');
  const meta = createTransactionMetadata('BPM', user);
  const cleanNotes = (input.notes || '').trim().slice(0, 240);

  const applyPaymentWrites = (
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    },
    livePurchase: Purchase,
    liveAccount: Account,
    liveSupplier: Supplier | null
  ): number => {
    const debtBefore = getPurchaseDebtAmount(livePurchase);
    if (debtBefore <= 0) {
      throw new Error('Faktur pembelian ini sudah lunas.');
    }
    if (cleanAmount > debtBefore) {
      throw new Error(
        `Nominal pembayaran (${formatRupiah(cleanAmount)}) melebihi sisa utang faktur (${formatRupiah(
          debtBefore
        )}).`
      );
    }

    const balBefore = roundMoney(Number(liveAccount.balance) || 0);
    if (balBefore < cleanAmount) {
      throw new Error(
        `Saldo ${liveAccount.name} (${formatRupiah(balBefore)}) tidak mencukupi untuk membayar ${formatRupiah(
          cleanAmount
        )}.`
      );
    }

    const debtAfter = roundMoney(Math.max(0, debtBefore - cleanAmount));
    const currentPaid = roundMoney(
      livePurchase.paidAmount !== undefined
        ? Math.max(0, Number(livePurchase.paidAmount) || 0)
        : livePurchase.paymentMethod === 'credit'
          ? 0
          : Number(livePurchase.totalAmount) || 0
    );
    const paidAfter = roundMoney(currentPaid + cleanAmount);
    const paymentStatusAfter: 'paid' | 'partial' | 'unpaid' =
      debtAfter <= 0 ? 'paid' : paidAfter > 0 ? 'partial' : 'unpaid';
    const balAfter = roundMoney(balBefore - cleanAmount);

    writer.update(doc(db, 'purchases', livePurchase.id), {
      paidAmount: paidAfter,
      debtAmount: debtAfter,
      paymentStatus: paymentStatusAfter,
      updatedAt: serverTimestamp(),
    });

    if (liveSupplier) {
      const supDebtBefore = roundMoney(Math.max(0, Number(liveSupplier.totalDebt) || 0));
      writer.update(doc(db, 'suppliers', liveSupplier.id), {
        totalDebt: roundMoney(Math.max(0, supDebtBefore - cleanAmount)),
        updatedAt: serverTimestamp(),
      });
    }

    writer.update(doc(db, 'accounts', liveAccount.id), {
      balance: balAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });

    writer.set(doc(db, 'supplier_payments', paymentId), {
      ...meta,
      purchaseId: livePurchase.id,
      purchaseNumber: livePurchase.transactionNumber,
      ...(livePurchase.invoiceNumber ? { invoiceNumber: livePurchase.invoiceNumber } : {}),
      ...(livePurchase.supplierId ? { supplierId: livePurchase.supplierId } : {}),
      supplierName: livePurchase.supplierName.slice(0, 120),
      amount: cleanAmount,
      debtBefore,
      debtAfter,
      accountId: liveAccount.id,
      accountName: liveAccount.name.slice(0, 80),
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      createdAt: serverTimestamp(),
    });

    writer.set(doc(db, 'cash_ledger', ledgerId), {
      ...meta,
      accountId: liveAccount.id,
      accountName: liveAccount.name.slice(0, 80),
      direction: 'out',
      amount: cleanAmount,
      balanceBefore: balBefore,
      balanceAfter: balAfter,
      sourceModule: 'purchase',
      referenceId: livePurchase.id,
      description: `Bayar utang pemasok ${livePurchase.supplierName} (${livePurchase.transactionNumber})`.slice(
        0,
        240
      ),
      createdAt: serverTimestamp(),
    });

    return debtAfter;
  };

  let finalDebtAfter = 0;

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    finalDebtAfter = applyPaymentWrites(
      batch,
      input.purchase,
      input.account,
      input.supplier || null
    );
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const pSnap = await tx.get(doc(db, 'purchases', input.purchase.id));
          if (!pSnap.exists()) {
            throw new Error('Data faktur pembelian tidak ditemukan.');
          }
          const accSnap = await tx.get(doc(db, 'accounts', input.account.id));
          if (!accSnap.exists()) {
            throw new Error('Akun sumber dana tidak ditemukan.');
          }
          const supId = input.purchase.supplierId || input.supplier?.id;
          const supSnap = supId ? await tx.get(doc(db, 'suppliers', supId)) : null;

          const livePurchase = { id: pSnap.id, ...(pSnap.data() as Omit<Purchase, 'id'>) };
          const liveAccount = { id: accSnap.id, ...(accSnap.data() as Omit<Account, 'id'>) };
          const liveSupplier =
            supSnap && supSnap.exists()
              ? { id: supSnap.id, ...(supSnap.data() as Omit<Supplier, 'id'>) }
              : null;

          finalDebtAfter = applyPaymentWrites(tx, livePurchase, liveAccount, liveSupplier);
        });
      } catch (err) {
        if (isOfflineTransactionError(err)) {
          await executeOfflineBatch();
        } else {
          throw err;
        }
      }
    }

    return {
      paymentId,
      transactionNumber: meta.transactionNumber,
      debtAfter: finalDebtAfter,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `supplier_payments/${paymentId}`);
  }
}

export interface RecordPurchaseReturnInput {
  purchase: Purchase;
  item: PurchaseItem;
  product: Product;
  supplier?: Supplier | null;
  priorReturnsForItem: PurchaseReturn[];
  unitName: string;
  returnQty: number;
  unitRefundPrice: number;
  settlementPreference: 'auto' | 'reduce_debt' | 'cash_refund';
  account?: Account | null;
  reason?: string;
  batches?: StockBatch[];
}

export async function recordPurchaseReturn(
  input: RecordPurchaseReturnInput,
  user: { uid: string; displayName: string }
): Promise<{ returnId: string; transactionNumber: string; refundTotal: number }> {
  const initialPlan = computePurchaseReturnPlan({
    purchase: input.purchase,
    item: input.item,
    product: input.product,
    priorReturnsForItem: input.priorReturnsForItem,
    unitName: input.unitName,
    returnQty: input.returnQty,
    unitRefundPrice: input.unitRefundPrice,
    settlementPreference: input.settlementPreference,
  });

  if (initialPlan.cashRefundAmount > 0 && !input.account) {
    throw new Error('Pilih akun kas/rekening tujuan untuk menerima pengembalian dana retur.');
  }
  if (initialPlan.cashRefundAmount > 0 && input.account && !input.account.isActive) {
    throw new Error(`Akun "${input.account.name}" sedang nonaktif.`);
  }

  const returnId = generateSafeId('ret');
  const moveId = generateSafeId('stk');
  const ledgerId = generateSafeId('ldg');
  const meta = createTransactionMetadata('RTR', user);
  const cleanReason = (input.reason || '').trim().slice(0, 240);

  const applyReturnWrites = (
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    },
    livePurchase: Purchase,
    liveProduct: Product,
    liveAccount: Account | null,
    liveSupplier: Supplier | null
  ): number => {
    const plan = computePurchaseReturnPlan({
      purchase: livePurchase,
      item: input.item,
      product: liveProduct,
      priorReturnsForItem: input.priorReturnsForItem,
      unitName: input.unitName,
      returnQty: input.returnQty,
      unitRefundPrice: input.unitRefundPrice,
      settlementPreference: input.settlementPreference,
    });

    if (plan.cashRefundAmount > 0 && !liveAccount) {
      throw new Error('Pilih akun kas/rekening penerima dana pengembalian retur.');
    }

    const stockBefore = roundQty(Number(liveProduct.stock) || 0);
    // Hitung ulang HPP rata-rata persediaan setelah pengurangan nilai retur (bila stok > 0), tetap jaga >= 0
    const prevCostPrice = roundUnitCost(Number(liveProduct.costPrice) || 0);
    const prevValue = stockBefore * prevCostPrice;
    const nextCostPrice =
      plan.stockAfter > 0
        ? roundUnitCost(Math.max(0, (prevValue - plan.refundTotal) / plan.stockAfter))
        : prevCostPrice;

    writer.update(doc(db, 'products', liveProduct.id), {
      stock: plan.stockAfter,
      costPrice: nextCostPrice,
      updatedAt: serverTimestamp(),
    });

    if (Math.abs(nextCostPrice - prevCostPrice) >= 0.0001) {
      writer.set(doc(db, 'price_history', generateSafeId('prc')), {
        ...meta,
        transactionNumber: `HPP-${meta.transactionNumber}`.slice(0, 40),
        productId: liveProduct.id,
        productName: liveProduct.name.slice(0, 120),
        baseUnit: liveProduct.unit.slice(0, 24),
        changeType: 'update',
        costPriceBefore: prevCostPrice,
        costPriceAfter: nextCostPrice,
        sellPriceBefore: roundMoney(Math.max(0, Number(liveProduct.sellPrice) || 0)),
        sellPriceAfter: roundMoney(Math.max(0, Number(liveProduct.sellPrice) || 0)),
        ...(liveProduct.wholesalePrice !== undefined
          ? {
              wholesalePriceBefore: roundMoney(Math.max(0, Number(liveProduct.wholesalePrice) || 0)),
              wholesalePriceAfter: roundMoney(Math.max(0, Number(liveProduct.wholesalePrice) || 0)),
            }
          : {}),
        summary: `Penyesuaian HPP retur pembelian (${meta.transactionNumber}): ${formatRupiah(
          prevCostPrice
        )} → ${formatRupiah(nextCostPrice)}/${liveProduct.unit}`.slice(0, 300),
        createdAt: serverTimestamp(),
      });
    }

    writer.update(doc(db, 'purchases', livePurchase.id), {
      debtAmount: plan.purchaseDebtAfter,
      paidAmount: plan.purchasePaidAfter,
      returnedAmount: plan.purchaseReturnedAfter,
      paymentStatus: plan.purchasePaymentStatusAfter,
      updatedAt: serverTimestamp(),
    });

    if (liveSupplier && plan.debtReducedAmount > 0) {
      const supDebtBefore = roundMoney(Math.max(0, Number(liveSupplier.totalDebt) || 0));
      writer.update(doc(db, 'suppliers', liveSupplier.id), {
        totalDebt: roundMoney(Math.max(0, supDebtBefore - plan.debtReducedAmount)),
        updatedAt: serverTimestamp(),
      });
    }

    if (liveAccount && plan.cashRefundAmount > 0) {
      const balBefore = roundMoney(Number(liveAccount.balance) || 0);
      const balAfter = roundMoney(balBefore + plan.cashRefundAmount);
      writer.update(doc(db, 'accounts', liveAccount.id), {
        balance: balAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });

      writer.set(doc(db, 'cash_ledger', ledgerId), {
        ...meta,
        accountId: liveAccount.id,
        accountName: liveAccount.name.slice(0, 80),
        direction: 'in',
        amount: plan.cashRefundAmount,
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        sourceModule: 'purchase',
        referenceId: returnId,
        description: `Pengembalian dana retur pembelian ${livePurchase.supplierName} (${livePurchase.transactionNumber})`.slice(
          0,
          240
        ),
        createdAt: serverTimestamp(),
      });
    }

    writer.set(doc(db, 'stock_movements', moveId), {
      ...meta,
      productId: liveProduct.id,
      productName: liveProduct.name.slice(0, 120),
      baseUnit: liveProduct.unit.slice(0, 24),
      unitName: plan.unitName.slice(0, 24),
      unitQuantity: plan.returnQty,
      conversion: plan.conversion,
      type: 'out',
      quantity: plan.returnBaseQty,
      stockBefore,
      stockAfter: plan.stockAfter,
      referenceId: returnId,
      notes: `Retur pembelian ${livePurchase.transactionNumber} (${formatQty(plan.returnQty)} ${
        plan.unitName
      }${cleanReason ? ` · ${cleanReason}` : ''})`.slice(0, 240),
      createdAt: serverTimestamp(),
    });

    // Kurangi stok pada batch yang berasal dari faktur pembelian ini bila tersedia
    if (input.batches && input.batches.length > 0) {
      let remToDeduct = plan.returnBaseQty;
      const matchingBatches = input.batches.filter(
        (b) =>
          b.sourceRefId === livePurchase.id &&
          b.productId === liveProduct.id &&
          b.status === 'active' &&
          Number(b.remainingBaseQty) > 0.00001
      );
      for (const b of matchingBatches) {
        if (remToDeduct <= 0.0001) break;
        const avail = Math.max(0, roundQty(Number(b.remainingBaseQty) || 0));
        const take = roundQty(Math.min(avail, remToDeduct));
        const nextRem = roundQty(Math.max(0, avail - take));
        writer.update(doc(db, 'stock_batches', b.id), {
          remainingBaseQty: nextRem <= 0.0001 ? 0 : nextRem,
          status: nextRem <= 0.0001 ? 'depleted' : 'active',
          updatedAt: serverTimestamp(),
        });
        remToDeduct = roundQty(Math.max(0, remToDeduct - take));
      }
    }

    writer.set(doc(db, 'purchase_returns', returnId), {
      ...meta,
      purchaseId: livePurchase.id,
      purchaseNumber: livePurchase.transactionNumber,
      ...(livePurchase.supplierId ? { supplierId: livePurchase.supplierId } : {}),
      supplierName: livePurchase.supplierName.slice(0, 120),
      productId: liveProduct.id,
      productName: liveProduct.name.slice(0, 120),
      unitName: plan.unitName.slice(0, 24),
      baseUnit: plan.baseUnit.slice(0, 24),
      conversion: plan.conversion,
      returnQty: plan.returnQty,
      returnBaseQty: plan.returnBaseQty,
      unitRefundPrice: plan.unitRefundPrice,
      refundTotal: plan.refundTotal,
      settlementType: plan.settlementType,
      debtReducedAmount: plan.debtReducedAmount,
      cashRefundAmount: plan.cashRefundAmount,
      ...(liveAccount && plan.cashRefundAmount > 0
        ? { accountId: liveAccount.id, accountName: liveAccount.name.slice(0, 80) }
        : {}),
      ...(cleanReason ? { reason: cleanReason } : {}),
      createdAt: serverTimestamp(),
    });

    return plan.refundTotal;
  };

  let finalRefund = initialPlan.refundTotal;

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    finalRefund = applyReturnWrites(
      batch,
      input.purchase,
      input.product,
      input.account || null,
      input.supplier || null
    );
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const pSnap = await tx.get(doc(db, 'purchases', input.purchase.id));
          const prodSnap = await tx.get(doc(db, 'products', input.product.id));
          const accSnap = input.account ? await tx.get(doc(db, 'accounts', input.account.id)) : null;
          const supId = input.purchase.supplierId || input.supplier?.id;
          const supSnap = supId ? await tx.get(doc(db, 'suppliers', supId)) : null;

          if (!pSnap.exists()) throw new Error('Data faktur pembelian tidak ditemukan.');
          if (!prodSnap.exists()) throw new Error('Data produk tidak ditemukan.');

          const livePurchase = { id: pSnap.id, ...(pSnap.data() as Omit<Purchase, 'id'>) };
          const liveProduct = { id: prodSnap.id, ...(prodSnap.data() as Omit<Product, 'id'>) };
          const liveAccount =
            accSnap && accSnap.exists()
              ? { id: accSnap.id, ...(accSnap.data() as Omit<Account, 'id'>) }
              : null;
          const liveSupplier =
            supSnap && supSnap.exists()
              ? { id: supSnap.id, ...(supSnap.data() as Omit<Supplier, 'id'>) }
              : null;

          finalRefund = applyReturnWrites(
            tx,
            livePurchase,
            liveProduct,
            liveAccount,
            liveSupplier
          );
        });
      } catch (err) {
        if (isOfflineTransactionError(err)) {
          await executeOfflineBatch();
        } else {
          throw err;
        }
      }
    }

    return {
      returnId,
      transactionNumber: meta.transactionNumber,
      refundTotal: finalRefund,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `purchase_returns/${returnId}`);
  }
}
