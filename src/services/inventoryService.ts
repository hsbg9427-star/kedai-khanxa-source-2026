import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  Account,
  Category,
  Customer,
  PriceHistory,
  Product,
  ProductSellUnit,
  Sale,
  SaleItem,
  StockBatch,
  StockMovement,
} from '../types/database';
import { buildStockBatchDocument } from './batchService';
import {
  computeEstimatedExpiryDate,
  getEffectiveExpiryDate,
  isValidYmd,
  planFefoBatchDeduction,
  resolveDefaultProductExpiryInput,
} from '../utils/expiryUtils';
export { resolveDefaultProductExpiryInput };
import {
  DUPLICATE_PRODUCT_WARNING,
  buildProductIdentityString,
  checkDuplicateProduct,
  computeBarcodeLockKey,
  computeProductIdentityKey,
  normalizeBarcode,
  normalizeDisplayText,
} from '../utils/productIdentity';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import {
  createTransactionMetadata,
  formatQty,
  formatRupiah,
  generateSafeId,
  getTodayDateString,
} from '../utils/formatters';
import {
  calculateCombinedPosSettlement,
  DEFAULT_QRIS_FEE_PERCENT,
  type RetailPaymentMethod,
} from '../utils/qrisFee';
import type { ImportedProductRow } from '../utils/excelProducts';
import {
  UNIT_PRESETS,
  UNIVERSAL_UNIT_TEMPLATES,
  computeBaseQuantityFromUnit,
  computeCartDemandsAndTotals,
  computeStockAdjustment,
  computeSubUnitConversion,
  formatProductStockSummary,
  formatUnitConversionLabel,
  getPosSellOptions,
  getProductAllUnitOptions,
  getProductBuyOptions,
  getProductSellOptions,
  getProductSubUnitInfo,
  isStockSufficientWithTolerance,
  resolveUnitPricing,
  roundMoney,
  roundQty,
  sanitizeSellUnits,
  snapStockToProductPrecision,
  validateSellUnitsStrict,
  type ResolvedUnitPricing,
  type SellUnitOption,
  type UniversalUnitTemplate,
  type UniversalUnitTemplateItem,
} from '../utils/unitConversion';

export {
  UNIT_PRESETS,
  UNIVERSAL_UNIT_TEMPLATES,
  computeBaseQuantityFromUnit,
  computeCartDemandsAndTotals,
  computeStockAdjustment,
  computeSubUnitConversion,
  formatProductStockSummary,
  formatUnitConversionLabel,
  getPosSellOptions,
  getProductAllUnitOptions,
  getProductBuyOptions,
  getProductSellOptions,
  getProductSubUnitInfo,
  isStockSufficientWithTolerance,
  resolveUnitPricing,
  roundMoney,
  roundQty,
  sanitizeSellUnits,
  snapStockToProductPrecision,
  validateSellUnitsStrict,
  type ResolvedUnitPricing,
  type SellUnitOption,
  type UniversalUnitTemplate,
  type UniversalUnitTemplateItem,
};

export const DEFAULT_CATEGORIES: { id: string; name: string; description: string }[] = [
  { id: 'cat_sembako', name: 'Sembako', description: 'Beras, minyak goreng, gula, tepung, telur' },
  { id: 'cat_makanan_ringan', name: 'Makanan ringan', description: 'Snack, biskuit, keripik, permen' },
  { id: 'cat_minuman', name: 'Minuman', description: 'Air mineral, teh, kopi, susu kemasan' },
  { id: 'cat_rokok', name: 'Rokok', description: 'Rokok filter, kretek, dan tembakau' },
  { id: 'cat_perawatan_tubuh', name: 'Perawatan tubuh', description: 'Sabun, sampo, pasta gigi, deodoran' },
  {
    id: 'cat_perlengkapan_rumah_tangga',
    name: 'Perlengkapan rumah tangga',
    description: 'Deterjen, sabun cuci piring, tisu, baterai',
  },
  { id: 'cat_produk_lainnya', name: 'Produk lainnya', description: 'Barang dagangan umum lainnya' },
];

export async function ensureDefaultCategories(
  existingCategories: Category[],
  adminUid: string
): Promise<void> {
  const existingIds = new Set(existingCategories.map((c) => c.id));
  const existingNames = new Set(existingCategories.map((c) => c.name.trim().toLowerCase()));
  const missing = DEFAULT_CATEGORIES.filter(
    (def) => !existingIds.has(def.id) && !existingNames.has(def.name.toLowerCase())
  );
  if (missing.length === 0) return;

  try {
    const batch = writeBatch(db);
    missing.forEach((cat) => {
      batch.set(doc(db, 'categories', cat.id), {
        name: cat.name,
        description: cat.description,
        createdByUid: adminUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'categories');
  }
}

export function subscribeCategories(
  onData: (categories: Category[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'categories'), orderBy('name', 'asc'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      onData(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Category, 'id'>),
        }))
      );
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'categories');
    }
  );
}

export class CategoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryValidationError';
  }
}

export function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 60);
}

export function findDuplicateCategory(
  rawName: string,
  existingCategories: Pick<Category, 'id' | 'name'>[]
): Pick<Category, 'id' | 'name'> | null {
  const targetKey = normalizeCategoryName(rawName).toLowerCase();
  if (!targetKey) return null;
  return (
    existingCategories.find(
      (cat) => normalizeCategoryName(cat.name).toLowerCase() === targetKey
    ) || null
  );
}

export async function createCategory(
  name: string,
  description: string,
  adminUid: string,
  existingCategories?: Pick<Category, 'id' | 'name'>[]
): Promise<string> {
  const cleanName = normalizeCategoryName(name);
  if (!cleanName) {
    throw new CategoryValidationError('Nama kategori wajib diisi.');
  }

  if (existingCategories && existingCategories.length > 0) {
    const localDup = findDuplicateCategory(cleanName, existingCategories);
    if (localDup) {
      throw new CategoryValidationError(
        `Kategori "${localDup.name}" sudah terdaftar. Gunakan nama kategori lain.`
      );
    }
  }

  try {
    const snap = await getDocs(collection(db, 'categories'));
    const serverCategories = snap.docs.map((d) => ({
      id: d.id,
      name: String((d.data() as Partial<Category>).name || ''),
    }));
    const serverDup = findDuplicateCategory(cleanName, serverCategories);
    if (serverDup) {
      throw new CategoryValidationError(
        `Kategori "${serverDup.name}" sudah terdaftar. Gunakan nama kategori lain.`
      );
    }
  } catch (error) {
    if (error instanceof CategoryValidationError) {
      throw error;
    }
    // Jika offline dan cache belum lengkap, tetap lanjutkan pemeriksaan lokal yang sudah lolos
  }

  const id = generateSafeId('cat');
  const cleanDesc = description.trim().slice(0, 200);
  try {
    await setDoc(doc(db, 'categories', id), {
      name: cleanName,
      ...(cleanDesc ? { description: cleanDesc } : {}),
      createdByUid: adminUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `categories/${id}`);
  }
}

export function subscribeProducts(
  onData: (products: Product[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'products'), orderBy('name', 'asc'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Product[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Product, 'id'>),
      }));
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'products');
    }
  );
}

export function generateNextSku(products: Product[]): string {
  let maxNum = 0;
  products.forEach((p) => {
    const match = /^KK-(\d+)$/i.exec(p.sku.trim());
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  });
  const next = Math.max(maxNum + 1, products.length + 1);
  return `KK-${String(next).padStart(4, '0')}`;
}

export class DuplicateProductError extends Error {
  existingProduct?: Product;
  matchType?: 'identity' | 'barcode';

  constructor(existingProduct?: Product, matchType?: 'identity' | 'barcode', message?: string) {
    super(message || DUPLICATE_PRODUCT_WARNING);
    this.name = 'DuplicateProductError';
    this.existingProduct = existingProduct;
    this.matchType = matchType;
  }
}

export interface ProductPayload {
  sku: string;
  barcode?: string;
  name: string;
  brand?: string;
  variant?: string;
  photoDataUrl?: string;
  categoryId: string;
  categoryName: string;
  unit: string;
  baseCanBuy?: boolean;
  baseCanSell?: boolean;
  costPrice: number;
  sellPrice: number;
  wholesalePrice?: number;
  wholesaleMinQty?: number;
  sellUnits?: ProductSellUnit[];
  stock: number;
  minStock: number;
  inputDate?: string;
  expiryDate?: string;
  isActive: boolean;
  initialExpiryStartDate?: string;
  initialActualExpiryDate?: string;
}

function buildPriceSummary(
  baseUnit: string,
  costPrice: number,
  sellPrice: number,
  wholesalePrice: number | undefined,
  wholesaleMinQty: number | undefined,
  sellUnits: ProductSellUnit[],
  prev?: Product
): string {
  if (!prev) {
    const parts = [
      `Modal ${formatRupiah(costPrice)}/${baseUnit}`,
      `Ecer ${formatRupiah(sellPrice)}/${baseUnit}`,
    ];
    if (wholesalePrice !== undefined) {
      parts.push(
        `Grosir ${formatRupiah(wholesalePrice)}${wholesaleMinQty ? ` (min ${wholesaleMinQty})` : ''}`
      );
    }
    if (sellUnits.length > 0) {
      parts.push(`${sellUnits.length} satuan tambahan`);
    }
    return parts.join(' · ').slice(0, 300);
  }

  const changes: string[] = [];
  if (prev.costPrice !== costPrice) {
    changes.push(`Modal ${formatRupiah(prev.costPrice)}→${formatRupiah(costPrice)}`);
  }
  if (prev.sellPrice !== sellPrice) {
    changes.push(`Ecer ${formatRupiah(prev.sellPrice)}→${formatRupiah(sellPrice)}`);
  }
  const prevWh = prev.wholesalePrice;
  if (prevWh !== wholesalePrice) {
    changes.push(
      `Grosir ${prevWh !== undefined ? formatRupiah(prevWh) : '-'}→${
        wholesalePrice !== undefined ? formatRupiah(wholesalePrice) : '-'
      }`
    );
  }
  if (prev.wholesaleMinQty !== wholesaleMinQty) {
    changes.push(`Min grosir ${prev.wholesaleMinQty ?? '-'}→${wholesaleMinQty ?? '-'}`);
  }
  if (prev.unit !== baseUnit) {
    changes.push(`Satuan dasar ${prev.unit}→${baseUnit}`);
  }
  if (JSON.stringify(prev.sellUnits || []) !== JSON.stringify(sellUnits)) {
    changes.push(`Update ${sellUnits.length} satuan jual`);
  }
  return (changes.join(' · ') || 'Pembaruan daftar harga & satuan').slice(0, 300);
}

