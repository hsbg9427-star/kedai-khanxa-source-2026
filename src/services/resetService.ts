import {
  collection,
  deleteDoc,
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
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { ResetAuditLog, ResetOptionType } from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import { generateSafeId, getTodayDateString } from '../utils/formatters';

export const RESET_CONFIRMATION_PHRASE = 'RESET KEDAI KHANXA';

export interface ResetOptionMeta {
  id: ResetOptionType;
  number: number;
  title: string;
  shortLabel: string;
  description: string;
  targetCollections: string[];
  safeCollections: string[];
  requiresTypedPhrase: boolean;
  dangerBadge: 'Tinggi' | 'Kritis';
}

export const RESET_OPTIONS_META: ResetOptionMeta[] = [
  {
    id: 'products_stock',
    number: 1,
    title: '1. Reset Seluruh Data Produk dan Stok',
    shortLabel: 'Data Produk & Stok',
    description:
      'Menghapus seluruh master produk, kunci identitas produk, batch kedaluwarsa, riwayat harga beli/jual/grosir, dan log mutasi stok barang.',
    targetCollections: [
      'products',
      'product_identity_locks',
      'barcode_locks',
      'stock_batches',
      'price_history',
      'stock_movements',
    ],
    safeCollections: ['categories', 'store_settings', 'users', 'staff_invites'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'purchases_history',
    number: 2,
    title: '2. Reset Seluruh Riwayat Pembelian',
    shortLabel: 'Riwayat Pembelian',
    description:
      'Menghapus seluruh transaksi pembelian kulakan, subkoleksi item pembelian, riwayat pembayaran utang supplier, dan retur pembelian. Saldo utang pemasok direset ke Rp0.',
    targetCollections: ['purchases', 'purchases/items', 'supplier_payments', 'purchase_returns'],
    safeCollections: ['suppliers (nama/kontak tetap ada, utang = 0)', 'store_settings', 'accounts'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'sales_history',
    number: 3,
    title: '3. Reset Seluruh Riwayat Penjualan',
    shortLabel: 'Riwayat Penjualan',
    description:
      'Menghapus seluruh riwayat transaksi penjualan kasir retail beserta subkoleksi item penjualan.',
    targetCollections: ['sales', 'sales/items'],
    safeCollections: ['products', 'customers', 'store_settings', 'accounts'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'accounts_balance_mutation',
    number: 4,
    title: '4. Reset Saldo dan Mutasi Akun Operasional',
    shortLabel: 'Saldo & Mutasi Akun',
    description:
      'Mereset saldo seluruh akun kas/bank/ewallet menjadi Rp0, serta menghapus seluruh buku besar mutasi (cash ledger), beban operasional, dan ringkasan laporan keuangan.',
    targetCollections: ['cash_ledger', 'expenses', 'financial_summaries'],
    safeCollections: ['accounts (nama akun tetap ada, saldo = Rp0)', 'store_settings'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'customers_receivables',
    number: 5,
    title: '5. Reset Data Pelanggan dan Piutang',
    shortLabel: 'Pelanggan & Piutang',
    description:
      'Menghapus data pelanggan, seluruh riwayat kasbon/piutang (receivables), serta data pinjaman uang (loans & cicilan).',
    targetCollections: ['customers', 'receivables', 'loans', 'loan_payments'],
    safeCollections: ['store_settings', 'users', 'products', 'accounts'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'mini_atm',
    number: 6,
    title: '6. Reset Transaksi Mini ATM',
    shortLabel: 'Transaksi Mini ATM',
    description:
      'Menghapus seluruh riwayat transaksi Mini ATM (tarik tunai, transfer) dan log audit perubahan biaya.',
    targetCollections: ['mini_atm_transactions', 'mini_atm_fee_audits'],
    safeCollections: ['mini_atm_settings (tarif & bank tetap ada)', 'accounts', 'store_settings'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'ppob',
    number: 7,
    title: '7. Reset Transaksi PPOB',
    shortLabel: 'Transaksi PPOB',
    description:
      'Menghapus seluruh riwayat transaksi penjualan pulsa, paket data, tagihan PLN, PDAM, BPJS, dan e-wallet.',
    targetCollections: ['ppob_transactions'],
    safeCollections: ['accounts (deposit PPOB)', 'store_settings', 'users'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'stock_fifo_history',
    number: 8,
    title: '8. Reset Seluruh Riwayat Stok dan Batch FIFO',
    shortLabel: 'Riwayat Stok & Batch',
    description:
      'Menghapus seluruh log mutasi stok masuk/keluar, batch kedaluwarsa, dan riwayat harga, serta mengosongkan saldo stok seluruh produk menjadi 0 tanpa menghapus nama produk.',
    targetCollections: ['stock_movements', 'stock_batches', 'price_history'],
    safeCollections: ['products (master produk tetap ada, stok = 0)', 'categories', 'store_settings'],
    requiresTypedPhrase: false,
    dangerBadge: 'Tinggi',
  },
  {
    id: 'all_operational',
    number: 9,
    title: '9. Reset Semua Data Operasional Sekaligus',
    shortLabel: 'Semua Data Operasional',
    description:
      'MENGHAPUS SEMUA DATA OPERASIONAL SEKALIGUS: seluruh produk, batch kedaluwarsa, stok, pembelian, penjualan, saldo kas/bank, kasbon, pelanggan, pinjaman, Mini ATM, dan PPOB. Aplikasi kembali bersih untuk operasional baru.',
    targetCollections: [
      'products',
      'product_identity_locks',
      'barcode_locks',
      'stock_batches',
      'price_history',
      'stock_movements',
      'purchases',
      'purchases/items',
      'supplier_payments',
      'purchase_returns',
      'sales',
      'sales/items',
      'cash_ledger',
      'expenses',
      'financial_summaries',
      'customers',
      'receivables',
      'loans',
      'loan_payments',
      'mini_atm_transactions',
      'mini_atm_fee_audits',
      'ppob_transactions',
    ],
    safeCollections: [
      'users (akun Admin & Kasir)',
      'staff_invites',
      'system_config/bootstrap',
      'store_settings (identitas kedai, HPP, MDR QRIS)',
      'mini_atm_settings (konfigurasi tarif Mini ATM)',
      'categories (kategori produk)',
      'accounts (nama akun kas & bank, saldo direset ke 0)',
    ],
    requiresTypedPhrase: true,
    dangerBadge: 'Kritis',
  },
];

export interface ResetTargetCounts {
  products: number;
  stock_batches: number;
  price_history: number;
  stock_movements: number;
  purchases: number;
  supplier_payments: number;
  purchase_returns: number;
  sales: number;
  cash_ledger: number;
  expenses: number;
  financial_summaries: number;
  customers: number;
  receivables: number;
  loans: number;
  loan_payments: number;
  mini_atm_transactions: number;
  mini_atm_fee_audits: number;
  ppob_transactions: number;
  accounts: number;
}

export async function fetchResetTargetCounts(): Promise<ResetTargetCounts> {
  const collections = [
    'products',
    'stock_batches',
    'price_history',
    'stock_movements',
    'purchases',
    'supplier_payments',
    'purchase_returns',
    'sales',
    'cash_ledger',
    'expenses',
    'financial_summaries',
    'customers',
    'receivables',
    'loans',
    'loan_payments',
    'mini_atm_transactions',
    'mini_atm_fee_audits',
    'ppob_transactions',
    'accounts',
  ] as const;

  const counts: Record<string, number> = {};
  await Promise.all(
    collections.map(async (colName) => {
      try {
        const snap = await getDocs(collection(db, colName));
        counts[colName] = snap.size;
      } catch {
        counts[colName] = 0;
      }
    })
  );

  return counts as unknown as ResetTargetCounts;
}

export function computeOptionTargetCount(
  optionId: ResetOptionType,
  counts: ResetTargetCounts
): number {
  switch (optionId) {
    case 'products_stock':
      return (
        (counts.products || 0) +
        (counts.stock_batches || 0) +
        (counts.price_history || 0) +
        (counts.stock_movements || 0)
      );
    case 'purchases_history':
      return (
        (counts.purchases || 0) +
        (counts.supplier_payments || 0) +
        (counts.purchase_returns || 0)
      );
    case 'sales_history':
      return counts.sales || 0;
    case 'accounts_balance_mutation':
      return (
        (counts.accounts || 0) +
        (counts.cash_ledger || 0) +
        (counts.expenses || 0) +
        (counts.financial_summaries || 0)
      );
    case 'customers_receivables':
      return (
        (counts.customers || 0) +
        (counts.receivables || 0) +
        (counts.loans || 0) +
        (counts.loan_payments || 0)
      );
    case 'mini_atm':
      return (counts.mini_atm_transactions || 0) + (counts.mini_atm_fee_audits || 0);
    case 'ppob':
      return counts.ppob_transactions || 0;
    case 'stock_fifo_history':
      return (
        (counts.stock_movements || 0) +
        (counts.stock_batches || 0) +
        (counts.price_history || 0)
      );
    case 'all_operational':
      return Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    default:
      return 0;
  }
}

export interface BackupOperationalData {
  backupTitle: string;
  exportedAt: string;
  storeName: string;
  resetType: ResetOptionType;
  totalDocuments: number;
  collections: Record<string, Record<string, unknown>[]>;
}

export async function exportOperationalBackup(
  resetType: ResetOptionType,
  storeName: string
): Promise<{ filename: string; jsonString: string; totalItems: number }> {
  const meta = RESET_OPTIONS_META.find((m) => m.id === resetType);
  if (!meta) {
    throw new Error('Pilihan reset data tidak valid.');
  }

  const collectionsToExport: string[] = [];
  if (resetType === 'products_stock' || resetType === 'all_operational') {
    collectionsToExport.push(
      'products',
      'stock_batches',
      'product_identity_locks',
      'barcode_locks',
      'price_history',
      'stock_movements'
    );
  }
  if (resetType === 'purchases_history' || resetType === 'all_operational') {
    collectionsToExport.push('purchases', 'supplier_payments', 'purchase_returns', 'suppliers');
  }
  if (resetType === 'sales_history' || resetType === 'all_operational') {
    collectionsToExport.push('sales');
  }
  if (resetType === 'accounts_balance_mutation' || resetType === 'all_operational') {
    collectionsToExport.push('accounts', 'cash_ledger', 'expenses', 'financial_summaries');
  }
  if (resetType === 'customers_receivables' || resetType === 'all_operational') {
    collectionsToExport.push('customers', 'receivables', 'loans', 'loan_payments');
  }
  if (resetType === 'mini_atm' || resetType === 'all_operational') {
    collectionsToExport.push('mini_atm_transactions', 'mini_atm_fee_audits');
  }
  if (resetType === 'ppob' || resetType === 'all_operational') {
    collectionsToExport.push('ppob_transactions');
  }
  if (resetType === 'stock_fifo_history' && !collectionsToExport.includes('stock_movements')) {
    collectionsToExport.push('stock_movements', 'stock_batches', 'price_history');
  }

  const uniqueCollections = Array.from(new Set(collectionsToExport));
  const backupCollections: Record<string, Record<string, unknown>[]> = {};
  let totalDocs = 0;

  for (const colName of uniqueCollections) {
    try {
      const snap = await getDocs(collection(db, colName));
      const docsData: Record<string, unknown>[] = [];

      for (const d of snap.docs) {
        const docObj = { id: d.id, ...d.data() };
        if (colName === 'sales') {
          try {
            const subSnap = await getDocs(collection(db, 'sales', d.id, 'items'));
            (docObj as Record<string, unknown>)._subcollection_items = subSnap.docs.map((sd) => ({
              id: sd.id,
              ...sd.data(),
            }));
            totalDocs += subSnap.size;
          } catch {
            // Abaikan jika tidak ada subkoleksi
          }
        } else if (colName === 'purchases') {
          try {
            const subSnap = await getDocs(collection(db, 'purchases', d.id, 'items'));
            (docObj as Record<string, unknown>)._subcollection_items = subSnap.docs.map((sd) => ({
              id: sd.id,
              ...sd.data(),
            }));
            totalDocs += subSnap.size;
          } catch {
            // Abaikan
          }
        }
        docsData.push(docObj);
      }

      backupCollections[colName] = docsData;
      totalDocs += docsData.length;
    } catch (err) {
      console.warn(`Gagal mencadangkan koleksi ${colName}:`, err);
    }
  }

  const exportPayload: BackupOperationalData = {
    backupTitle: `CADANGAN DATA KEDAI KHANXA - ${meta.shortLabel.toUpperCase()}`,
    exportedAt: new Date().toISOString(),
    storeName,
    resetType,
    totalDocuments: totalDocs,
    collections: backupCollections,
  };

  const todayStr = getTodayDateString().replace(/-/g, '');
  const filename = `BACKUP_${storeName.replace(/\s+/g, '_')}_${resetType}_${todayStr}.json`;
  const jsonString = JSON.stringify(exportPayload, null, 2);

  return { filename, jsonString, totalItems: totalDocs };
}

export function triggerDownloadJson(filename: string, jsonString: string): void {
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Helper untuk batch delete/write dengan batas max 400 dokumen per batch
class ChunkedBatchWriter {
  private batch = writeBatch(db);
  private count = 0;
  private readonly maxPerBatch = 400;
  public totalOperations = 0;

  async addDelete(ref: ReturnType<typeof doc>): Promise<void> {
    this.batch.delete(ref);
    this.count++;
    this.totalOperations++;
    if (this.count >= this.maxPerBatch) {
      await this.commit();
    }
  }

  async addUpdate(
    ref: ReturnType<typeof doc>,
    data: Record<string, unknown>
  ): Promise<void> {
    this.batch.update(ref, data);
    this.count++;
    this.totalOperations++;
    if (this.count >= this.maxPerBatch) {
      await this.commit();
    }
  }

  async commit(): Promise<void> {
    if (this.count > 0) {
      await this.batch.commit();
      this.batch = writeBatch(db);
      this.count = 0;
    }
  }
}

export interface ResetExecutionResult {
  success: boolean;
  resetType: ResetOptionType;
  resetLabel: string;
  totalDeleted: number;
  summary: string;
  executedAt: string;
  errors?: string[];
}

export async function executeDataReset(params: {
  resetType: ResetOptionType;
  confirmationPhrase?: string;
  user: { uid: string; displayName: string };
  storeName?: string;
}): Promise<ResetExecutionResult> {
  const meta = RESET_OPTIONS_META.find((m) => m.id === params.resetType);
  if (!meta) {
    throw new Error('Pilihan reset data tidak valid.');
  }

  if (meta.requiresTypedPhrase) {
    const typed = (params.confirmationPhrase || '').trim();
    if (typed !== RESET_CONFIRMATION_PHRASE) {
      throw new Error(
        `Frasa konfirmasi tidak cocok. Ketik tepat "${RESET_CONFIRMATION_PHRASE}" dengan huruf kapital untuk melanjutkan.`
      );
    }
  }

  const writer = new ChunkedBatchWriter();
  const errors: string[] = [];
  const logDetails: string[] = [];

  const shouldResetProducts =
    params.resetType === 'products_stock' || params.resetType === 'all_operational';
  const shouldResetStockOnly = params.resetType === 'stock_fifo_history';
  const shouldResetPurchases =
    params.resetType === 'purchases_history' || params.resetType === 'all_operational';
  const shouldResetSales =
    params.resetType === 'sales_history' || params.resetType === 'all_operational';
  const shouldResetAccountsMutation =
    params.resetType === 'accounts_balance_mutation' || params.resetType === 'all_operational';
  const shouldResetCustomers =
    params.resetType === 'customers_receivables' || params.resetType === 'all_operational';
  const shouldResetMiniAtm =
    params.resetType === 'mini_atm' || params.resetType === 'all_operational';
  const shouldResetPpob =
    params.resetType === 'ppob' || params.resetType === 'all_operational';

  // 1. Reset Riwayat Penjualan (Sales & Subcollection items)
  if (shouldResetSales) {
    try {
      const salesSnap = await getDocs(collection(db, 'sales'));
      let itemsDeleted = 0;
      for (const sDoc of salesSnap.docs) {
        try {
          const itemsSnap = await getDocs(collection(db, 'sales', sDoc.id, 'items'));
          for (const itemDoc of itemsSnap.docs) {
            await writer.addDelete(doc(db, 'sales', sDoc.id, 'items', itemDoc.id));
            itemsDeleted++;
          }
        } catch (e) {
          errors.push(`Gagal membaca item penjualan ${sDoc.id}: ${String(e)}`);
        }
        await writer.addDelete(doc(db, 'sales', sDoc.id));
      }
      logDetails.push(`Penjualan: ${salesSnap.size} transaksi & ${itemsDeleted} rincian item dihapus.`);
    } catch (e) {
      errors.push(`Koleksi penjualan: ${String(e)}`);
    }
  }

  // 2. Reset Riwayat Pembelian (Purchases, items, supplier_payments, purchase_returns)
  if (shouldResetPurchases) {
    try {
      const purSnap = await getDocs(collection(db, 'purchases'));
      let purItemsDeleted = 0;
      for (const pDoc of purSnap.docs) {
        try {
          const itemsSnap = await getDocs(collection(db, 'purchases', pDoc.id, 'items'));
          for (const itemDoc of itemsSnap.docs) {
            await writer.addDelete(doc(db, 'purchases', pDoc.id, 'items', itemDoc.id));
            purItemsDeleted++;
          }
        } catch (e) {
          errors.push(`Gagal membaca item pembelian ${pDoc.id}: ${String(e)}`);
        }
        await writer.addDelete(doc(db, 'purchases', pDoc.id));
      }

      const paySnap = await getDocs(collection(db, 'supplier_payments'));
      for (const payDoc of paySnap.docs) {
        await writer.addDelete(doc(db, 'supplier_payments', payDoc.id));
      }

      const retSnap = await getDocs(collection(db, 'purchase_returns'));
      for (const retDoc of retSnap.docs) {
        await writer.addDelete(doc(db, 'purchase_returns', retDoc.id));
      }

      // Reset utang supplier menjadi 0
      const supSnap = await getDocs(collection(db, 'suppliers'));
      for (const supDoc of supSnap.docs) {
        await writer.addUpdate(doc(db, 'suppliers', supDoc.id), {
          totalDebt: 0,
          updatedAt: serverTimestamp(),
        });
      }

      logDetails.push(
        `Pembelian: ${purSnap.size} pembelian (${purItemsDeleted} item), ${paySnap.size} bayar utang, ${retSnap.size} retur dihapus. Saldo utang ${supSnap.size} supplier direset ke Rp0.`
      );
    } catch (e) {
      errors.push(`Koleksi pembelian: ${String(e)}`);
    }
  }

  // 3. Reset Produk & Stok (atau Stock FIFO History saja)
  if (shouldResetProducts) {
    try {
      const prodSnap = await getDocs(collection(db, 'products'));
      for (const prodDoc of prodSnap.docs) {
        await writer.addDelete(doc(db, 'products', prodDoc.id));
      }

      const idLockSnap = await getDocs(collection(db, 'product_identity_locks'));
      for (const lDoc of idLockSnap.docs) {
        await writer.addDelete(doc(db, 'product_identity_locks', lDoc.id));
      }

      const bcLockSnap = await getDocs(collection(db, 'barcode_locks'));
      for (const bDoc of bcLockSnap.docs) {
        await writer.addDelete(doc(db, 'barcode_locks', bDoc.id));
      }

      const batchSnap = await getDocs(collection(db, 'stock_batches'));
      for (const btDoc of batchSnap.docs) {
        await writer.addDelete(doc(db, 'stock_batches', btDoc.id));
      }

      const priceSnap = await getDocs(collection(db, 'price_history'));
      for (const prDoc of priceSnap.docs) {
        await writer.addDelete(doc(db, 'price_history', prDoc.id));
      }

      const moveSnap = await getDocs(collection(db, 'stock_movements'));
      for (const mvDoc of moveSnap.docs) {
        await writer.addDelete(doc(db, 'stock_movements', mvDoc.id));
      }

      logDetails.push(
        `Produk: ${prodSnap.size} produk, ${batchSnap.size} batch stok, ${priceSnap.size} riwayat harga, dan ${moveSnap.size} log stok dihapus.`
      );
    } catch (e) {
      errors.push(`Koleksi produk & stok: ${String(e)}`);
    }
  } else if (shouldResetStockOnly) {
    try {
      const moveSnap = await getDocs(collection(db, 'stock_movements'));
      for (const mvDoc of moveSnap.docs) {
        await writer.addDelete(doc(db, 'stock_movements', mvDoc.id));
      }

      const batchSnap = await getDocs(collection(db, 'stock_batches'));
      for (const btDoc of batchSnap.docs) {
        await writer.addDelete(doc(db, 'stock_batches', btDoc.id));
      }

      const priceSnap = await getDocs(collection(db, 'price_history'));
      for (const prDoc of priceSnap.docs) {
        await writer.addDelete(doc(db, 'price_history', prDoc.id));
      }

      const prodSnap = await getDocs(collection(db, 'products'));
      for (const prodDoc of prodSnap.docs) {
        await writer.addUpdate(doc(db, 'products', prodDoc.id), {
          stock: 0,
          updatedAt: serverTimestamp(),
        });
      }

      logDetails.push(
        `Riwayat Stok FIFO: ${moveSnap.size} log mutasi, ${batchSnap.size} batch kedaluwarsa, & ${priceSnap.size} riwayat harga dihapus. Stok pada ${prodSnap.size} produk direset ke 0.`
      );
    } catch (e) {
      errors.push(`Koleksi riwayat stok: ${String(e)}`);
    }
  }

  // 4. Reset Saldo & Mutasi Akun Operasional
  if (shouldResetAccountsMutation) {
    try {
      const ldgSnap = await getDocs(collection(db, 'cash_ledger'));
      for (const lDoc of ldgSnap.docs) {
        await writer.addDelete(doc(db, 'cash_ledger', lDoc.id));
      }

      const expSnap = await getDocs(collection(db, 'expenses'));
      for (const expDoc of expSnap.docs) {
        await writer.addDelete(doc(db, 'expenses', expDoc.id));
      }

      const finSnap = await getDocs(collection(db, 'financial_summaries'));
      for (const finDoc of finSnap.docs) {
        await writer.addDelete(doc(db, 'financial_summaries', finDoc.id));
      }

      // Reset balance seluruh akun menjadi 0 (akun tetap ada)
      const accSnap = await getDocs(collection(db, 'accounts'));
      for (const accDoc of accSnap.docs) {
        await writer.addUpdate(doc(db, 'accounts', accDoc.id), {
          balance: 0,
          updatedByUid: params.user.uid,
          updatedAt: serverTimestamp(),
        });
      }

      logDetails.push(
        `Mutasi Akun: ${ldgSnap.size} buku kas, ${expSnap.size} pengeluaran, dan ${finSnap.size} rekap laba dihapus. Saldo ${accSnap.size} akun kas/bank direset ke Rp0.`
      );
    } catch (e) {
      errors.push(`Koleksi akun & mutasi: ${String(e)}`);
    }
  }

  // 5. Reset Pelanggan & Piutang (Customers, Receivables, Loans, LoanPayments)
  if (shouldResetCustomers) {
    try {
      const recSnap = await getDocs(collection(db, 'receivables'));
      for (const rDoc of recSnap.docs) {
        await writer.addDelete(doc(db, 'receivables', rDoc.id));
      }

      const custSnap = await getDocs(collection(db, 'customers'));
      for (const cDoc of custSnap.docs) {
        await writer.addDelete(doc(db, 'customers', cDoc.id));
      }

      const loanSnap = await getDocs(collection(db, 'loans'));
      for (const lDoc of loanSnap.docs) {
        await writer.addDelete(doc(db, 'loans', lDoc.id));
      }

      const paySnap = await getDocs(collection(db, 'loan_payments'));
      for (const lpDoc of paySnap.docs) {
        await writer.addDelete(doc(db, 'loan_payments', lpDoc.id));
      }

      logDetails.push(
        `Pelanggan & Piutang: ${custSnap.size} pelanggan, ${recSnap.size} piutang kasbon, ${loanSnap.size} pinjaman uang, dan ${paySnap.size} cicilan dihapus.`
      );
    } catch (e) {
      errors.push(`Koleksi pelanggan & piutang: ${String(e)}`);
    }
  }

  // 6. Reset Transaksi Mini ATM
  if (shouldResetMiniAtm) {
    try {
      const atmSnap = await getDocs(collection(db, 'mini_atm_transactions'));
      for (const aDoc of atmSnap.docs) {
        await writer.addDelete(doc(db, 'mini_atm_transactions', aDoc.id));
      }

      const auditSnap = await getDocs(collection(db, 'mini_atm_fee_audits'));
      for (const auDoc of auditSnap.docs) {
        await writer.addDelete(doc(db, 'mini_atm_fee_audits', auDoc.id));
      }

      logDetails.push(
        `Mini ATM: ${atmSnap.size} transaksi dan ${auditSnap.size} audit biaya dihapus.`
      );
    } catch (e) {
      errors.push(`Koleksi Mini ATM: ${String(e)}`);
    }
  }

  // 7. Reset Transaksi PPOB
  if (shouldResetPpob) {
    try {
      const ppobSnap = await getDocs(collection(db, 'ppob_transactions'));
      for (const pDoc of ppobSnap.docs) {
        await writer.addDelete(doc(db, 'ppob_transactions', pDoc.id));
      }

      logDetails.push(`PPOB: ${ppobSnap.size} transaksi PPOB dihapus.`);
    } catch (e) {
      errors.push(`Koleksi PPOB: ${String(e)}`);
    }
  }

  // Selesaikan seluruh operasi commit batch Firestore
  await writer.commit();

  const isSuccess = errors.length === 0;
  const summaryText = logDetails.join(' ') || 'Tidak ada dokumen yang diubah.';

  // 8. Catat Log Audit Reset di koleksi reset_logs
  try {
    const logId = generateSafeId('rst');
    await setDoc(doc(db, 'reset_logs', logId), {
      resetType: params.resetType,
      resetLabel: meta.title.slice(0, 120),
      itemsDeletedCount: writer.totalOperations,
      details: summaryText.slice(0, 1000),
      recordedByUid: params.user.uid,
      recordedByName: (params.user.displayName || 'Admin').slice(0, 100),
      createdAt: serverTimestamp(),
    });
  } catch (logErr) {
    console.error('Gagal mencatat audit log reset:', logErr);
    errors.push(`Pencatatan log audit: ${String(logErr)}`);
  }

  if (!isSuccess) {
    return {
      success: false,
      resetType: params.resetType,
      resetLabel: meta.title,
      totalDeleted: writer.totalOperations,
      summary: `Proses reset mengalami beberapa kendala:\n${errors.join('\n')}`,
      executedAt: new Date().toISOString(),
      errors,
    };
  }

  return {
    success: true,
    resetType: params.resetType,
    resetLabel: meta.title,
    totalDeleted: writer.totalOperations,
    summary: summaryText,
    executedAt: new Date().toISOString(),
  };
}

export function subscribeResetLogs(
  onData: (logs: ResetAuditLog[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'reset_logs'), orderBy('createdAt', 'desc'), limit(15));
  return onSnapshot(
    q,
    (snap) => {
      const list: ResetAuditLog[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<ResetAuditLog, 'id'>),
      }));
      onData(list);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'reset_logs');
    }
  );
}
