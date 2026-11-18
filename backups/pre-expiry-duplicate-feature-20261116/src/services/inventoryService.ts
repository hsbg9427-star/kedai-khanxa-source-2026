import {
  collection,
  deleteDoc,
  deleteField,
  doc,
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
  StockMovement,
} from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import {
  createTransactionMetadata,
  formatQty,
  formatRupiah,
  generateSafeId,
  getTodayDateString,
} from '../utils/formatters';
import {
  calculateSaleSettlement,
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

export interface ProductPayload {
  sku: string;
  barcode?: string;
  name: string;
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
  isActive: boolean;
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

export async function createProductWithInitialStock(
  payload: ProductPayload,
  user: { uid: string; displayName: string }
): Promise<string> {
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
    batch.set(productRef, {
      sku: payload.sku.trim().slice(0, 40),
      ...(payload.barcode?.trim() ? { barcode: payload.barcode.trim().slice(0, 64) } : {}),
      name: payload.name.trim().slice(0, 120),
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
      productName: payload.name.trim().slice(0, 120),
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

    if (initialStock !== 0) {
      const moveId = generateSafeId('stk');
      const meta = createTransactionMetadata('STK', user);
      batch.set(doc(db, 'stock_movements', moveId), {
        ...meta,
        productId,
        productName: payload.name.trim().slice(0, 120),
        baseUnit,
        unitName: baseUnit,
        unitQuantity: initialStock,
        conversion: 1,
        type: 'in',
        quantity: initialStock,
        stockBefore: 0,
        stockAfter: initialStock,
        notes: `Stok awal produk baru (${formatQty(initialStock)} ${baseUnit})`,
        createdAt: serverTimestamp(),
      });
    }

    await batch.commit();
    return productId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `products/${productId}`);
  }
}

export async function updateProductDetails(
  prevProduct: Product,
  payload: Omit<ProductPayload, 'stock'>,
  user: { uid: string; displayName: string }
): Promise<void> {
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

  try {
    const batch = writeBatch(db);
    const updatedFields: Record<string, unknown> = {
      sku: payload.sku.trim().slice(0, 40),
      barcode: (payload.barcode || '').trim().slice(0, 64),
      name: payload.name.trim().slice(0, 120),
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

    batch.update(ref, updatedFields);

    if (priceOrUnitChanged) {
      const priceId = generateSafeId('prc');
      const priceMeta = createTransactionMetadata('PRC', user);
      batch.set(doc(db, 'price_history', priceId), {
        ...priceMeta,
        productId: prevProduct.id,
        productName: payload.name.trim().slice(0, 120),
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

export async function deleteProduct(productId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'products', productId));
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
  unitName?: string
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
    batch.update(doc(db, 'products', product.id), {
      stock: stockAfter,
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
  user: { uid: string; displayName: string }
): Promise<number> {
  let importedCount = 0;
  // Maksimal 100 produk per batch (100 produk + 100 price_history + hingga 100 stock_movements <= 300 ops)
  const CHUNK_SIZE = 100;

  try {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);

      chunk.forEach((row) => {
        const productId = generateSafeId('prd');
        const cleanStock = Math.max(0, Number(row.stock) || 0);
        const cleanSellUnits = sanitizeSellUnits(row.sellUnits, row.unit);

        batch.set(doc(db, 'products', productId), {
          sku: row.sku,
          ...(row.barcode ? { barcode: row.barcode } : {}),
          name: row.name,
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
          productName: row.name,
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

        if (cleanStock !== 0) {
          const moveId = generateSafeId('stk');
          const meta = createTransactionMetadata('IMP', user);
          batch.set(doc(db, 'stock_movements', moveId), {
            ...meta,
            productId,
            productName: row.name,
            baseUnit: row.unit,
            unitName: row.unit,
            unitQuantity: cleanStock,
            conversion: 1,
            type: 'in',
            quantity: cleanStock,
            stockBefore: 0,
            stockAfter: cleanStock,
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
  _isAdmin: boolean,
  _userUid: string,
  onData: (movements: StockMovement[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'stock_movements'));

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
  _isAdmin: boolean,
  _userUid: string,
  onData: (history: PriceHistory[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'price_history'));

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
  if (isDebtSale && !input.customer) {
    throw new Error('Pilih pelanggan terdaftar terlebih dahulu untuk transaksi Kasbon / Piutang.');
  }

  const settlement = calculateSaleSettlement({
    totalAmount,
    paymentMethod: input.paymentMethod,
    paidAmount: input.paidAmount,
    cashPart: input.cashPart,
    qrisPart: input.qrisPart,
    qrisFeePercent: input.qrisFeePercent ?? DEFAULT_QRIS_FEE_PERCENT,
  });

  const cashAccount = input.account || null;
  const qrisTargetAccount =
    input.paymentMethod === 'qris'
      ? input.qrisAccount || input.account || null
      : input.paymentMethod === 'mixed'
        ? input.qrisAccount || input.account || null
        : null;

  if (settlement.cashDepositAmount > 0 && !cashAccount) {
    throw new Error(
      isDebtSale
        ? 'Pilih akun kas/rekening untuk mencatat uang muka (DP) kasbon.'
        : 'Pilih akun kas/rekening penerima pembayaran.'
    );
  }
  if (settlement.qrisNetDepositAmount > 0 && !qrisTargetAccount) {
    throw new Error('Pilih rekening/akun QRIS penerima pembayaran.');
  }

  const saleId = generateSafeId('sale');
  const meta = createTransactionMetadata('POS', user);
  const effectiveCustomerName = (input.customer?.name || input.customerName || '')
    .trim()
    .slice(0, 100);

  const buildSaleDocPayload = () => ({
    ...meta,
    ...(input.customer ? { customerId: input.customer.id } : {}),
    ...(effectiveCustomerName ? { customerName: effectiveCustomerName } : {}),
    totalItems,
    subtotal,
    discount,
    totalAmount,
    totalCost,
    totalProfit,
    paidAmount: settlement.paidAmount,
    changeAmount: settlement.changeAmount,
    debtAmount: settlement.debtAmount,
    paymentMethod: input.paymentMethod,
    cashPaidPart: settlement.cashPaidPart,
    qrisAmount: settlement.qrisAmount,
    qrisFeeRate: settlement.qrisFeeRate,
    qrisFeeAmount: settlement.qrisFeeAmount,
    netReceivedAmount: settlement.netReceivedAmount,
    ...(cashAccount && settlement.cashDepositAmount > 0 ? { accountId: cashAccount.id } : {}),
    ...(qrisTargetAccount && settlement.qrisAmount > 0
      ? { qrisAccountId: qrisTargetAccount.id }
      : {}),
    status: 'completed',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const applyAccountDeposits = (
    writer: {
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    },
    cashAccState: Account | null,
    qrisAccState: Account | null
  ) => {
    const cashIn = settlement.cashDepositAmount;
    const qrisNetIn = settlement.qrisNetDepositAmount;

    if (
      cashAccState &&
      qrisAccState &&
      cashAccState.id === qrisAccState.id &&
      cashIn > 0 &&
      qrisNetIn > 0
    ) {
      const bal0 = roundMoney(Number(cashAccState.balance) || 0);
      const bal1 = roundMoney(bal0 + cashIn);
      const bal2 = roundMoney(bal1 + qrisNetIn);

      writer.update(doc(db, 'accounts', cashAccState.id), {
        balance: bal2,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });

      writer.set(doc(db, 'cash_ledger', generateSafeId('ldg1')), {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-T`.slice(0, 40),
        accountId: cashAccState.id,
        accountName: cashAccState.name.slice(0, 80),
        direction: 'in',
        amount: cashIn,
        balanceBefore: bal0,
        balanceAfter: bal1,
        sourceModule: 'sale',
        referenceId: saleId,
        description: `Penjualan retail Tunai (Gabungan) ${meta.transactionNumber}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });

      writer.set(doc(db, 'cash_ledger', generateSafeId('ldg2')), {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-Q`.slice(0, 40),
        accountId: cashAccState.id,
        accountName: cashAccState.name.slice(0, 80),
        direction: 'in',
        amount: qrisNetIn,
        balanceBefore: bal1,
        balanceAfter: bal2,
        sourceModule: 'sale',
        referenceId: saleId,
        description: `Penjualan QRIS bersih ${meta.transactionNumber} (Bruto ${formatRupiah(
          settlement.qrisAmount
        )}, Pot. QRIS ${formatRupiah(settlement.qrisFeeAmount)})`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
      return;
    }

    if (cashAccState && cashIn > 0) {
      const balBefore = roundMoney(Number(cashAccState.balance) || 0);
      const balAfter = roundMoney(balBefore + cashIn);
      writer.update(doc(db, 'accounts', cashAccState.id), {
        balance: balAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
      writer.set(doc(db, 'cash_ledger', generateSafeId('ldg1')), {
        ...meta,
        transactionNumber:
          qrisNetIn > 0 ? `${meta.transactionNumber}-T`.slice(0, 40) : meta.transactionNumber,
        accountId: cashAccState.id,
        accountName: cashAccState.name.slice(0, 80),
        direction: 'in',
        amount: cashIn,
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        sourceModule: 'sale',
        referenceId: saleId,
        description: isDebtSale
          ? `DP Kasbon ${effectiveCustomerName} (${meta.transactionNumber})`.slice(0, 240)
          : input.paymentMethod === 'mixed'
            ? `Penjualan Tunai (Gabungan) ${meta.transactionNumber}`.slice(0, 240)
            : `Penjualan retail ${meta.transactionNumber}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

    if (qrisAccState && qrisNetIn > 0) {
      const balBefore = roundMoney(Number(qrisAccState.balance) || 0);
      const balAfter = roundMoney(balBefore + qrisNetIn);
      writer.update(doc(db, 'accounts', qrisAccState.id), {
        balance: balAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
      writer.set(doc(db, 'cash_ledger', generateSafeId('ldg2')), {
        ...meta,
        transactionNumber:
          cashIn > 0 ? `${meta.transactionNumber}-Q`.slice(0, 40) : meta.transactionNumber,
        accountId: qrisAccState.id,
        accountName: qrisAccState.name.slice(0, 80),
        direction: 'in',
        amount: qrisNetIn,
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        sourceModule: 'sale',
        referenceId: saleId,
        description: `Penjualan QRIS bersih ${meta.transactionNumber} (Bruto ${formatRupiah(
          settlement.qrisAmount
        )}, Pot. QRIS ${formatRupiah(settlement.qrisFeeAmount)})`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }
  };

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'sales', saleId), buildSaleDocPayload());

    const runningStockMap = new Map<string, number>();
    for (const { product } of baseDemandByProduct.values()) {
      runningStockMap.set(
        product.id,
        snapStockToProductPrecision(Number(product.stock) || 0, product)
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
      batch.update(doc(db, 'products', productId), {
        stock: finalStock,
        updatedAt: serverTimestamp(),
      });
    }

    applyAccountDeposits(batch, cashAccount, qrisTargetAccount);

    if (isDebtSale && input.customer && settlement.debtAmount > 0) {
      const prevDebt = roundMoney(Math.max(0, Number(input.customer.totalDebt) || 0));
      const newDebt = roundMoney(prevDebt + settlement.debtAmount);
      batch.update(doc(db, 'customers', input.customer.id), {
        totalDebt: newDebt,
        updatedAt: serverTimestamp(),
      });

      const recId = generateSafeId('rec');
      const recMeta = createTransactionMetadata('KBN', user);
      batch.set(doc(db, 'receivables', recId), {
        ...recMeta,
        customerId: input.customer.id,
        customerName: input.customer.name.slice(0, 100),
        type: 'debt',
        amount: settlement.debtAmount,
        balanceAfter: newDebt,
        saleId,
        ...(cashAccount && settlement.cashDepositAmount > 0 ? { accountId: cashAccount.id } : {}),
        notes: (
          settlement.paidAmount > 0
            ? `Kasbon Kasir ${meta.transactionNumber} (Total ${formatRupiah(
                totalAmount
              )}, DP ${formatRupiah(settlement.paidAmount)})`
            : `Kasbon Kasir ${meta.transactionNumber}`
        ).slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

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

          const uniqueAccIds = new Set<string>();
          if (cashAccount && settlement.cashDepositAmount > 0) uniqueAccIds.add(cashAccount.id);
          if (qrisTargetAccount && settlement.qrisNetDepositAmount > 0) {
            uniqueAccIds.add(qrisTargetAccount.id);
          }
          const accIdList = Array.from(uniqueAccIds);
          const accSnaps = await Promise.all(
            accIdList.map((id) => tx.get(doc(db, 'accounts', id)))
          );

          const custSnap =
            isDebtSale && input.customer
              ? await tx.get(doc(db, 'customers', input.customer.id))
              : null;

          // Validate live stock
          const runningStockMap = new Map<string, number>();
          productEntries.forEach(({ product, totalBaseQty }, idx) => {
            const pSnap = productSnaps[idx];
            if (!pSnap.exists()) {
              throw new Error(`Produk "${product.name}" tidak ditemukan atau telah dihapus oleh Admin.`);
            }
            const liveProdData = pSnap.data() as Product;
            const liveStock = snapStockToProductPrecision(
              Number(liveProdData.stock) || 0,
              liveProdData
            );
            if (!isStockSufficientWithTolerance(liveStock, totalBaseQty, liveProdData)) {
              throw new Error(
                `Stok "${product.name}" tidak mencukupi (tersedia ${formatQty(liveStock)} ${product.unit}, butuh ${formatQty(totalBaseQty)} ${product.unit}).`
              );
            }
            runningStockMap.set(product.id, liveStock);
          });

          const liveAccMap = new Map<string, Account>();
          accIdList.forEach((id, idx) => {
            const snap = accSnaps[idx];
            if (!snap.exists()) {
              throw new Error('Akun kas/rekening yang dipilih tidak ditemukan.');
            }
            liveAccMap.set(id, { id, ...(snap.data() as Omit<Account, 'id'>) });
          });

          // Execute atomic writes
          tx.set(doc(db, 'sales', saleId), buildSaleDocPayload());

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
            tx.update(doc(db, 'products', productId), {
              stock: finalStock,
              updatedAt: serverTimestamp(),
            });
          }

          applyAccountDeposits(
            tx,
            cashAccount ? liveAccMap.get(cashAccount.id) || null : null,
            qrisTargetAccount ? liveAccMap.get(qrisTargetAccount.id) || null : null
          );

          if (isDebtSale && input.customer && settlement.debtAmount > 0) {
            const livePrevDebt =
              custSnap && custSnap.exists()
                ? roundMoney(Math.max(0, Number((custSnap.data() as Customer).totalDebt) || 0))
                : roundMoney(Math.max(0, Number(input.customer.totalDebt) || 0));
            const newDebt = roundMoney(livePrevDebt + settlement.debtAmount);
            tx.update(doc(db, 'customers', input.customer.id), {
              totalDebt: newDebt,
              updatedAt: serverTimestamp(),
            });

            const recId = generateSafeId('rec');
            const recMeta = createTransactionMetadata('KBN', user);
            tx.set(doc(db, 'receivables', recId), {
              ...recMeta,
              customerId: input.customer.id,
              customerName: input.customer.name.slice(0, 100),
              type: 'debt',
              amount: settlement.debtAmount,
              balanceAfter: newDebt,
              saleId,
              ...(cashAccount && settlement.cashDepositAmount > 0
                ? { accountId: cashAccount.id }
                : {}),
              notes: (
                settlement.paidAmount > 0
                  ? `Kasbon Kasir ${meta.transactionNumber} (Total ${formatRupiah(
                      totalAmount
                    )}, DP ${formatRupiah(settlement.paidAmount)})`
                  : `Kasbon Kasir ${meta.transactionNumber}`
              ).slice(0, 240),
              createdAt: serverTimestamp(),
            });
          }
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
      saleId,
      transactionNumber: meta.transactionNumber,
      transactionDate: meta.transactionDate,
      transactionTime: meta.transactionTime,
      recordedByName: meta.recordedByName,
      ...(input.customer ? { customerId: input.customer.id } : {}),
      ...(effectiveCustomerName ? { customerName: effectiveCustomerName } : {}),
      ...(input.customer?.phone ? { customerPhone: input.customer.phone } : {}),
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
      paidAmount: settlement.paidAmount,
      changeAmount: settlement.changeAmount,
      debtAmount: settlement.debtAmount,
      paymentMethod: input.paymentMethod,
      cashPaidPart: settlement.cashPaidPart,
      qrisAmount: settlement.qrisAmount,
      qrisFeeRate: settlement.qrisFeeRate,
      qrisFeeAmount: settlement.qrisFeeAmount,
      netReceivedAmount: settlement.netReceivedAmount,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `sales/${saleId}`);
  }
}

export function subscribeRecentSales(
  _isAdmin: boolean,
  _userUid: string,
  onData: (sales: Sale[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'sales'), orderBy('createdAt', 'desc'), limit(30));

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
    const q = query(itemsRef);
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