async function verifyProductNotDuplicate(
  candidate: { name: string; brand?: string; variant?: string; barcode?: string },
  existingProducts?: Product[],
  excludeProductId?: string
): Promise<{
  identityKey: string;
  identityString: string;
  normalizedBarcode?: string;
  barcodeKey?: string;
  identityLockChecked: boolean;
  identityLockOwnedBySelf: boolean;
  barcodeLockChecked: boolean;
  barcodeLockOwnedBySelf: boolean;
}> {
  // 1. Pemeriksaan instan pada cache lokal (bekerja penuh saat offline maupun online)
  const localCheck = checkDuplicateProduct(candidate, existingProducts || [], excludeProductId);
  if (localCheck.isDuplicate) {
    throw new DuplicateProductError(localCheck.existingProduct, localCheck.matchType);
  }

  let identityLockChecked = false;
  let identityLockOwnedBySelf = false;
  let barcodeLockChecked = false;
  let barcodeLockOwnedBySelf = false;

  // 2. Pemeriksaan ke server (dokumen lock + koleksi produk lama) bila perangkat online
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      const idLockSnap = await getDoc(doc(db, 'product_identity_locks', localCheck.identityKey));
      identityLockChecked = true;
      if (idLockSnap.exists()) {
        const lockData = idLockSnap.data() as { productId?: string };
        if (lockData.productId && lockData.productId === excludeProductId) {
          identityLockOwnedBySelf = true;
        } else if (lockData.productId && lockData.productId !== excludeProductId) {
          let existingProd = existingProducts?.find((p) => p.id === lockData.productId);
          if (!existingProd) {
            const prodSnap = await getDoc(doc(db, 'products', lockData.productId));
            if (prodSnap.exists()) {
              existingProd = { id: prodSnap.id, ...(prodSnap.data() as Omit<Product, 'id'>) };
            }
          }
          if (existingProd) {
            throw new DuplicateProductError(existingProd, 'identity');
          }
          await deleteDoc(doc(db, 'product_identity_locks', localCheck.identityKey));
        }
      }

      if (localCheck.barcodeKey) {
        const bcLockSnap = await getDoc(doc(db, 'barcode_locks', localCheck.barcodeKey));
        barcodeLockChecked = true;
        if (bcLockSnap.exists()) {
          const lockData = bcLockSnap.data() as { productId?: string };
          if (lockData.productId && lockData.productId === excludeProductId) {
            barcodeLockOwnedBySelf = true;
          } else if (lockData.productId && lockData.productId !== excludeProductId) {
            let existingProd = existingProducts?.find((p) => p.id === lockData.productId);
            if (!existingProd) {
              const prodSnap = await getDoc(doc(db, 'products', lockData.productId));
              if (prodSnap.exists()) {
                existingProd = { id: prodSnap.id, ...(prodSnap.data() as Omit<Product, 'id'>) };
              }
            }
            if (existingProd) {
              throw new DuplicateProductError(existingProd, 'barcode');
            }
            await deleteDoc(doc(db, 'barcode_locks', localCheck.barcodeKey));
          }
        }
      }

      // Fallback untuk produk lama yang dibuat sebelum lock document diterapkan
      const prodListSnap = await getDocs(collection(db, 'products'));
      const serverProducts: Product[] = prodListSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Product, 'id'>),
      }));
      const serverCheck = checkDuplicateProduct(candidate, serverProducts, excludeProductId);
      if (serverCheck.isDuplicate) {
        throw new DuplicateProductError(serverCheck.existingProduct, serverCheck.matchType);
      }
    } catch (err) {
      if (err instanceof DuplicateProductError) {
        throw err;
      }
      // Jika perangkat offline atau akses lock belum terpasang di environment uji, fallback ke validasi lokal
    }
  }

  return {
    identityKey: localCheck.identityKey,
    identityString: localCheck.identityString,
    normalizedBarcode: localCheck.normalizedBarcode,
    barcodeKey: localCheck.barcodeKey,
    identityLockChecked,
    identityLockOwnedBySelf,
    barcodeLockChecked,
    barcodeLockOwnedBySelf,
  };
}

export async function createProductWithInitialStock(
  payload: ProductPayload,
  user: { uid: string; displayName: string },
  existingProducts?: Product[]
): Promise<string> {
  const cleanName = normalizeDisplayText(payload.name).slice(0, 120);
  if (!cleanName) {
    throw new Error('Nama produk wajib diisi.');
  }
  const cleanBrand = normalizeDisplayText(payload.brand).slice(0, 60);
  const cleanVariant = normalizeDisplayText(payload.variant).slice(0, 80);
  const cleanBarcode = (payload.barcode || '').trim().slice(0, 64);

  const dupMeta = await verifyProductNotDuplicate(
    {
      name: cleanName,
      brand: cleanBrand,
      variant: cleanVariant,
      barcode: cleanBarcode,
    },
    existingProducts
  );

  const baseUnit = payload.unit.trim().slice(0, 24) || 'PCS';
  const baseCanBuy = payload.baseCanBuy !== false;
  const baseCanSell = payload.baseCanSell !== false;
  const unitErr = validateSellUnitsStrict(
    payload.sellUnits || [],
    baseUnit,
    baseCanBuy,
    baseCanSell
  );
  if (unitErr) {
    throw new Error(unitErr);
  }

  const cleanSellUnits = sanitizeSellUnits(payload.sellUnits, baseUnit);
  const initialStock = snapStockToProductPrecision(Number(payload.stock) || 0, {
    sellUnits: cleanSellUnits,
  });
  if (initialStock < 0) {
    throw new Error('Stok awal produk tidak boleh bernilai negatif.');
  }

  const resolvedExpiry = resolveDefaultProductExpiryInput(
    payload.inputDate || payload.initialExpiryStartDate,
    payload.expiryDate || payload.initialActualExpiryDate
  );

  const productId = generateSafeId('prd');
  const productRef = doc(db, 'products', productId);
  const cleanCost = roundMoney(Math.max(0, Number(payload.costPrice) || 0));
  const cleanSell = roundMoney(Math.max(0, Number(payload.sellPrice) || 0));
  const cleanWholesale =
    payload.wholesalePrice !== undefined &&
    Number.isFinite(Number(payload.wholesalePrice)) &&
    Number(payload.wholesalePrice) >= 0
      ? roundMoney(Number(payload.wholesalePrice))
      : undefined;
  const cleanMinQty =
    payload.wholesaleMinQty !== undefined &&
    Number.isFinite(Number(payload.wholesaleMinQty)) &&
    Number(payload.wholesaleMinQty) > 0
      ? roundQty(Number(payload.wholesaleMinQty))
      : undefined;

  try {
    const batch = writeBatch(db);

    // Kunci atomik untuk mencegah duplikasi lintas perangkat ketika sinkronisasi offline -> online
    batch.set(doc(db, 'product_identity_locks', dupMeta.identityKey), {
      productId,
      productName: cleanName,
      normalizedIdentity: dupMeta.identityString.slice(0, 240),
      createdByUid: user.uid,
      createdAt: serverTimestamp(),
    });

    if (dupMeta.barcodeKey && cleanBarcode) {
      batch.set(doc(db, 'barcode_locks', dupMeta.barcodeKey), {
        productId,
        barcode: cleanBarcode,
        normalizedBarcode: normalizeBarcode(cleanBarcode).slice(0, 64),
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
      });
    }

    batch.set(productRef, {
      sku: payload.sku.trim().slice(0, 40),
      ...(cleanBarcode ? { barcode: cleanBarcode } : {}),
      name: cleanName,
      ...(cleanBrand ? { brand: cleanBrand } : {}),
      ...(cleanVariant ? { variant: cleanVariant } : {}),
      identityKey: dupMeta.identityKey,
      ...(dupMeta.barcodeKey ? { barcodeKey: dupMeta.barcodeKey } : {}),
      ...(payload.photoDataUrl ? { photoDataUrl: payload.photoDataUrl.slice(0, 80000) } : {}),
      categoryId: payload.categoryId,
      categoryName: payload.categoryName.trim().slice(0, 60),
      unit: baseUnit,
      ...(baseCanBuy === false ? { baseCanBuy: false } : {}),
      ...(baseCanSell === false ? { baseCanSell: false } : {}),
      costPrice: cleanCost,
      sellPrice: cleanSell,
      ...(cleanWholesale !== undefined ? { wholesalePrice: cleanWholesale } : {}),
      ...(cleanMinQty !== undefined ? { wholesaleMinQty: cleanMinQty } : {}),
      ...(cleanSellUnits.length > 0 ? { sellUnits: cleanSellUnits } : {}),
      stock: initialStock,
      minStock: roundQty(Math.max(0, Number(payload.minStock) || 0)),
      inputDate: resolvedExpiry.inputDate,
      expiryDate: resolvedExpiry.expiryDate,
      isActive: payload.isActive,
      createdByUid: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const priceId = generateSafeId('prc');
    const priceMeta = createTransactionMetadata('PRC', user);
    batch.set(doc(db, 'price_history', priceId), {
      ...priceMeta,
      productId,
      productName: cleanName,
      baseUnit,
      changeType: 'initial',
      costPriceBefore: 0,
      costPriceAfter: cleanCost,
      sellPriceBefore: 0,
      sellPriceAfter: cleanSell,
      ...(cleanWholesale !== undefined ? { wholesalePriceAfter: cleanWholesale } : {}),
      summary: buildPriceSummary(
        baseUnit,
        cleanCost,
        cleanSell,
        cleanWholesale,
        cleanMinQty,
        cleanSellUnits
      ),
      createdAt: serverTimestamp(),
    });

    if (initialStock > 0) {
      const moveId = generateSafeId('stk');
      const meta = createTransactionMetadata('STK', user);
      const batchDoc = buildStockBatchDocument({
        productId,
        productName: cleanName,
        productBrand: cleanBrand || undefined,
        productVariant: cleanVariant || undefined,
        baseUnit,
        sourceType: 'initial_product',
        sourceRefId: moveId,
        sourceNumber: meta.transactionNumber,
        startDate: resolvedExpiry.inputDate,
        actualExpiryDate: resolvedExpiry.actualExpiryDate,
        initialBaseQty: initialStock,
        costPerBaseUnit: cleanCost,
        user,
      });
      batch.set(doc(db, 'stock_batches', batchDoc.id), batchDoc.data);

      batch.set(doc(db, 'stock_movements', moveId), {
        ...meta,
        productId,
        productName: cleanName,
        baseUnit,
        unitName: baseUnit,
        unitQuantity: initialStock,
        conversion: 1,
        type: 'in',
        quantity: initialStock,
        stockBefore: 0,
        stockAfter: initialStock,
        referenceId: batchDoc.id,
        notes: `Stok awal produk baru (${formatQty(initialStock)} ${baseUnit})`,
        createdAt: serverTimestamp(),
      });
    }

    await batch.commit();
    return productId;
  } catch (error) {
    const code = (error as { code?: string })?.code || '';
    const msg = error instanceof Error ? error.message : String(error);
    if (
      (code === 'permission-denied' || msg.includes('Missing or insufficient permissions')) &&
      (typeof navigator === 'undefined' || navigator.onLine)
    ) {
      // Periksa apakah kegagalan disebabkan oleh tabrakan kunci identitas saat sinkronisasi multi-perangkat
      try {
        const existingIdLock = await getDoc(doc(db, 'product_identity_locks', dupMeta.identityKey));
        if (existingIdLock.exists()) {
          throw new DuplicateProductError(undefined, 'identity');
        }
        if (dupMeta.barcodeKey) {
          const existingBcLock = await getDoc(doc(db, 'barcode_locks', dupMeta.barcodeKey));
          if (existingBcLock.exists()) {
            throw new DuplicateProductError(undefined, 'barcode');
          }
        }
      } catch (innerErr) {
        if (innerErr instanceof DuplicateProductError) throw innerErr;
      }
    }
    handleFirestoreError(error, OperationType.CREATE, `products/${productId}`);
  }
}

export async function updateProductDetails(
  prevProduct: Product,
  payload: Omit<ProductPayload, 'stock'>,
  user: { uid: string; displayName: string },
  existingProducts?: Product[],
  syncInitialBatch?: StockBatch | null
): Promise<void> {
  const cleanName = normalizeDisplayText(payload.name).slice(0, 120);
  if (!cleanName) {
    throw new Error('Nama produk wajib diisi.');
  }
  const cleanBrand = normalizeDisplayText(payload.brand).slice(0, 60);
  const cleanVariant = normalizeDisplayText(payload.variant).slice(0, 80);
  const cleanBarcode = (payload.barcode || '').trim().slice(0, 64);

  const dupMeta = await verifyProductNotDuplicate(
    {
      name: cleanName,
      brand: cleanBrand,
      variant: cleanVariant,
      barcode: cleanBarcode,
    },
    existingProducts,
    prevProduct.id
  );

  const baseUnit = payload.unit.trim().slice(0, 24) || 'PCS';
  const baseCanBuy = payload.baseCanBuy !== false;
  const baseCanSell = payload.baseCanSell !== false;
  const unitErr = validateSellUnitsStrict(
    payload.sellUnits || [],
    baseUnit,
    baseCanBuy,
    baseCanSell
  );
  if (unitErr) {
    throw new Error(unitErr);
  }

  const ref = doc(db, 'products', prevProduct.id);
  const cleanCost = roundMoney(Math.max(0, Number(payload.costPrice) || 0));
  const cleanSell = roundMoney(Math.max(0, Number(payload.sellPrice) || 0));
  const cleanWholesale =
    payload.wholesalePrice !== undefined &&
    Number.isFinite(Number(payload.wholesalePrice)) &&
    Number(payload.wholesalePrice) >= 0
      ? roundMoney(Number(payload.wholesalePrice))
      : undefined;
  const cleanMinQty =
    payload.wholesaleMinQty !== undefined &&
    Number.isFinite(Number(payload.wholesaleMinQty)) &&
    Number(payload.wholesaleMinQty) > 0
      ? roundQty(Number(payload.wholesaleMinQty))
      : undefined;
  const cleanSellUnits = sanitizeSellUnits(payload.sellUnits, baseUnit);

  const priceOrUnitChanged =
    prevProduct.costPrice !== cleanCost ||
    prevProduct.sellPrice !== cleanSell ||
    prevProduct.wholesalePrice !== cleanWholesale ||
    prevProduct.wholesaleMinQty !== cleanMinQty ||
    prevProduct.unit !== baseUnit ||
    (prevProduct.baseCanBuy !== false) !== baseCanBuy ||
    (prevProduct.baseCanSell !== false) !== baseCanSell ||
    JSON.stringify(prevProduct.sellUnits || []) !== JSON.stringify(cleanSellUnits);

  const prevIdentityKey =
    prevProduct.identityKey ||
    computeProductIdentityKey(prevProduct.name, prevProduct.brand, prevProduct.variant);
  const prevBarcodeKey =
    prevProduct.barcodeKey || computeBarcodeLockKey(prevProduct.barcode);

  try {
    const batch = writeBatch(db);
    const updatedFields: Record<string, unknown> = {
      sku: payload.sku.trim().slice(0, 40),
      barcode: cleanBarcode,
      name: cleanName,
      identityKey: dupMeta.identityKey,
      photoDataUrl: payload.photoDataUrl ? payload.photoDataUrl.slice(0, 80000) : '',
      categoryId: payload.categoryId,
      categoryName: payload.categoryName.trim().slice(0, 60),
      unit: baseUnit,
      costPrice: cleanCost,
      sellPrice: cleanSell,
      sellUnits: cleanSellUnits,
      minStock: roundQty(Math.max(0, Number(payload.minStock) || 0)),
      isActive: Boolean(payload.isActive),
      updatedAt: serverTimestamp(),
    };

    if (cleanBrand) {
      updatedFields.brand = cleanBrand;
    } else if (prevProduct.brand !== undefined) {
      updatedFields.brand = deleteField();
    }

    if (cleanVariant) {
      updatedFields.variant = cleanVariant;
    } else if (prevProduct.variant !== undefined) {
      updatedFields.variant = deleteField();
    }

    if (dupMeta.barcodeKey) {
      updatedFields.barcodeKey = dupMeta.barcodeKey;
    } else if (prevProduct.barcodeKey !== undefined) {
      updatedFields.barcodeKey = deleteField();
    }

    if (baseCanBuy === false) {
      updatedFields.baseCanBuy = false;
    } else if (prevProduct.baseCanBuy !== undefined) {
      updatedFields.baseCanBuy = deleteField();
    }

    if (baseCanSell === false) {
      updatedFields.baseCanSell = false;
    } else if (prevProduct.baseCanSell !== undefined) {
      updatedFields.baseCanSell = deleteField();
    }

    if (cleanWholesale !== undefined) {
      updatedFields.wholesalePrice = cleanWholesale;
    } else if (prevProduct.wholesalePrice !== undefined) {
      updatedFields.wholesalePrice = deleteField();
    }

    if (cleanMinQty !== undefined) {
      updatedFields.wholesaleMinQty = cleanMinQty;
    } else if (prevProduct.wholesaleMinQty !== undefined) {
      updatedFields.wholesaleMinQty = deleteField();
    }

    const hasExpiryInput = Boolean(
      payload.inputDate ||
        payload.expiryDate ||
        payload.initialExpiryStartDate ||
        payload.initialActualExpiryDate
    );
    if (hasExpiryInput) {
      const resolvedExpiry = resolveDefaultProductExpiryInput(
        payload.inputDate || payload.initialExpiryStartDate || prevProduct.inputDate,
        payload.expiryDate || payload.initialActualExpiryDate
      );
      updatedFields.inputDate = resolvedExpiry.inputDate;
      updatedFields.expiryDate = resolvedExpiry.expiryDate;

      if (syncInitialBatch && syncInitialBatch.productId === prevProduct.id) {
        batch.update(doc(db, 'stock_batches', syncInitialBatch.id), {
          startDate: resolvedExpiry.inputDate,
          estimatedExpiryDate: resolvedExpiry.estimatedExpiryDate,
          actualExpiryDate: resolvedExpiry.actualExpiryDate
            ? resolvedExpiry.actualExpiryDate
            : deleteField(),
          effectiveExpiryDate: resolvedExpiry.expiryDate,
          updatedAt: serverTimestamp(),
        });
      }
    }

    batch.update(ref, updatedFields);

    if (prevIdentityKey && prevIdentityKey !== dupMeta.identityKey) {
      batch.delete(doc(db, 'product_identity_locks', prevIdentityKey));
    }
    const shouldCreateIdentityLock = dupMeta.identityLockChecked
      ? !dupMeta.identityLockOwnedBySelf
      : prevIdentityKey !== dupMeta.identityKey || !prevProduct.identityKey;
    if (shouldCreateIdentityLock) {
      batch.set(doc(db, 'product_identity_locks', dupMeta.identityKey), {
        productId: prevProduct.id,
        productName: cleanName,
        normalizedIdentity: dupMeta.identityString.slice(0, 240),
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
      });
    }

    if (prevBarcodeKey && prevBarcodeKey !== dupMeta.barcodeKey) {
      batch.delete(doc(db, 'barcode_locks', prevBarcodeKey));
    }
    const shouldCreateBarcodeLock =
      Boolean(dupMeta.barcodeKey && cleanBarcode) &&
      (dupMeta.barcodeLockChecked
        ? !dupMeta.barcodeLockOwnedBySelf
        : prevBarcodeKey !== dupMeta.barcodeKey || !prevProduct.barcodeKey);
    if (shouldCreateBarcodeLock && dupMeta.barcodeKey) {
      batch.set(doc(db, 'barcode_locks', dupMeta.barcodeKey), {
        productId: prevProduct.id,
        barcode: cleanBarcode,
        normalizedBarcode: normalizeBarcode(cleanBarcode).slice(0, 64),
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
      });
    }

    if (priceOrUnitChanged) {
      const priceId = generateSafeId('prc');
      const priceMeta = createTransactionMetadata('PRC', user);
      batch.set(doc(db, 'price_history', priceId), {
        ...priceMeta,
        productId: prevProduct.id,
        productName: cleanName,
        baseUnit,
        changeType: 'update',
        costPriceBefore: Number(prevProduct.costPrice) || 0,
        costPriceAfter: cleanCost,
        sellPriceBefore: Number(prevProduct.sellPrice) || 0,
        sellPriceAfter: cleanSell,
        ...(prevProduct.wholesalePrice !== undefined
          ? { wholesalePriceBefore: Number(prevProduct.wholesalePrice) }
          : {}),
        ...(cleanWholesale !== undefined ? { wholesalePriceAfter: cleanWholesale } : {}),
        summary: buildPriceSummary(
          baseUnit,
          cleanCost,
          cleanSell,
          cleanWholesale,
          cleanMinQty,
          cleanSellUnits,
          prevProduct
        ),
        createdAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (error) {
    const code = (error as { code?: string })?.code || '';
    const msg = error instanceof Error ? error.message : String(error);
    if (
      (code === 'permission-denied' || msg.includes('Missing or insufficient permissions')) &&
      (typeof navigator === 'undefined' || navigator.onLine)
    ) {
      try {
        const existingIdLock = await getDoc(doc(db, 'product_identity_locks', dupMeta.identityKey));
        if (existingIdLock.exists()) {
          const lockPid = (existingIdLock.data() as { productId?: string })?.productId;
          if (lockPid && lockPid !== prevProduct.id) {
            throw new DuplicateProductError(undefined, 'identity');
          }
        }
        if (dupMeta.barcodeKey) {
          const existingBcLock = await getDoc(doc(db, 'barcode_locks', dupMeta.barcodeKey));
          if (existingBcLock.exists()) {
            const lockPid = (existingBcLock.data() as { productId?: string })?.productId;
            if (lockPid && lockPid !== prevProduct.id) {
              throw new DuplicateProductError(undefined, 'barcode');
            }
          }
        }
      } catch (innerErr) {
        if (innerErr instanceof DuplicateProductError) throw innerErr;
      }
    }
    handleFirestoreError(error, OperationType.UPDATE, `products/${prevProduct.id}`);
  }
}

export async function getUsedUnitNamesForProduct(productId: string): Promise<Set<string>> {
  const used = new Set<string>();
  try {
    const snap = await getDocs(
      query(collection(db, 'stock_movements'), where('productId', '==', productId))
    );
    snap.docs.forEach((d) => {
      const data = d.data() as Partial<StockMovement>;
      if (data.unitName && data.unitName.trim()) {
        used.add(data.unitName.trim().toUpperCase());
      }
      if (data.baseUnit && data.baseUnit.trim()) {
        used.add(data.baseUnit.trim().toUpperCase());
      }
    });
  } catch {
    // Jika offline atau cache terbatas, kembalikan himpunan kosong tanpa memblokir form edit
  }
  return used;
}

export async function deleteProduct(productId: string, prevProduct?: Product): Promise<void> {
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'products', productId));
    const idKey =
      prevProduct?.identityKey ||
      (prevProduct
        ? computeProductIdentityKey(prevProduct.name, prevProduct.brand, prevProduct.variant)
        : undefined);
    const bcKey = prevProduct?.barcodeKey || computeBarcodeLockKey(prevProduct?.barcode);
    if (idKey) {
      batch.delete(doc(db, 'product_identity_locks', idKey));
    }
    if (bcKey) {
      batch.delete(doc(db, 'barcode_locks', bcKey));
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `products/${productId}`);
  }
}

export async function adjustProductStock(
  product: Product,
  mode: 'in' | 'out' | 'adjustment',
  inputQty: number,
  notes: string,
  user: { uid: string; displayName: string },
  unitName?: string,
  batchOptions?: {
    startDate?: string;
    actualExpiryDate?: string;
    targetBatch?: StockBatch | null;
  }
): Promise<void> {
  const options = getProductAllUnitOptions(product);
  const selectedOpt =
    options.find((o) => o.unitName.toUpperCase() === (unitName || product.unit).toUpperCase()) ||
    options[0];
  const conversion = selectedOpt.conversion;
  const { convertedBaseQty, stockBefore, stockAfter, loggedBaseQuantity } = computeStockAdjustment(
    product.stock,
    mode,
    inputQty,
    conversion,
    product.unit,
    { product, option: selectedOpt }
  );

  const cleanQty = roundQty(Number(inputQty));
  const moveId = generateSafeId('stk');
  const meta = createTransactionMetadata('STK', user);
  const unitDetail =
    conversion !== 1
      ? ` (${formatQty(cleanQty)} ${selectedOpt.unitName} = ${formatQty(convertedBaseQty)} ${product.unit})`
      : ` (${formatQty(cleanQty)} ${product.unit})`;

  try {
    const batch = writeBatch(db);
    let referenceId: string | undefined;
    let nextInputDate: string | undefined;
    let nextExpiryDate: string | undefined;

    if (mode === 'in' && convertedBaseQty > 0) {
      const startDate =
        batchOptions?.startDate && isValidYmd(batchOptions.startDate)
          ? batchOptions.startDate
          : meta.transactionDate;
      const batchDoc = buildStockBatchDocument({
        productId: product.id,
        productName: product.name,
        productBrand: product.brand,
        productVariant: product.variant,
        baseUnit: product.unit,
        sourceType: 'manual_stock',
        sourceRefId: moveId,
        sourceNumber: meta.transactionNumber,
        startDate,
        actualExpiryDate: batchOptions?.actualExpiryDate,
        initialBaseQty: convertedBaseQty,
        costPerBaseUnit: product.costPrice,
        user,
      });
      referenceId = batchDoc.id;
      batch.set(doc(db, 'stock_batches', batchDoc.id), batchDoc.data);
      if (!product.expiryDate || Number(product.stock) <= 0.0001) {
        nextInputDate = String(batchDoc.data.startDate);
        nextExpiryDate = String(batchDoc.data.effectiveExpiryDate);
      }
    } else if (mode === 'out' && batchOptions?.targetBatch && convertedBaseQty > 0) {
      const tb = batchOptions.targetBatch;
      const prevRem = Math.max(0, roundQty(Number(tb.remainingBaseQty) || 0));
      const nextRem = roundQty(Math.max(0, prevRem - convertedBaseQty));
      referenceId = tb.id;
      batch.update(doc(db, 'stock_batches', tb.id), {
        remainingBaseQty: nextRem <= 0.0001 ? 0 : nextRem,
        status: nextRem <= 0.0001 ? 'depleted' : tb.status,
        updatedAt: serverTimestamp(),
      });
    }

    batch.update(doc(db, 'products', product.id), {
      stock: stockAfter,
      ...(nextInputDate ? { inputDate: nextInputDate } : {}),
      ...(nextExpiryDate ? { expiryDate: nextExpiryDate } : {}),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'stock_movements', moveId), {
      ...meta,
      productId: product.id,
      productName: product.name.slice(0, 120),
      baseUnit: product.unit.slice(0, 24),
      unitName: selectedOpt.unitName.slice(0, 24),
      unitQuantity: cleanQty,
      conversion,
      type: mode,
      quantity: loggedBaseQuantity,
      stockBefore,
      stockAfter,
      ...(referenceId ? { referenceId } : {}),
      notes: (
        notes.trim() ||
        (mode === 'in'
          ? `Penambahan stok${unitDetail}`
          : mode === 'out'
            ? `Pengurangan stok${unitDetail}`
            : `Stok opname${unitDetail}`)
      ).slice(0, 240),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `products/${product.id}`);
  }
}

export async function importProductsBatch(
  rows: ImportedProductRow[],
  user: { uid: string; displayName: string },
  existingProducts: Product[] = []
): Promise<number> {
  // Validasi duplikasi di dalam file & terhadap produk terdaftar sebelum menulis
  const seenIdentityKeys = new Set<string>();
  const seenBarcodeKeys = new Set<string>();

  for (const row of rows) {
    const check = checkDuplicateProduct(
      {
        name: row.name,
        brand: row.brand,
        variant: row.variant,
        barcode: row.barcode,
      },
      existingProducts
    );
    if (check.isDuplicate) {
      throw new DuplicateProductError(
        check.existingProduct,
        check.matchType,
        `${DUPLICATE_PRODUCT_WARNING} (${row.name})`
      );
    }
    if (seenIdentityKeys.has(check.identityKey)) {
      throw new DuplicateProductError(
        undefined,
        'identity',
        `${DUPLICATE_PRODUCT_WARNING} (Duplikat pada baris impor: ${row.name})`
      );
    }
    seenIdentityKeys.add(check.identityKey);
    if (check.barcodeKey) {
      if (seenBarcodeKeys.has(check.barcodeKey)) {
        throw new DuplicateProductError(
          undefined,
          'barcode',
          `${DUPLICATE_PRODUCT_WARNING} (Barcode ganda pada file impor: ${row.barcode})`
        );
      }
      seenBarcodeKeys.add(check.barcodeKey);
    }
  }

  let importedCount = 0;
  // Maksimal 65 produk per batch (<= 6 write/produk = max 390 ops, aman di bawah batas 500 Firestore)
  const CHUNK_SIZE = 65;

  try {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);

      chunk.forEach((row) => {
        const productId = generateSafeId('prd');
        const cleanStock = Math.max(0, Number(row.stock) || 0);
        const cleanSellUnits = sanitizeSellUnits(row.sellUnits, row.unit);
        const cleanName = normalizeDisplayText(row.name).slice(0, 120);
        const cleanBrand = normalizeDisplayText(row.brand).slice(0, 60);
        const cleanVariant = normalizeDisplayText(row.variant).slice(0, 80);
        const cleanBarcode = (row.barcode || '').trim().slice(0, 64);
        const identityString = buildProductIdentityString(cleanName, cleanBrand, cleanVariant);
        const identityKey = computeProductIdentityKey(cleanName, cleanBrand, cleanVariant);
        const barcodeKey = computeBarcodeLockKey(cleanBarcode);

        batch.set(doc(db, 'product_identity_locks', identityKey), {
          productId,
          productName: cleanName,
          normalizedIdentity: identityString.slice(0, 240),
          createdByUid: user.uid,
          createdAt: serverTimestamp(),
        });

        if (barcodeKey && cleanBarcode) {
          batch.set(doc(db, 'barcode_locks', barcodeKey), {
            productId,
            barcode: cleanBarcode,
            normalizedBarcode: normalizeBarcode(cleanBarcode).slice(0, 64),
            createdByUid: user.uid,
            createdAt: serverTimestamp(),
          });
        }

        const meta = createTransactionMetadata('IMP', user);
        const resolvedExpiry = resolveDefaultProductExpiryInput(
          meta.transactionDate,
          row.actualExpiryDate
        );

        batch.set(doc(db, 'products', productId), {
          sku: row.sku,
          ...(cleanBarcode ? { barcode: cleanBarcode } : {}),
          name: cleanName,
          ...(cleanBrand ? { brand: cleanBrand } : {}),
          ...(cleanVariant ? { variant: cleanVariant } : {}),
          identityKey,
          ...(barcodeKey ? { barcodeKey } : {}),
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          unit: row.unit,
          costPrice: row.costPrice,
          sellPrice: row.sellPrice,
          ...(row.wholesalePrice !== undefined ? { wholesalePrice: row.wholesalePrice } : {}),
          ...(row.wholesaleMinQty !== undefined ? { wholesaleMinQty: row.wholesaleMinQty } : {}),
          ...(cleanSellUnits.length > 0 ? { sellUnits: cleanSellUnits } : {}),
          stock: cleanStock,
          minStock: row.minStock,
          inputDate: resolvedExpiry.inputDate,
          expiryDate: resolvedExpiry.expiryDate,
          isActive: true,
          createdByUid: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const priceId = generateSafeId('prc');
        const priceMeta = createTransactionMetadata('PRC', user);
        batch.set(doc(db, 'price_history', priceId), {
          ...priceMeta,
          productId,
          productName: cleanName,
          baseUnit: row.unit,
          changeType: 'initial',
          costPriceBefore: 0,
          costPriceAfter: row.costPrice,
          sellPriceBefore: 0,
          sellPriceAfter: row.sellPrice,
          ...(row.wholesalePrice !== undefined ? { wholesalePriceAfter: row.wholesalePrice } : {}),
          summary: `Import Excel: Modal ${formatRupiah(row.costPrice)} · Ecer ${formatRupiah(
            row.sellPrice
          )}/${row.unit}`.slice(0, 300),
          createdAt: serverTimestamp(),
        });

        if (cleanStock > 0) {
          const moveId = generateSafeId('stk');
          const batchDoc = buildStockBatchDocument({
            productId,
            productName: cleanName,
            productBrand: cleanBrand || undefined,
            productVariant: cleanVariant || undefined,
            baseUnit: row.unit,
            sourceType: 'excel_import',
            sourceRefId: moveId,
            sourceNumber: meta.transactionNumber,
            startDate: resolvedExpiry.inputDate,
            actualExpiryDate: resolvedExpiry.actualExpiryDate,
            initialBaseQty: cleanStock,
            costPerBaseUnit: row.costPrice,
            user,
          });
          batch.set(doc(db, 'stock_batches', batchDoc.id), batchDoc.data);

          batch.set(doc(db, 'stock_movements', moveId), {
            ...meta,
            productId,
            productName: cleanName,
            baseUnit: row.unit,
            unitName: row.unit,
            unitQuantity: cleanStock,
            conversion: 1,
            type: 'in',
            quantity: cleanStock,
            stockBefore: 0,
            stockAfter: cleanStock,
            referenceId: batchDoc.id,
            notes: `Import Excel (${cleanStock} ${row.unit})`,
            createdAt: serverTimestamp(),
          });
        }
        importedCount += 1;
      });

      await batch.commit();
    }
    return importedCount;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'products');
  }
}

export function subscribeStockMovements(
  isAdmin: boolean,
  userUid: string,
  onData: (movements: StockMovement[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = isAdmin
    ? query(collection(db, 'stock_movements'), orderBy('createdAt', 'desc'), limit(200))
    : query(collection(db, 'stock_movements'), where('recordedByUid', '==', userUid), limit(100));

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: StockMovement[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<StockMovement, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list.slice(0, 200));
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'stock_movements');
    }
  );
}

export function subscribePriceHistory(
  isAdmin: boolean,
  _userUid: string,
  onData: (history: PriceHistory[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  if (!isAdmin) {
    onData([]);
    return () => {};
  }
  const q = query(collection(db, 'price_history'), orderBy('createdAt', 'desc'), limit(200));

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: PriceHistory[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<PriceHistory, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list.slice(0, 200));
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'price_history');
    }
  );
}

// Integrasi Kasir Retail -> Multi-Satuan Ecer/Grosir, HPP, Laba, & Pengurangan Stok Otomatis
export interface RetailCartItem {
  lineKey: string;
  product: Product;
  unitName: string;
  quantity: number;
  tierPreference: 'auto' | 'retail' | 'wholesale';
}

export interface RecordRetailSaleInput {
  items: RetailCartItem[];
  discount: number;
  paidAmount: number;
  paymentMethod: RetailPaymentMethod;
  cashPart?: number;
  qrisPart?: number;
  qrisFeePercent?: number;
  account?: Account | null;
  qrisAccount?: Account | null;
  customer?: Customer | null;
  customerName?: string;
  autoCreateCustomer?: boolean;
  newCustomerPhone?: string;
  receivablePayAmount?: number;
  batches?: StockBatch[];
  allowExpiredOverride?: boolean;
  expiredOverrideReason?: string;
}

export interface RecordedSaleReceipt {
  saleId: string;
  transactionNumber: string;
  transactionDate: string;
  transactionTime: string;
  recordedByName: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  items: {
    name: string;
    unitName: string;
    baseUnit: string;
    conversion: number;
    baseQuantity: number;
    priceTier: 'retail' | 'wholesale';
    quantity: number;
    unitPrice: number;
    subtotal: number;
    profit: number;
  }[];
  subtotal: number;
  discount: number;
  totalAmount: number;
  totalCost: number;
  totalProfit: number;
  paidAmount: number;
  changeAmount: number;
  debtAmount: number;
  receivablePaidAmount?: number;
  customerDebtBefore?: number;
  customerDebtAfter?: number;
  paymentMethod: RetailPaymentMethod;
  cashPaidPart: number;
  qrisAmount: number;
  qrisFeeRate: number;
  qrisFeeAmount: number;
  netReceivedAmount: number;
}

function isOfflineTransactionError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (error as { code?: string })?.code || '';
  return code === 'unavailable' || code === 'failed-precondition';
}

export async function recordRetailSale(
  input: RecordRetailSaleInput,
  user: { uid: string; displayName: string }
): Promise<RecordedSaleReceipt> {
  const {
    resolvedLines,
    baseDemandByProduct,
    subtotal,
    totalCost,
    discount,
    totalAmount,
    totalProfit,
    totalItems,
  } = computeCartDemandsAndTotals(input.items, input.discount);

  const isDebtSale = input.paymentMethod === 'debt';
  const cleanTypedCustomerName = (input.customerName || '').trim().slice(0, 100);
  const cleanNewCustomerPhone = (input.newCustomerPhone || '').trim().slice(0, 24);
  const willAutoCreateCustomer =
    !input.customer &&
    Boolean(input.autoCreateCustomer) &&
    cleanTypedCustomerName.length > 0 &&
    cleanTypedCustomerName.toLowerCase() !== 'umum';

  if (isDebtSale && !input.customer && !willAutoCreateCustomer) {
    throw new Error(
      'Pilih atau ketik nama pelanggan terlebih dahulu untuk transaksi Kasbon / Piutang.'
    );
  }

  // Validasi awal batch kedaluwarsa & susun rencana pemotongan FEFO
  const allBatches = input.batches || [];
  const allowExpired = Boolean(input.allowExpiredOverride);
  const initialFefoPlans = new Map<string, ReturnType<typeof planFefoBatchDeduction>>();
  let usedExpiredInSale = false;

  if (allBatches.length > 0) {
    for (const [productId, { product, totalBaseQty }] of baseDemandByProduct.entries()) {
      const plan = planFefoBatchDeduction(product, allBatches, totalBaseQty, allowExpired);
      if (!plan.ok && plan.blockedByExpired) {
        throw new Error(
          `Produk "${product.name}" memiliki stok sudah kedaluwarsa (EXPIRED) dan tidak boleh dijual tanpa persetujuan Admin.`
        );
      }
      if (plan.usedExpiredBatches) {
        usedExpiredInSale = true;
      }
      initialFefoPlans.set(productId, plan);
    }
  }

  const initialPrevDebt = input.customer
    ? roundMoney(Math.max(0, Number(input.customer.totalDebt) || 0))
    : 0;
  const requestedReceivablePay = roundMoney(Math.max(0, Number(input.receivablePayAmount) || 0));

  const initialCombined = calculateCombinedPosSettlement({
    saleTotalAmount: totalAmount,
    paymentMethod: input.paymentMethod,
    paidAmount: input.paidAmount,
    cashPart: input.cashPart,
    qrisPart: input.qrisPart,
    qrisFeePercent: input.qrisFeePercent ?? DEFAULT_QRIS_FEE_PERCENT,
    customerPrevDebt: initialPrevDebt,
    receivablePayAmount: requestedReceivablePay,
  });

  const cashAccount = input.account || null;
  const qrisTargetAccount =
    input.paymentMethod === 'qris' || input.paymentMethod === 'mixed'
      ? input.qrisAccount || input.account || null
      : null;

  const totalCashNeeded = roundMoney(
    initialCombined.saleSettlement.cashDepositAmount + initialCombined.receivableCashIn
  );
  const totalQrisNeeded = roundMoney(
    initialCombined.saleSettlement.qrisNetDepositAmount + initialCombined.receivableQrisIn
  );

  if (totalCashNeeded > 0 && !cashAccount) {
    throw new Error(
      isDebtSale
        ? 'Pilih akun kas/rekening untuk mencatat uang muka (DP) kasbon.'
        : 'Pilih akun kas/rekening penerima pembayaran.'
    );
  }
  if (totalQrisNeeded > 0 && !qrisTargetAccount) {
    throw new Error('Pilih rekening/akun QRIS penerima pembayaran.');
  }

  const saleId = generateSafeId('sale');
  const resolvedCustomerId = input.customer?.id || (willAutoCreateCustomer ? generateSafeId('cst') : undefined);
  const meta = createTransactionMetadata('POS', user);
  const effectiveCustomerName = (input.customer?.name || cleanTypedCustomerName).slice(0, 100);
  const effectiveCustomerPhone = input.customer?.phone || (willAutoCreateCustomer ? cleanNewCustomerPhone : '');
  const cleanOverrideReason = (input.expiredOverrideReason || '').trim().slice(0, 200);

  const buildSaleDocPayload = (
    usedExpiredFlag: boolean,
    combined: ReturnType<typeof calculateCombinedPosSettlement>
  ) => {
    const s = combined.saleSettlement;
    const includeDebtSummary =
      combined.receivablePaidAmount > 0 || combined.customerDebtBefore > 0 || s.debtAmount > 0;
    return {
      ...meta,
      ...(resolvedCustomerId ? { customerId: resolvedCustomerId } : {}),
      ...(effectiveCustomerName ? { customerName: effectiveCustomerName } : {}),
      totalItems,
      subtotal,
      discount,
      totalAmount,
      totalCost,
      totalProfit,
      paidAmount: combined.grandPaidAmount,
      changeAmount: combined.grandChangeAmount,
      debtAmount: s.debtAmount,
      paymentMethod: input.paymentMethod,
      cashPaidPart: s.cashPaidPart,
      qrisAmount: s.qrisAmount,
      qrisFeeRate: s.qrisFeeRate,
      qrisFeeAmount: s.qrisFeeAmount,
      netReceivedAmount: s.netReceivedAmount,
      ...(cashAccount && s.cashDepositAmount > 0 ? { accountId: cashAccount.id } : {}),
      ...(qrisTargetAccount && s.qrisAmount > 0 ? { qrisAccountId: qrisTargetAccount.id } : {}),
      ...(includeDebtSummary
        ? {
            receivablePaidAmount: combined.receivablePaidAmount,
            customerDebtBefore: combined.customerDebtBefore,
            customerDebtAfter: combined.customerDebtAfter,
          }
        : {}),
      ...(allowExpired && usedExpiredFlag
        ? {
            expiredOverrideApproved: true,
            expiredOverrideByUid: user.uid,
            expiredOverrideByName: user.displayName.trim().slice(0, 100) || 'Admin',
            ...(cleanOverrideReason ? { expiredOverrideReason: cleanOverrideReason } : {}),
          }
        : {}),
      status: 'completed',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
  };

  const applyDepositsAndReceivables = (
    writer: {
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    },
    cashAccState: Account | null,
    qrisAccState: Account | null,
    combined: ReturnType<typeof calculateCombinedPosSettlement>
  ) => {
    const s = combined.saleSettlement;
    const balCursor = new Map<string, number>();
    const accStateMap = new Map<string, Account>();

    if (cashAccState) {
      balCursor.set(cashAccState.id, roundMoney(Number(cashAccState.balance) || 0));
      accStateMap.set(cashAccState.id, cashAccState);
    }
    if (qrisAccState && !balCursor.has(qrisAccState.id)) {
      balCursor.set(qrisAccState.id, roundMoney(Number(qrisAccState.balance) || 0));
      accStateMap.set(qrisAccState.id, qrisAccState);
    }

    const pushDeposit = (params: {
      acc: Account | null;
      amount: number;
      sourceModule: 'sale' | 'receivable';
      referenceId: string;
      transactionNumber: string;
      description: string;
      txMeta: typeof meta;
    }) => {
      if (!params.acc || params.amount <= 0) return;
      const balBefore = balCursor.get(params.acc.id) ?? roundMoney(Number(params.acc.balance) || 0);
      const balAfter = roundMoney(balBefore + params.amount);
      balCursor.set(params.acc.id, balAfter);

      writer.set(doc(db, 'cash_ledger', generateSafeId('ldg')), {
        ...params.txMeta,
        transactionNumber: params.transactionNumber.slice(0, 40),
        accountId: params.acc.id,
        accountName: params.acc.name.slice(0, 80),
        direction: 'in',
        amount: params.amount,
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        sourceModule: params.sourceModule,
        referenceId: params.referenceId,
        description: params.description.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    };

    // 1. Setoran dari penjualan retail
    const hasSplitSaleDeposit = s.cashDepositAmount > 0 && s.qrisNetDepositAmount > 0;
    if (s.cashDepositAmount > 0) {
      pushDeposit({
        acc: cashAccState,
        amount: s.cashDepositAmount,
        sourceModule: 'sale',
        referenceId: saleId,
        transactionNumber: hasSplitSaleDeposit
          ? `${meta.transactionNumber}-T`
          : meta.transactionNumber,
        description: isDebtSale
          ? `DP Kasbon ${effectiveCustomerName} (${meta.transactionNumber})`
          : input.paymentMethod === 'mixed'
            ? `Penjualan Tunai (Gabungan) ${meta.transactionNumber}`
            : `Penjualan retail ${meta.transactionNumber}`,
        txMeta: meta,
      });
    }

    if (s.qrisNetDepositAmount > 0) {
      pushDeposit({
        acc: qrisAccState,
        amount: s.qrisNetDepositAmount,
        sourceModule: 'sale',
        referenceId: saleId,
        transactionNumber: hasSplitSaleDeposit
          ? `${meta.transactionNumber}-Q`
          : meta.transactionNumber,
        description: `Penjualan QRIS bersih ${meta.transactionNumber} (Bruto ${formatRupiah(
          s.qrisAmount
        )}, Pot. QRIS ${formatRupiah(s.qrisFeeAmount)})`,
        txMeta: meta,
      });
    }

    // 2. Pelanggan baru otomatis / update piutang & catatan receivables
    if (willAutoCreateCustomer && resolvedCustomerId) {
      writer.set(doc(db, 'customers', resolvedCustomerId), {
        name: effectiveCustomerName,
        ...(cleanNewCustomerPhone ? { phone: cleanNewCustomerPhone } : {}),
        totalDebt: isDebtSale ? s.debtAmount : 0,
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (input.customer) {
      const debtChanged =
        (isDebtSale && s.debtAmount > 0) || combined.receivablePaidAmount > 0;
      if (debtChanged) {
        writer.update(doc(db, 'customers', input.customer.id), {
          totalDebt: combined.customerDebtAfter,
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (isDebtSale && resolvedCustomerId && s.debtAmount > 0) {
      const recId = generateSafeId('rec');
      const recMeta = createTransactionMetadata('KBN', user);
      writer.set(doc(db, 'receivables', recId), {
        ...recMeta,
        customerId: resolvedCustomerId,
        customerName: effectiveCustomerName,
        type: 'debt',
        amount: s.debtAmount,
        balanceAfter: combined.customerDebtAfter,
        saleId,
        ...(cashAccState && s.cashDepositAmount > 0 ? { accountId: cashAccState.id } : {}),
        notes: (
          s.paidAmount > 0
            ? `Kasbon Kasir ${meta.transactionNumber} (Total ${formatRupiah(
                totalAmount
              )}, DP ${formatRupiah(s.paidAmount)})`
            : `Kasbon Kasir ${meta.transactionNumber}`
        ).slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

    if (!isDebtSale && input.customer && combined.receivablePaidAmount > 0) {
      let runningRecBalance = combined.customerDebtBefore;
      const recPayEntries: { acc: Account | null; amount: number; suffix: string; label: string }[] =
        [];
      if (combined.receivableCashIn > 0) {
        recPayEntries.push({
          acc: cashAccState,
          amount: combined.receivableCashIn,
          suffix: combined.receivableQrisIn > 0 ? '-T' : '',
          label: input.paymentMethod === 'transfer' ? 'Transfer' : 'Tunai',
        });
      }
      if (combined.receivableQrisIn > 0) {
        recPayEntries.push({
          acc: qrisAccState,
          amount: combined.receivableQrisIn,
          suffix: combined.receivableCashIn > 0 ? '-Q' : '',
          label: 'QRIS',
        });
      }

      recPayEntries.forEach((entry) => {
        if (!entry.acc || entry.amount <= 0) return;
        runningRecBalance = roundMoney(Math.max(0, runningRecBalance - entry.amount));
        const payRecId = generateSafeId('recp');
        const payMeta = createTransactionMetadata('BYP', user);
        const recTrxNum = `${payMeta.transactionNumber}${entry.suffix}`.slice(0, 40);

        writer.set(doc(db, 'receivables', payRecId), {
          ...payMeta,
          transactionNumber: recTrxNum,
          customerId: input.customer!.id,
          customerName: effectiveCustomerName,
          type: 'payment',
          amount: entry.amount,
          balanceAfter: runningRecBalance,
          saleId,
          accountId: entry.acc.id,
          notes: `Bayar piutang di Kasir (${entry.label}) · ${meta.transactionNumber}`.slice(0, 240),
          createdAt: serverTimestamp(),
        });

        pushDeposit({
          acc: entry.acc,
          amount: entry.amount,
          sourceModule: 'receivable',
          referenceId: payRecId,
          transactionNumber: `${payMeta.transactionNumber}${entry.suffix}`,
          description: `Bayar piutang ${effectiveCustomerName} di Kasir (${meta.transactionNumber})`,
          txMeta: payMeta,
        });
      });
    }

    // 3. Commit satu kali update saldo akhir per akun yang terlibat
    for (const [accId, finalBalance] of balCursor.entries()) {
      const originalAcc = accStateMap.get(accId);
      const originalBal = originalAcc ? roundMoney(Number(originalAcc.balance) || 0) : finalBalance;
      if (finalBalance !== originalBal) {
        writer.update(doc(db, 'accounts', accId), {
          balance: finalBalance,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      }
    }
  };

  let finalCombined = initialCombined;

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'sales', saleId), buildSaleDocPayload(usedExpiredInSale, initialCombined));

    const rawProdStockMap = new Map<string, number>();
    const runningStockMap = new Map<string, number>();
    for (const { product } of baseDemandByProduct.values()) {
      const rawStock = Math.max(0, Number(product.stock) || 0);
      rawProdStockMap.set(product.id, rawStock);
      runningStockMap.set(
        product.id,
        snapStockToProductPrecision(rawStock, product)
      );
    }

    resolvedLines.forEach(({ item, resolved }, idx) => {
      const itemId = generateSafeId(`itm${idx}`);
      batch.set(doc(db, 'sales', saleId, 'items', itemId), {
        saleId,
        productId: item.product.id,
        productName: item.product.name.slice(0, 120),
        unitName: resolved.option.unitName.slice(0, 24),
        conversion: resolved.option.conversion,
        baseQuantity: resolved.baseQuantity,
        priceTier: resolved.priceTier,
        quantity: roundQty(item.quantity),
        costPrice: item.product.costPrice,
        unitPrice: resolved.unitPrice,
        subtotal: resolved.lineRevenue,
        profit: resolved.lineProfit,
        recordedByUid: user.uid,
        createdAt: serverTimestamp(),
      });

      const stockBefore = runningStockMap.get(item.product.id) ?? 0;
      const stockAfter = snapStockToProductPrecision(
        Math.max(0, stockBefore - resolved.baseQuantity),
        item.product
      );
      runningStockMap.set(item.product.id, stockAfter);

      const moveId = generateSafeId(`stk${idx}`);
      const convNote =
        resolved.option.conversion !== 1
          ? ` (${formatQty(item.quantity)} ${resolved.option.unitName} = ${formatQty(
              resolved.baseQuantity
            )} ${item.product.unit})`
          : ` (${formatQty(item.quantity)} ${resolved.option.unitName})`;

      batch.set(doc(db, 'stock_movements', moveId), {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-${idx + 1}`.slice(0, 40),
        productId: item.product.id,
        productName: item.product.name.slice(0, 120),
        baseUnit: item.product.unit.slice(0, 24),
        unitName: resolved.option.unitName.slice(0, 24),
        unitQuantity: roundQty(item.quantity),
        conversion: resolved.option.conversion,
        type: 'out',
        quantity: resolved.baseQuantity,
        stockBefore,
        stockAfter,
        referenceId: saleId,
        notes: `Kasir ${meta.transactionNumber} [${
          resolved.priceTier === 'wholesale' ? 'Grosir' : 'Ecer'
        }]${convNote}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    });

    for (const [productId, finalStock] of runningStockMap.entries()) {
      const rawStock = rawProdStockMap.get(productId);
      const safeFinalStock =
        rawStock !== undefined ? Math.min(rawStock, Math.max(0, finalStock)) : Math.max(0, finalStock);
      batch.update(doc(db, 'products', productId), {
        stock: safeFinalStock,
        updatedAt: serverTimestamp(),
      });
    }

    const rawBatchRemMap = new Map<string, number>();
    allBatches.forEach((b) => {
      rawBatchRemMap.set(b.id, Math.max(0, Number(b.remainingBaseQty) || 0));
    });

    for (const plan of initialFefoPlans.values()) {
      for (const alloc of plan.allocations) {
        if (alloc.deductQty <= 0) continue;
        const rawBatchRem = rawBatchRemMap.get(alloc.batchId);
        const safeRemaining =
          rawBatchRem !== undefined
            ? Math.min(rawBatchRem, Math.max(0, alloc.remainingAfter))
            : Math.max(0, alloc.remainingAfter);
        batch.update(doc(db, 'stock_batches', alloc.batchId), {
          remainingBaseQty: safeRemaining,
          status: alloc.nextStatus,
          updatedAt: serverTimestamp(),
        });
      }
    }

    applyDepositsAndReceivables(batch, cashAccount, qrisTargetAccount, initialCombined);
    finalCombined = initialCombined;

    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const productEntries = Array.from(baseDemandByProduct.values());
          const productSnaps = await Promise.all(
            productEntries.map(({ product }) => tx.get(doc(db, 'products', product.id)))
          );

          // Baca dokumen batch aktif yang terlibat secara atomik sebelum penulisan
          const relevantBatchIds = Array.from(
            new Set(
              allBatches
                .filter(
                  (b) =>
                    baseDemandByProduct.has(b.productId) &&
                    b.status === 'active' &&
                    Number(b.remainingBaseQty) > 0.00001
                )
                .map((b) => b.id)
            )
          );
          const batchSnaps = await Promise.all(
            relevantBatchIds.map((id) => tx.get(doc(db, 'stock_batches', id)))
          );

          const uniqueAccIds = new Set<string>();
          if (cashAccount && totalCashNeeded > 0) uniqueAccIds.add(cashAccount.id);
          if (qrisTargetAccount && totalQrisNeeded > 0) {
            uniqueAccIds.add(qrisTargetAccount.id);
          }
          const accIdList = Array.from(uniqueAccIds);
          const accSnaps = await Promise.all(
            accIdList.map((id) => tx.get(doc(db, 'accounts', id)))
          );

          const custSnap = input.customer
            ? await tx.get(doc(db, 'customers', input.customer.id))
            : null;

          // Validate live stock & live batch expiry
          const liveBatches: StockBatch[] = [];
          batchSnaps.forEach((snap) => {
            if (snap.exists()) {
              liveBatches.push({ id: snap.id, ...(snap.data() as Omit<StockBatch, 'id'>) });
            }
          });

          const rawProdStockMap = new Map<string, number>();
          const rawBatchRemMap = new Map<string, number>();
          liveBatches.forEach((b) => {
            rawBatchRemMap.set(b.id, Math.max(0, Number(b.remainingBaseQty) || 0));
          });
          const runningStockMap = new Map<string, number>();
          const liveFefoPlans: ReturnType<typeof planFefoBatchDeduction>[] = [];
          let liveUsedExpired = false;

          productEntries.forEach(({ product, totalBaseQty }, idx) => {
            const pSnap = productSnaps[idx];
            if (!pSnap.exists()) {
              throw new Error(`Produk "${product.name}" tidak ditemukan atau telah dihapus oleh Admin.`);
            }
            const liveProdData = pSnap.data() as Product;
            const rawLiveStock = Math.max(0, Number(liveProdData.stock) || 0);
            rawProdStockMap.set(product.id, rawLiveStock);
            const liveStock = snapStockToProductPrecision(
              rawLiveStock,
              liveProdData
            );
            if (!isStockSufficientWithTolerance(liveStock, totalBaseQty, liveProdData)) {
              throw new Error(
                `Stok "${product.name}" tidak mencukupi (tersedia ${formatQty(liveStock)} ${product.unit}, butuh ${formatQty(totalBaseQty)} ${product.unit}).`
              );
            }
            runningStockMap.set(product.id, liveStock);

            if (liveBatches.length > 0) {
              const plan = planFefoBatchDeduction(
                { id: product.id, stock: liveStock },
                liveBatches,
                totalBaseQty,
                allowExpired
              );
              if (!plan.ok && plan.blockedByExpired) {
                throw new Error(
                  `Produk "${product.name}" memiliki stok sudah kedaluwarsa (EXPIRED) dan tidak boleh dijual tanpa persetujuan Admin.`
                );
              }
              if (plan.usedExpiredBatches) {
                liveUsedExpired = true;
              }
              liveFefoPlans.push(plan);
            }
          });

          const liveAccMap = new Map<string, Account>();
          accIdList.forEach((id, idx) => {
            const snap = accSnaps[idx];
            if (!snap.exists()) {
              throw new Error('Akun kas/rekening yang dipilih tidak ditemukan.');
            }
            liveAccMap.set(id, { id, ...(snap.data() as Omit<Account, 'id'>) });
          });

          const livePrevDebt =
            custSnap && custSnap.exists()
              ? roundMoney(Math.max(0, Number((custSnap.data() as Customer).totalDebt) || 0))
              : initialPrevDebt;

          const liveCombined = calculateCombinedPosSettlement({
            saleTotalAmount: totalAmount,
            paymentMethod: input.paymentMethod,
            paidAmount: input.paidAmount,
            cashPart: input.cashPart,
            qrisPart: input.qrisPart,
            qrisFeePercent: input.qrisFeePercent ?? DEFAULT_QRIS_FEE_PERCENT,
            customerPrevDebt: livePrevDebt,
            receivablePayAmount: requestedReceivablePay,
          });
          finalCombined = liveCombined;

          // Execute atomic writes
          tx.set(doc(db, 'sales', saleId), buildSaleDocPayload(liveUsedExpired, liveCombined));

          resolvedLines.forEach(({ item, resolved }, idx) => {
            const itemId = generateSafeId(`itm${idx}`);
            tx.set(doc(db, 'sales', saleId, 'items', itemId), {
              saleId,
              productId: item.product.id,
              productName: item.product.name.slice(0, 120),
              unitName: resolved.option.unitName.slice(0, 24),
              conversion: resolved.option.conversion,
              baseQuantity: resolved.baseQuantity,
              priceTier: resolved.priceTier,
              quantity: roundQty(item.quantity),
              costPrice: item.product.costPrice,
              unitPrice: resolved.unitPrice,
              subtotal: resolved.lineRevenue,
              profit: resolved.lineProfit,
              recordedByUid: user.uid,
              createdAt: serverTimestamp(),
            });

            const stockBefore = runningStockMap.get(item.product.id) ?? 0;
            const stockAfter = snapStockToProductPrecision(
              Math.max(0, stockBefore - resolved.baseQuantity),
              item.product
            );
            runningStockMap.set(item.product.id, stockAfter);

            const moveId = generateSafeId(`stk${idx}`);
            const convNote =
              resolved.option.conversion !== 1
                ? ` (${formatQty(item.quantity)} ${resolved.option.unitName} = ${formatQty(
                    resolved.baseQuantity
                  )} ${item.product.unit})`
                : ` (${formatQty(item.quantity)} ${resolved.option.unitName})`;

            tx.set(doc(db, 'stock_movements', moveId), {
              ...meta,
              transactionNumber: `${meta.transactionNumber}-${idx + 1}`.slice(0, 40),
              productId: item.product.id,
              productName: item.product.name.slice(0, 120),
              baseUnit: item.product.unit.slice(0, 24),
              unitName: resolved.option.unitName.slice(0, 24),
              unitQuantity: roundQty(item.quantity),
              conversion: resolved.option.conversion,
              type: 'out',
              quantity: resolved.baseQuantity,
              stockBefore,
              stockAfter,
              referenceId: saleId,
              notes: `Kasir ${meta.transactionNumber} [${
                resolved.priceTier === 'wholesale' ? 'Grosir' : 'Ecer'
              }]${convNote}`.slice(0, 240),
              createdAt: serverTimestamp(),
            });
          });

          for (const [productId, finalStock] of runningStockMap.entries()) {
            const rawStock = rawProdStockMap.get(productId);
            const safeFinalStock =
              rawStock !== undefined
                ? Math.min(rawStock, Math.max(0, finalStock))
                : Math.max(0, finalStock);
            tx.update(doc(db, 'products', productId), {
              stock: safeFinalStock,
              updatedAt: serverTimestamp(),
            });
          }

          for (const plan of liveFefoPlans) {
            for (const alloc of plan.allocations) {
              if (alloc.deductQty <= 0) continue;
              const rawBatchRem = rawBatchRemMap.get(alloc.batchId);
              const safeRemaining =
                rawBatchRem !== undefined
                  ? Math.min(rawBatchRem, Math.max(0, alloc.remainingAfter))
                  : Math.max(0, alloc.remainingAfter);
              tx.update(doc(db, 'stock_batches', alloc.batchId), {
                remainingBaseQty: safeRemaining,
                status: alloc.nextStatus,
                updatedAt: serverTimestamp(),
              });
            }
          }

          applyDepositsAndReceivables(
            tx,
            cashAccount ? liveAccMap.get(cashAccount.id) || null : null,
            qrisTargetAccount ? liveAccMap.get(qrisTargetAccount.id) || null : null,
            liveCombined
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

    const sOut = finalCombined.saleSettlement;
    const hasDebtMeta =
      finalCombined.receivablePaidAmount > 0 ||
      finalCombined.customerDebtBefore > 0 ||
      sOut.debtAmount > 0;

    return {
      saleId,
      transactionNumber: meta.transactionNumber,
      transactionDate: meta.transactionDate,
      transactionTime: meta.transactionTime,
      recordedByName: meta.recordedByName,
      ...(resolvedCustomerId ? { customerId: resolvedCustomerId } : {}),
      ...(effectiveCustomerName ? { customerName: effectiveCustomerName } : {}),
      ...(effectiveCustomerPhone ? { customerPhone: effectiveCustomerPhone } : {}),
      items: resolvedLines.map(({ item, resolved }) => ({
        name: item.product.name,
        unitName: resolved.option.unitName,
        baseUnit: item.product.unit,
        conversion: resolved.option.conversion,
        baseQuantity: resolved.baseQuantity,
        priceTier: resolved.priceTier,
        quantity: roundQty(item.quantity),
        unitPrice: resolved.unitPrice,
        subtotal: resolved.lineRevenue,
        profit: resolved.lineProfit,
      })),
      subtotal,
      discount,
      totalAmount,
      totalCost,
      totalProfit,
      paidAmount: finalCombined.grandPaidAmount,
      changeAmount: finalCombined.grandChangeAmount,
      debtAmount: sOut.debtAmount,
      ...(hasDebtMeta
        ? {
            receivablePaidAmount: finalCombined.receivablePaidAmount,
            customerDebtBefore: finalCombined.customerDebtBefore,
            customerDebtAfter: finalCombined.customerDebtAfter,
          }
        : {}),
      paymentMethod: input.paymentMethod,
      cashPaidPart: sOut.cashPaidPart,
      qrisAmount: sOut.qrisAmount,
      qrisFeeRate: sOut.qrisFeeRate,
      qrisFeeAmount: sOut.qrisFeeAmount,
      netReceivedAmount: sOut.netReceivedAmount,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `sales/${saleId}`);
  }
}

export function subscribeRecentSales(
  isAdmin: boolean,
  userUid: string,
  onData: (sales: Sale[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = isAdmin
    ? query(collection(db, 'sales'), orderBy('createdAt', 'desc'), limit(50))
    : query(collection(db, 'sales'), where('recordedByUid', '==', userUid), limit(50));

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Sale[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Sale, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list.slice(0, 50));
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'sales');
    }
  );
}

export async function fetchSaleReceiptFromSale(
  sale: Sale,
  _isAdmin: boolean,
  _userUid: string,
  customers: Customer[]
): Promise<RecordedSaleReceipt> {
  const itemsPath = `sales/${sale.id}/items`;
  try {
    const itemsRef = collection(db, 'sales', sale.id, 'items');
    const q = _isAdmin
      ? query(itemsRef)
      : query(itemsRef, where('recordedByUid', '==', _userUid));
    const snap = await getDocs(q);
    const saleItems: SaleItem[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<SaleItem, 'id'>),
    }));

    const matchedCustomer =
      (sale.customerId ? customers.find((c) => c.id === sale.customerId) : undefined) ||
      (sale.customerName
        ? customers.find(
            (c) => c.name.trim().toLowerCase() === sale.customerName!.trim().toLowerCase()
          )
        : undefined);

    return {
      saleId: sale.id,
      transactionNumber: sale.transactionNumber,
      transactionDate: sale.transactionDate,
      transactionTime: sale.transactionTime,
      recordedByName: sale.recordedByName,
      customerId: sale.customerId || matchedCustomer?.id,
      customerName: sale.customerName || matchedCustomer?.name,
      customerPhone: matchedCustomer?.phone,
      items: saleItems.map((it) => ({
        name: it.productName,
        unitName: it.unitName || 'PCS',
        baseUnit: it.unitName || 'PCS',
        conversion: Number(it.conversion) > 0 ? Number(it.conversion) : 1,
        baseQuantity: Number(it.baseQuantity) > 0 ? Number(it.baseQuantity) : Number(it.quantity),
        priceTier: it.priceTier === 'wholesale' ? 'wholesale' : 'retail',
        quantity: Number(it.quantity) || 0,
        unitPrice: Number(it.unitPrice) || 0,
        subtotal: Number(it.subtotal) || 0,
        profit: Number(it.profit) || 0,
      })),
      subtotal: Number(sale.subtotal) || 0,
      discount: Number(sale.discount) || 0,
      totalAmount: Number(sale.totalAmount) || 0,
      totalCost: Number(sale.totalCost) || 0,
      totalProfit: Number(sale.totalProfit) || 0,
      paidAmount: Number(sale.paidAmount) || 0,
      changeAmount: Number(sale.changeAmount) || 0,
      debtAmount: Number(sale.debtAmount) || 0,
      ...(sale.receivablePaidAmount !== undefined
        ? { receivablePaidAmount: Number(sale.receivablePaidAmount) || 0 }
        : {}),
      ...(sale.customerDebtBefore !== undefined
        ? { customerDebtBefore: Number(sale.customerDebtBefore) || 0 }
        : {}),
      ...(sale.customerDebtAfter !== undefined
        ? { customerDebtAfter: Number(sale.customerDebtAfter) || 0 }
        : {}),
      paymentMethod: sale.paymentMethod,
      cashPaidPart: Number(sale.cashPaidPart) || 0,
      qrisAmount: Number(sale.qrisAmount) || 0,
      qrisFeeRate: Number(sale.qrisFeeRate) || 0,
      qrisFeeAmount: Number(sale.qrisFeeAmount) || 0,
      netReceivedAmount: Number(sale.netReceivedAmount) || 0,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, itemsPath);
  }
}

