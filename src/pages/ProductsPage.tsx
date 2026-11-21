import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  ScanBarcode,
  Camera,
  Image as ImageIcon,
  Pencil,
  Trash2,
  SlidersHorizontal,
  Download,
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  Package,
  X,
  Check,
  ArrowUpDown,
  History,
  Layers,
  Calendar,
  Bell,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type {
  Category,
  PriceHistory,
  Product,
  ProductSellUnit,
  StockBatch,
  StockMovement,
} from '../types/database';
import {
  adjustProductStock,
  computeBaseQuantityFromUnit,
  computeSubUnitConversion,
  createCategory,
  createProductWithInitialStock,
  deleteProduct,
  DuplicateProductError,
  formatProductStockSummary,
  formatUnitConversionLabel,
  generateNextSku,
  getProductAllUnitOptions,
  getUsedUnitNamesForProduct,
  importProductsBatch,
  roundMoney,
  roundQty,
  snapStockToProductPrecision,
  subscribePriceHistory,
  subscribeStockMovements,
  UNIT_PRESETS,
  UNIVERSAL_UNIT_TEMPLATES,
  updateProductDetails,
  type UniversalUnitTemplate,
} from '../services/inventoryService';
import { updateBatchActualExpiry } from '../services/batchService';
import { formatQty, formatRupiah, getTodayDateString } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import { compressImageFile } from '../utils/imageHelper';
import {
  downloadProductImportTemplate,
  exportProductsToExcel,
  parseProductsExcelFile,
  type ImportedProductRow,
} from '../utils/excelProducts';
import {
  calculateDaysRemaining,
  collectExpiryAlerts,
  computeEstimatedExpiryDate,
  EXPIRY_ESTIMATE_DISCLAIMER,
  formatDaysRemainingLabel,
  formatShortIdDate,
  getEffectiveExpiryDate,
  getExpiryStatus,
  resolveProductExpiryDates,
  summarizeProductBatches,
  type ProductBatchSummary,
} from '../utils/expiryUtils';
import {
  checkDuplicateProduct,
  DUPLICATE_PRODUCT_WARNING,
  formatProductFullName,
} from '../utils/productIdentity';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { CameraCaptureModal } from '../components/CameraCaptureModal';

interface ProductsPageProps {
  products: Product[];
  categories: Category[];
  stockBatches?: StockBatch[];
  loading: boolean;
  hasPendingWrites: boolean;
  storeName: string;
}

type SubTab = 'catalog' | 'movements' | 'prices' | 'categories';

interface SellUnitDraft {
  id: string;
  unitPreset: string;
  customUnitName: string;
  conversionMode: 'multiply' | 'divide';
  conversion: string;
  perBaseQty: string;
  buyPrice: string;
  sellPrice: string;
  wholesalePrice: string;
  wholesaleMinQty: string;
  canBuy: boolean;
  canSell: boolean;
  originalUnitName?: string;
}

function makeEmptySellUnitDraft(defaultPreset = 'DUS'): SellUnitDraft {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    unitPreset: defaultPreset,
    customUnitName: '',
    conversionMode: 'multiply',
    conversion: '10',
    perBaseQty: '20',
    buyPrice: '',
    sellPrice: '0',
    wholesalePrice: '',
    wholesaleMinQty: '',
    canBuy: true,
    canSell: true,
  };
}

export function ProductsPage({
  products,
  categories,
  stockBatches = [],
  loading,
  hasPendingWrites,
  storeName,
}: ProductsPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [subTab, setSubTab] = useState<SubTab>('catalog');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [onlyLowStock, setOnlyLowStock] = useState(false);
  const [onlyExpiryAlert, setOnlyExpiryAlert] = useState(false);

  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);

  const [priceHistory, setPriceHistory] = useState<PriceHistory[]>([]);
  const [priceHistoryLoading, setPriceHistoryLoading] = useState(false);

  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Modal Tambah/Edit Produk
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [variant, setVariant] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [unit, setUnit] = useState('PCS');
  const [customUnit, setCustomUnit] = useState('');
  const [baseCanBuy, setBaseCanBuy] = useState(true);
  const [baseCanSell, setBaseCanSell] = useState(true);
  const [costPrice, setCostPrice] = useState('0');
  const [sellPrice, setSellPrice] = useState('0');
  const [wholesalePrice, setWholesalePrice] = useState('');
  const [wholesaleMinQty, setWholesaleMinQty] = useState('');
  const [sellUnitDrafts, setSellUnitDrafts] = useState<SellUnitDraft[]>([]);
  const [usedUnitNames, setUsedUnitNames] = useState<Set<string>>(new Set());
  const [loadingUsedUnits, setLoadingUsedUnits] = useState(false);
  const [stock, setStock] = useState('0');
  const [minStock, setMinStock] = useState('5');
  const [initialExpiryStartDate, setInitialExpiryStartDate] = useState(getTodayDateString());
  const [initialActualExpiryDate, setInitialActualExpiryDate] = useState('');
  const [duplicateConflict, setDuplicateConflict] = useState<{
    message: string;
    existingProduct?: Product;
  } | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [savingProduct, setSavingProduct] = useState(false);

  // Kamera & Scanner
  const [scannerTarget, setScannerTarget] = useState<'search' | 'form' | null>(null);
  const [showCameraModal, setShowCameraModal] = useState(false);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const mobileCameraInputRef = useRef<HTMLInputElement | null>(null);

  // Modal Penyesuaian Stok
  const [adjustTarget, setAdjustTarget] = useState<Product | null>(null);
  const [adjustMode, setAdjustMode] = useState<'in' | 'out' | 'adjustment'>('in');
  const [adjustUnitName, setAdjustUnitName] = useState('PCS');
  const [adjustQty, setAdjustQty] = useState('1');
  const [adjustNotes, setAdjustNotes] = useState('');
  const [adjustStartDate, setAdjustStartDate] = useState(getTodayDateString());
  const [adjustActualExpiryDate, setAdjustActualExpiryDate] = useState('');
  const [adjustTargetBatchId, setAdjustTargetBatchId] = useState('');
  const [savingAdjust, setSavingAdjust] = useState(false);

  // Modal Detail Batch & Kedaluwarsa Produk
  const [batchDetailProduct, setBatchDetailProduct] = useState<Product | null>(null);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [editingBatchDate, setEditingBatchDate] = useState('');
  const [savingBatchDate, setSavingBatchDate] = useState(false);

  // Konfirmasi Hapus
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Modal Import Excel
  const excelInputRef = useRef<HTMLInputElement | null>(null);
  const [importPreview, setImportPreview] = useState<{
    rows: ImportedProductRow[];
    errors: string[];
  } | null>(null);
  const [importingExcel, setImportingExcel] = useState(false);

  // Form Kategori Baru
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);

  useEffect(() => {
    if (!user || !isAdmin || subTab !== 'movements') return;
    setMovementsLoading(true);
    const unsub = subscribeStockMovements(
      isAdmin,
      user.uid,
      (list) => {
        setMovements(list);
        setMovementsLoading(false);
      },
      (err) => {
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
        setMovementsLoading(false);
      }
    );
    return () => unsub();
  }, [user, isAdmin, subTab]);

  useEffect(() => {
    if (!user || !isAdmin || subTab !== 'prices') return;
    setPriceHistoryLoading(true);
    const unsub = subscribePriceHistory(
      isAdmin,
      user.uid,
      (list) => {
        setPriceHistory(list);
        setPriceHistoryLoading(false);
      },
      (err) => {
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
        setPriceHistoryLoading(false);
      }
    );
    return () => unsub();
  }, [user, isAdmin, subTab]);

  const activeUserMeta = {
    uid: user?.uid || '',
    displayName: profile?.displayName || user?.displayName || 'Petugas',
  };

  const openAddProduct = () => {
    setEditingProduct(null);
    setSku(generateNextSku(products));
    setBarcode('');
    setName('');
    setBrand('');
    setVariant('');
    setCategoryId(categories[0]?.id || '');
    setUnit('PCS');
    setCustomUnit('');
    setBaseCanBuy(true);
    setBaseCanSell(true);
    setCostPrice('0');
    setSellPrice('0');
    setWholesalePrice('');
    setWholesaleMinQty('');
    setSellUnitDrafts([]);
    setUsedUnitNames(new Set());
    setLoadingUsedUnits(false);
    setStock('0');
    setMinStock('5');
    setInitialExpiryStartDate(getTodayDateString());
    setInitialActualExpiryDate('');
    setDuplicateConflict(null);
    setIsActive(true);
    setPhotoDataUrl('');
    setFeedback(null);
    setShowProductModal(true);
  };

  const openEditProduct = (p: Product) => {
    setEditingProduct(p);
    setSku(p.sku);
    setBarcode(p.barcode || '');
    setName(p.name);
    setBrand(p.brand || '');
    setVariant(p.variant || '');
    setCategoryId(p.categoryId);
    setDuplicateConflict(null);

    const matchedPreset = UNIT_PRESETS.find((u) => u.toUpperCase() === p.unit.trim().toUpperCase());
    if (matchedPreset) {
      setUnit(matchedPreset);
      setCustomUnit('');
    } else {
      setUnit('__custom__');
      setCustomUnit(p.unit);
    }

    setBaseCanBuy(p.baseCanBuy !== false);
    setBaseCanSell(p.baseCanSell !== false);
    setCostPrice(String(p.costPrice));
    setSellPrice(String(p.sellPrice));
    setWholesalePrice(p.wholesalePrice !== undefined ? String(p.wholesalePrice) : '');
    setWholesaleMinQty(p.wholesaleMinQty !== undefined ? String(p.wholesaleMinQty) : '');
    setSellUnitDrafts(
      (p.sellUnits || []).map((su, idx) => {
        const presetMatch = UNIT_PRESETS.find(
          (u) => u.toUpperCase() === su.unitName.trim().toUpperCase()
        );
        const inferredInverse =
          su.conversion > 0 && su.conversion < 1
            ? Math.round(1 / su.conversion)
            : 0;
        const isDivide =
          su.conversionMode === 'divide' ||
          (inferredInverse > 1 && Math.abs(1 / inferredInverse - su.conversion) < 0.001);
        const perBase = su.perBaseQty
          ? String(su.perBaseQty)
          : isDivide && inferredInverse > 1
            ? String(inferredInverse)
            : '20';
        return {
          id: `${p.id}_u_${idx}`,
          unitPreset: presetMatch || '__custom__',
          customUnitName: presetMatch ? '' : su.unitName,
          conversionMode: isDivide ? 'divide' : 'multiply',
          conversion: String(su.conversion),
          perBaseQty: perBase,
          buyPrice: su.buyPrice !== undefined ? String(su.buyPrice) : '',
          sellPrice: String(su.sellPrice),
          wholesalePrice: su.wholesalePrice !== undefined ? String(su.wholesalePrice) : '',
          wholesaleMinQty: su.wholesaleMinQty !== undefined ? String(su.wholesaleMinQty) : '',
          canBuy: su.canBuy !== false,
          canSell: su.canSell !== false,
          originalUnitName: su.unitName,
        };
      })
    );
    setStock(String(p.stock));
    setMinStock(String(p.minStock));
    const resolvedExp = resolveProductExpiryDates(p);
    setInitialExpiryStartDate(resolvedExp.inputDate);
    setInitialActualExpiryDate(resolvedExp.isCustomExpiry ? resolvedExp.effectiveExpiryDate : '');
    setIsActive(p.isActive);
    setPhotoDataUrl(p.photoDataUrl || '');
    setFeedback(null);
    setUsedUnitNames(new Set());
    setLoadingUsedUnits(true);
    void getUsedUnitNamesForProduct(p.id).then((used) => {
      setUsedUnitNames(used);
      setLoadingUsedUnits(false);
    });
    setShowProductModal(true);
  };

  const handleImageSelected = async (file: File | undefined) => {
    if (!file) return;
    try {
      const compressed = await compressImageFile(file);
      setPhotoDataUrl(compressed);
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Gagal memproses foto produk.',
      });
    }
  };

  const addSellUnitRow = () => {
    if (sellUnitDrafts.length >= 15) {
      setFeedback({ kind: 'err', text: 'Maksimal 15 satuan penjualan tambahan per produk.' });
      return;
    }
    const baseUpper = (unit === '__custom__' ? customUnit : unit).trim().toUpperCase();
    const usedNames = new Set([
      baseUpper,
      ...sellUnitDrafts.map((d) =>
        (d.unitPreset === '__custom__' ? d.customUnitName : d.unitPreset).trim().toUpperCase()
      ),
    ]);
    const nextPreset = UNIT_PRESETS.find((u) => !usedNames.has(u)) || '__custom__';
    setSellUnitDrafts((prev) => [...prev, makeEmptySellUnitDraft(nextPreset)]);
  };

  const applyUnitTemplate = (tpl: UniversalUnitTemplate) => {
    const baseLocked = Boolean(
      editingProduct && usedUnitNames.has(editingProduct.unit.trim().toUpperCase())
    );
    if (
      baseLocked &&
      editingProduct &&
      tpl.baseUnit.trim().toUpperCase() !== editingProduct.unit.trim().toUpperCase()
    ) {
      setFeedback({
        kind: 'err',
        text: `Satuan dasar "${editingProduct.unit}" sudah dipakai dalam transaksi, sehingga tidak dapat diganti ke "${tpl.baseUnit}". Tambahkan atau atur satuan tambahan saja.`,
      });
      return;
    }

    const matchedBase = UNIT_PRESETS.find((u) => u.toUpperCase() === tpl.baseUnit.toUpperCase());
    if (matchedBase) {
      setUnit(matchedBase);
      setCustomUnit('');
    } else {
      setUnit('__custom__');
      setCustomUnit(tpl.baseUnit);
    }
    setBaseCanBuy(true);
    setBaseCanSell(true);

    const lockedExisting = editingProduct
      ? sellUnitDrafts.filter(
          (d) =>
            d.originalUnitName && usedUnitNames.has(d.originalUnitName.trim().toUpperCase())
        )
      : [];
    const lockedNames = new Set(
      lockedExisting.map((d) =>
        (d.unitPreset === '__custom__' ? d.customUnitName : d.unitPreset).trim().toUpperCase()
      )
    );

    const templateDrafts: SellUnitDraft[] = tpl.sellUnits
      .filter((su) => !lockedNames.has(su.unitName.trim().toUpperCase()))
      .map((su, idx) => {
        const matched = UNIT_PRESETS.find((u) => u.toUpperCase() === su.unitName.toUpperCase());
        const isDivide = su.conversionMode === 'divide';
        const perBase = su.perBaseQty
          ? String(su.perBaseQty)
          : isDivide && su.conversion > 0
            ? String(Math.round(1 / su.conversion))
            : '20';
        return {
          id: `tpl_${tpl.id}_${Date.now()}_${idx}`,
          unitPreset: matched || '__custom__',
          customUnitName: matched ? '' : su.unitName,
          conversionMode: isDivide ? 'divide' : 'multiply',
          conversion: String(su.conversion),
          perBaseQty: perBase,
          buyPrice: '',
          sellPrice: '0',
          wholesalePrice: '',
          wholesaleMinQty: '',
          canBuy: su.canBuy !== false,
          canSell: su.canSell !== false,
        };
      });

    setSellUnitDrafts([...lockedExisting, ...templateDrafts]);
  };

  const updateSellUnitRow = (id: string, patch: Partial<SellUnitDraft>) => {
    setSellUnitDrafts((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeSellUnitRow = (id: string) => {
    const target = sellUnitDrafts.find((r) => r.id === id);
    if (
      editingProduct &&
      target?.originalUnitName &&
      usedUnitNames.has(target.originalUnitName.trim().toUpperCase())
    ) {
      setFeedback({
        kind: 'err',
        text: `Satuan "${target.originalUnitName}" sudah dipakai dalam transaksi sehingga tidak bisa dihapus. Nonaktifkan centang Pembelian/Kasir jika ingin menyembunyikannya.`,
      });
      return;
    }
    setSellUnitDrafts((prev) => prev.filter((row) => row.id !== id));
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin) return;
    if (!name.trim() || !sku.trim()) {
      setFeedback({ kind: 'err', text: 'Kode barang dan nama barang wajib diisi.' });
      return;
    }

    const cat = categories.find((c) => c.id === categoryId) || categories[0];
    if (!cat) {
      setFeedback({ kind: 'err', text: 'Kategori produk belum tersedia.' });
      return;
    }

    const finalUnit = (unit === '__custom__' ? customUnit.trim() : unit).trim() || 'PCS';
    if (
      editingProduct &&
      usedUnitNames.has(editingProduct.unit.trim().toUpperCase()) &&
      finalUnit.toUpperCase() !== editingProduct.unit.trim().toUpperCase()
    ) {
      setFeedback({
        kind: 'err',
        text: `Satuan dasar "${editingProduct.unit}" sudah dipakai dalam transaksi dan tidak dapat diubah namanya.`,
      });
      return;
    }

    const numCost = Math.max(0, Number(costPrice) || 0);
    const numSell = Math.max(0, Number(sellPrice) || 0);
    const numWholesale =
      wholesalePrice.trim() !== '' ? Math.max(0, Number(wholesalePrice) || 0) : undefined;
    const numWholesaleMin =
      wholesaleMinQty.trim() !== '' && Number(wholesaleMinQty) > 0
        ? roundQty(Number(wholesaleMinQty))
        : undefined;
    const numStock = Number(stock) || 0;
    const numMinStock = Math.max(0, Number(minStock) || 0);

    if (!editingProduct && numStock < 0) {
      setFeedback({ kind: 'err', text: 'Stok awal produk tidak boleh negatif.' });
      return;
    }

    // Validasi satuan tambahan universal
    const parsedSellUnits: ProductSellUnit[] = [];
    const seenUnitNames = new Set<string>([finalUnit.toUpperCase()]);
    for (const draft of sellUnitDrafts) {
      const uName = (
        draft.unitPreset === '__custom__' ? draft.customUnitName : draft.unitPreset
      ).trim();
      if (!uName) {
        setFeedback({ kind: 'err', text: 'Nama satuan tambahan tidak boleh kosong.' });
        return;
      }
      if (seenUnitNames.has(uName.toUpperCase())) {
        setFeedback({
          kind: 'err',
          text: `Satuan "${uName}" duplikat atau sama dengan satuan dasar "${finalUnit}".`,
        });
        return;
      }

      const isDivide = draft.conversionMode === 'divide';
      let conv = 0;
      let perBase: number | undefined;
      if (isDivide) {
        const pb = Number(draft.perBaseQty);
        if (!Number.isFinite(pb) || pb <= 0 || pb > 10000000) {
          setFeedback({
            kind: 'err',
            text: `Isi per 1 ${finalUnit} untuk satuan "${uName}" harus lebih dari 0 dan maksimal 10.000.000.`,
          });
          return;
        }
        perBase = roundQty(pb);
        conv = computeSubUnitConversion(perBase);
      } else {
        conv = Number(draft.conversion);
      }

      if (!Number.isFinite(conv) || conv <= 0 || conv > 10000000) {
        setFeedback({
          kind: 'err',
          text: `Konversi untuk satuan "${uName}" harus lebih dari 0 dan maksimal 10.000.000.`,
        });
        return;
      }
      seenUnitNames.add(uName.toUpperCase());

      const uBuy =
        draft.buyPrice.trim() !== ''
          ? roundMoney(Math.max(0, Number(draft.buyPrice) || 0))
          : undefined;
      const uSell = roundMoney(Math.max(0, Number(draft.sellPrice) || 0));
      const uWholesale =
        draft.wholesalePrice.trim() !== ''
          ? roundMoney(Math.max(0, Number(draft.wholesalePrice) || 0))
          : undefined;
      const uMinQty =
        draft.wholesaleMinQty.trim() !== '' && Number(draft.wholesaleMinQty) > 0
          ? roundQty(Number(draft.wholesaleMinQty))
          : undefined;

      parsedSellUnits.push({
        unitName: uName.slice(0, 24),
        conversion: roundQty(conv),
        ...(uBuy !== undefined ? { buyPrice: uBuy } : {}),
        sellPrice: uSell,
        ...(uWholesale !== undefined ? { wholesalePrice: uWholesale } : {}),
        ...(uMinQty !== undefined ? { wholesaleMinQty: uMinQty } : {}),
        ...(draft.canBuy === false ? { canBuy: false } : {}),
        ...(draft.canSell === false ? { canSell: false } : {}),
        ...(isDivide && perBase ? { conversionMode: 'divide' as const, perBaseQty: perBase } : {}),
      });
    }

    if (!baseCanSell && !parsedSellUnits.some((u) => u.canSell !== false)) {
      setFeedback({
        kind: 'err',
        text: 'Minimal 1 satuan (dasar atau tambahan) harus aktif untuk Penjualan / Kasir.',
      });
      return;
    }

    if (!baseCanBuy && !parsedSellUnits.some((u) => u.canBuy !== false)) {
      setFeedback({
        kind: 'err',
        text: 'Minimal 1 satuan (dasar atau tambahan) harus aktif untuk Pembelian.',
      });
      return;
    }

    // Validasi pencegahan produk ganda di level UI sebelum menyimpan
    const dupCheck = checkDuplicateProduct(
      {
        name,
        brand,
        variant,
        barcode,
      },
      products,
      editingProduct?.id
    );
    if (dupCheck.isDuplicate) {
      setDuplicateConflict({
        message: DUPLICATE_PRODUCT_WARNING,
        existingProduct: dupCheck.existingProduct,
      });
      setFeedback({ kind: 'err', text: DUPLICATE_PRODUCT_WARNING });
      return;
    }

    setDuplicateConflict(null);
    setSavingProduct(true);
    setFeedback(null);

    try {
      if (editingProduct) {
        const initialBatchToSync =
          stockBatches.find(
            (b) =>
              b.productId === editingProduct.id &&
              b.sourceType === 'initial_product' &&
              b.status === 'active'
          ) || null;
        await updateProductDetails(
          editingProduct,
          {
            sku,
            barcode,
            name,
            brand,
            variant,
            photoDataUrl,
            categoryId: cat.id,
            categoryName: cat.name,
            unit: finalUnit,
            baseCanBuy,
            baseCanSell,
            costPrice: numCost,
            sellPrice: numSell,
            wholesalePrice: numWholesale,
            wholesaleMinQty: numWholesaleMin,
            sellUnits: parsedSellUnits,
            minStock: numMinStock,
            inputDate: initialExpiryStartDate,
            expiryDate: initialActualExpiryDate || undefined,
            initialExpiryStartDate,
            initialActualExpiryDate: initialActualExpiryDate || undefined,
            isActive,
          },
          activeUserMeta,
          products,
          initialBatchToSync
        );
        setFeedback({
          kind: 'ok',
          text: isOnline
            ? `Produk "${name}" berhasil diperbarui (riwayat harga & masa kedaluwarsa tersimpan).`
            : `Perubahan "${name}" disimpan lokal (offline) dan akan tersinkron otomatis.`,
        });
      } else {
        await createProductWithInitialStock(
          {
            sku,
            barcode,
            name,
            brand,
            variant,
            photoDataUrl,
            categoryId: cat.id,
            categoryName: cat.name,
            unit: finalUnit,
            baseCanBuy,
            baseCanSell,
            costPrice: numCost,
            sellPrice: numSell,
            wholesalePrice: numWholesale,
            wholesaleMinQty: numWholesaleMin,
            sellUnits: parsedSellUnits,
            stock: numStock,
            minStock: numMinStock,
            initialExpiryStartDate,
            initialActualExpiryDate: initialActualExpiryDate || undefined,
            isActive,
          },
          activeUserMeta,
          products
        );
        setFeedback({
          kind: 'ok',
          text: isOnline
            ? `Produk "${name}" berhasil ditambahkan ke Cloud Firestore.`
            : `Produk "${name}" disimpan lokal (offline) dan akan tersinkron otomatis.`,
        });
      }
      setShowProductModal(false);
    } catch (error) {
      if (error instanceof DuplicateProductError) {
        setDuplicateConflict({
          message: error.message || DUPLICATE_PRODUCT_WARNING,
          existingProduct: error.existingProduct,
        });
        setFeedback({ kind: 'err', text: error.message || DUPLICATE_PRODUCT_WARNING });
      } else {
        setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
      }
    } finally {
      setSavingProduct(false);
    }
  };

  const handleDeleteProduct = async (id: string, productName: string) => {
    if (!isAdmin) return;
    try {
      const targetProd = products.find((p) => p.id === id);
      await deleteProduct(id, targetProd);
      setConfirmDeleteId(null);
      setFeedback({ kind: 'ok', text: `Produk "${productName}" dihapus.` });
    } catch (error) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
    }
  };

  const openAdjustModal = (p: Product) => {
    setAdjustTarget(p);
    setAdjustMode('in');
    setAdjustUnitName(p.unit || 'PCS');
    setAdjustQty('1');
    setAdjustNotes('');
    setAdjustStartDate(getTodayDateString());
    setAdjustActualExpiryDate('');
    setAdjustTargetBatchId('');
  };

  const openBatchDetailModal = (p: Product) => {
    setBatchDetailProduct(p);
    setEditingBatchId(null);
    setEditingBatchDate('');
  };

  const handleSaveBatchActualExpiry = async (batch: StockBatch) => {
    if (!isAdmin) return;
    setSavingBatchDate(true);
    try {
      await updateBatchActualExpiry(batch, editingBatchDate.trim() || null);
      setEditingBatchId(null);
      setEditingBatchDate('');
      setFeedback({
        kind: 'ok',
        text: editingBatchDate.trim()
          ? `Tanggal kedaluwarsa aktual kemasan batch ${batch.batchNumber} disimpan (${editingBatchDate.trim()}).`
          : `Tanggal kedaluwarsa batch ${batch.batchNumber} dikembalikan ke perkiraan +6 bulan.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSavingBatchDate(false);
    }
  };

  const adjustOptions = adjustTarget ? getProductAllUnitOptions(adjustTarget) : [];
  const activeAdjustUnit =
    adjustOptions.find((o) => o.unitName.toUpperCase() === adjustUnitName.toUpperCase()) ||
    adjustOptions[0];
  const adjustConvertedBaseQty = activeAdjustUnit
    ? computeBaseQuantityFromUnit(Number(adjustQty) || 0, activeAdjustUnit)
    : 0;
  const adjustPreviewAfter = (() => {
    if (!adjustTarget) return 0;
    if (adjustMode === 'in') {
      return snapStockToProductPrecision(adjustTarget.stock + adjustConvertedBaseQty, adjustTarget);
    }
    if (adjustMode === 'out') {
      return snapStockToProductPrecision(adjustTarget.stock - adjustConvertedBaseQty, adjustTarget);
    }
    return snapStockToProductPrecision(adjustConvertedBaseQty, adjustTarget);
  })();

  const handleSaveAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustTarget || !user || !isAdmin) return;

    const qty = Number(adjustQty);
    if (!Number.isFinite(qty) || qty < 0) {
      setFeedback({ kind: 'err', text: 'Jumlah stok harus berupa angka 0 atau lebih.' });
      return;
    }

    if (adjustPreviewAfter < 0) {
      setFeedback({
        kind: 'err',
        text: `Stok tidak boleh negatif (hasil akhir akan menjadi ${adjustPreviewAfter} ${adjustTarget.unit}).`,
      });
      return;
    }

    const selectedOutBatch =
      adjustMode === 'out' && adjustTargetBatchId
        ? stockBatches.find((b) => b.id === adjustTargetBatchId && b.productId === adjustTarget.id) || null
        : null;

    setSavingAdjust(true);
    try {
      await adjustProductStock(
        adjustTarget,
        adjustMode,
        qty,
        adjustNotes,
        activeUserMeta,
        activeAdjustUnit?.unitName,
        {
          startDate: adjustStartDate,
          actualExpiryDate: adjustActualExpiryDate || undefined,
          targetBatch: selectedOutBatch,
        }
      );
      const summaryAfter = formatProductStockSummary(adjustPreviewAfter, adjustTarget).primary;
      setFeedback({
        kind: 'ok',
        text: `Stok "${adjustTarget.name}" berhasil disesuaikan menjadi ${summaryAfter}.`,
      });
      setAdjustTarget(null);
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: error instanceof Error ? error.message : getReadableFirestoreError(error),
      });
    } finally {
      setSavingAdjust(false);
    }
  };

  const handleExcelFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setFeedback(null);
    try {
      const parsed = await parseProductsExcelFile(file, categories, products.length);
      setImportPreview({ rows: parsed.validRows, errors: parsed.errors });
    } catch {
      setFeedback({
        kind: 'err',
        text: 'File Excel gagal dibaca. Pastikan formatnya .xlsx, .xls, atau .csv.',
      });
    }
  };

  const handleConfirmExcelImport = async () => {
    if (!importPreview || importPreview.rows.length === 0 || !user || !isAdmin) return;
    setImportingExcel(true);
    try {
      const count = await importProductsBatch(importPreview.rows, activeUserMeta, products);
      setImportPreview(null);
      setFeedback({
        kind: 'ok',
        text: `${count} produk dari Excel berhasil diimpor dan tersimpan di Cloud Firestore.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text:
          error instanceof DuplicateProductError
            ? error.message
            : getReadableFirestoreError(error),
      });
    } finally {
      setImportingExcel(false);
    }
  };

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin || !newCatName.trim()) return;
    setSavingCategory(true);
    try {
      await createCategory(newCatName, newCatDesc, user.uid, categories);
      setNewCatName('');
      setNewCatDesc('');
      setFeedback({ kind: 'ok', text: 'Kategori baru berhasil ditambahkan.' });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text:
          error instanceof Error && error.name === 'CategoryValidationError'
            ? error.message
            : getReadableFirestoreError(error),
      });
    } finally {
      setSavingCategory(false);
    }
  };

  const handleBarcodeResult = (code: string) => {
    if (scannerTarget === 'form') {
      setBarcode(code);
    } else if (scannerTarget === 'search') {
      setSearchQuery(code);
    }
    setScannerTarget(null);
  };

  const lowStockProducts = products.filter((p) => p.isActive && p.stock <= p.minStock);
  const totalStockUnits = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
  const totalAssetCost = products.reduce(
    (sum, p) => sum + Math.max(0, Number(p.stock) || 0) * (Number(p.costPrice) || 0),
    0
  );

  const batchSummaryByProductId = React.useMemo(() => {
    const map = new Map<string, ProductBatchSummary>();
    products.forEach((p) => {
      map.set(p.id, summarizeProductBatches(p, stockBatches));
    });
    return map;
  }, [products, stockBatches]);

  const expiryAlerts = React.useMemo(
    () => collectExpiryAlerts(products, stockBatches),
    [products, stockBatches]
  );
  const alertProductIds = React.useMemo(
    () => new Set(expiryAlerts.map((a) => a.productId)),
    [expiryAlerts]
  );
  const expiredAlertCount = React.useMemo(
    () => expiryAlerts.filter((a) => a.expiryStatus === 'EXPIRED').length,
    [expiryAlerts]
  );
  const nearExpiryAlertCount = React.useMemo(
    () => expiryAlerts.filter((a) => a.expiryStatus === 'MENDEKATI EXPIRED').length,
    [expiryAlerts]
  );

  const liveDuplicateCheck = React.useMemo(() => {
    if (!showProductModal) return null;
    if (!name.trim() && !barcode.trim()) return null;
    return checkDuplicateProduct(
      { name, brand, variant, barcode },
      products,
      editingProduct?.id
    );
  }, [showProductModal, name, brand, variant, barcode, products, editingProduct?.id]);

  const activeDuplicateInfo = duplicateConflict || (liveDuplicateCheck?.isDuplicate
    ? {
        message: DUPLICATE_PRODUCT_WARNING,
        existingProduct: liveDuplicateCheck.existingProduct,
      }
    : null);

  const filteredProducts = products.filter((p) => {
    if (selectedCategoryId !== 'all' && p.categoryId !== selectedCategoryId) return false;
    if (onlyLowStock && p.stock > p.minStock) return false;
    if (onlyExpiryAlert && !alertProductIds.has(p.id)) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const hitName = p.name.toLowerCase().includes(q);
      const hitBrand = (p.brand || '').toLowerCase().includes(q);
      const hitVariant = (p.variant || '').toLowerCase().includes(q);
      const hitSku = p.sku.toLowerCase().includes(q);
      const hitBarcode = (p.barcode || '').toLowerCase().includes(q);
      if (!hitName && !hitBrand && !hitVariant && !hitSku && !hitBarcode) return false;
    }
    return true;
  });

  const baseUnitPreview = (unit === '__custom__' ? customUnit.trim() : unit).trim() || 'PCS';
  const formCostNum = Math.max(0, Number(costPrice) || 0);
  const formSellNum = Math.max(0, Number(sellPrice) || 0);
  const formRetailMargin = formSellNum - formCostNum;
  const formWholesaleNum = wholesalePrice.trim() !== '' ? Math.max(0, Number(wholesalePrice) || 0) : null;
  const formWholesaleMargin = formWholesaleNum !== null ? formWholesaleNum - formCostNum : null;
  const estimatedInitialExpiry = computeEstimatedExpiryDate(initialExpiryStartDate);
  const effectiveInitialExpiry = getEffectiveExpiryDate(
    estimatedInitialExpiry,
    initialActualExpiryDate || undefined
  );
  const initialExpiryStatus = getExpiryStatus(effectiveInitialExpiry);
  const initialDaysRemaining = calculateDaysRemaining(effectiveInitialExpiry);

  if (!isAdmin) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700 flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 shrink-0" />
        <span>
          Akses ditolak. Pengelolaan Produk, Harga, Barcode, Satuan, dan Penyesuaian Stok hanya
          dapat diakses oleh Admin.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* KPI Ringkasan Produk & Stok */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">Total Item Produk</div>
          <div className="font-mono-num text-2xl font-bold text-slate-900">
            {loading ? '...' : products.length}
          </div>
          <div className="text-xs text-slate-500">
            {categories.length} kategori tersedia
            {hasPendingWrites ? ' · Menyinkronkan' : ''}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">Total Stok Satuan Dasar</div>
          <div className="font-mono-num text-2xl font-bold text-slate-900">
            {loading ? '...' : formatQty(totalStockUnits)}
          </div>
          <div className="text-xs text-slate-500">Akumulasi stok di satuan dasar</div>
        </div>

        <button
          type="button"
          onClick={() => {
            setSubTab('catalog');
            setOnlyLowStock((prev) => !prev);
          }}
          className={`text-left bg-white border rounded-xl p-5 space-y-1.5 transition-colors cursor-pointer ${
            lowStockProducts.length > 0
              ? 'border-amber-300 bg-amber-50/40 hover:bg-amber-50'
              : 'border-slate-200 hover:bg-slate-50'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-600">
            <span>Peringatan Stok Menipis</span>
            <AlertTriangle
              className={`w-4 h-4 ${
                lowStockProducts.length > 0 ? 'text-amber-600' : 'text-slate-400'
              }`}
            />
          </div>
          <div
            className={`font-mono-num text-2xl font-bold ${
              lowStockProducts.length > 0 ? 'text-amber-700' : 'text-slate-900'
            }`}
          >
            {lowStockProducts.length}
          </div>
          <div className="text-xs text-slate-500">
            {onlyLowStock ? 'Filter aktif (klik untuk semua)' : 'Klik untuk filter stok menipis'}
          </div>
        </button>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-500">Nilai Persediaan (HPP)</div>
          <div className="font-mono-num text-2xl font-bold text-slate-900">
            {isAdmin ? formatRupiah(totalAssetCost) : 'Khusus Admin'}
          </div>
          <div className="text-xs text-slate-500">Modal stok satuan dasar</div>
        </div>
      </div>

      {/* Peringatan Stok Menipis */}
      {lowStockProducts.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-2.5 text-sm text-amber-900">
            <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <strong>{lowStockProducts.length} produk mencapai batas stok minimum:</strong>{' '}
              <span className="text-amber-800">
                {lowStockProducts
                  .slice(0, 4)
                  .map((p) => `${p.name} (${formatQty(p.stock)} ${p.unit})`)
                  .join(', ')}
                {lowStockProducts.length > 4 ? `, dan ${lowStockProducts.length - 4} lainnya` : ''}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSubTab('catalog');
              setOnlyLowStock(true);
            }}
            className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-white border border-amber-300 text-xs font-semibold text-amber-900 hover:bg-amber-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Lihat Stok Menipis
          </button>
        </div>
      )}

      {/* Peringatan Masa Expired (<= 1 Bulan / Sudah Expired) */}
      {expiryAlerts.length > 0 && (
        <div
          className={`rounded-xl p-4 border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
            expiredAlertCount > 0
              ? 'bg-red-50 border-red-200 text-red-900'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          <div className="flex items-start gap-2.5 text-sm">
            <Bell
              className={`w-5 h-5 shrink-0 mt-0.5 ${
                expiredAlertCount > 0 ? 'text-red-700' : 'text-amber-700'
              }`}
            />
            <div>
              <strong>
                Pemberitahuan Expired ({alertProductIds.size} produk):
              </strong>{' '}
              <span>
                {expiredAlertCount > 0 ? `${expiredAlertCount} sudah EXPIRED` : ''}
                {expiredAlertCount > 0 && nearExpiryAlertCount > 0 ? ' · ' : ''}
                {nearExpiryAlertCount > 0
                  ? `${nearExpiryAlertCount} mendekati expired (≤ 1 bulan / 30 hari)`
                  : ''}
                {' — '}
                {expiryAlerts
                  .slice(0, 3)
                  .map((a) => `${a.productName} (${formatShortIdDate(a.effectiveExpiryDate)})`)
                  .join(', ')}
                {expiryAlerts.length > 3 ? `, dan ${expiryAlerts.length - 3} lainnya` : ''}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSubTab('catalog');
              setOnlyExpiryAlert((prev) => !prev);
            }}
            className={`min-h-[38px] px-3.5 py-1.5 rounded-lg bg-white border text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
              expiredAlertCount > 0
                ? 'border-red-300 text-red-900 hover:bg-red-100'
                : 'border-amber-300 text-amber-900 hover:bg-amber-100'
            }`}
          >
            {onlyExpiryAlert ? 'Tampilkan Semua' : 'Filter Produk ED'}
          </button>
        </div>
      )}

      {feedback && (
        <div
          className={`p-4 rounded-xl border text-sm ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Sub-Navigasi Modul Produk & Stok + Aksi Excel */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg self-start">
          {(
            [
              { id: 'catalog', label: 'Daftar Produk' },
              { id: 'movements', label: 'Riwayat Stok' },
              { id: 'prices', label: 'Riwayat Harga' },
              { id: 'categories', label: 'Kategori' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`min-h-[38px] px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                subTab === t.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => exportProductsToExcel(filteredProducts, storeName)}
            disabled={products.length === 0}
            className="min-h-[42px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Export Excel</span>
          </button>

          {isAdmin && (
            <>
              <button
                type="button"
                onClick={() => downloadProductImportTemplate(categories)}
                className="min-h-[42px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>Template Excel</span>
              </button>

              <button
                type="button"
                onClick={() => excelInputRef.current?.click()}
                className="min-h-[42px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>Import Excel</span>
              </button>
              <input
                ref={excelInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  handleExcelFileSelected(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />

              <button
                type="button"
                onClick={openAddProduct}
                className="min-h-[42px] inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs sm:text-sm font-medium hover:bg-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Tambah Produk</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* TAB 1: DAFTAR PRODUK */}
      {subTab === 'catalog' && (
        <div className="space-y-4">
          {/* Toolbar Pencarian & Filter */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-5 flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari nama produk, kode barang, atau barcode..."
                  className="w-full min-h-[44px] pl-10 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <button
                type="button"
                onClick={() => setScannerTarget('search')}
                className="min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
                title="Scan barcode dengan kamera"
              >
                <ScanBarcode className="w-4 h-4 text-emerald-700" />
                <span className="hidden sm:inline">Scan</span>
              </button>
            </div>

            <div className="sm:col-span-3">
              <select
                value={selectedCategoryId}
                onChange={(e) => setSelectedCategoryId(e.target.value)}
                aria-label="Filter Kategori Produk"
                className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="all">Semua Kategori ({products.length})</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2 flex items-center">
              <button
                type="button"
                onClick={() => setOnlyLowStock((prev) => !prev)}
                className={`w-full min-h-[44px] px-3 py-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  onlyLowStock
                    ? 'bg-amber-100 border-amber-300 text-amber-900'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                Stok Menipis
              </button>
            </div>

            <div className="sm:col-span-2 flex items-center">
              <button
                type="button"
                onClick={() => setOnlyExpiryAlert((prev) => !prev)}
                className={`w-full min-h-[44px] px-3 py-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  onlyExpiryAlert
                    ? 'bg-red-100 border-red-300 text-red-900'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                ED ≤ 1 Bln ({alertProductIds.size})
              </button>
            </div>
          </div>

          {/* Tabel Desktop / Kartu Mobile */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {loading ? (
              <div className="p-5 space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="p-10 text-center space-y-3">
                <Package className="w-9 h-9 text-slate-400 mx-auto" />
                <div className="text-sm text-slate-600">
                  {products.length === 0
                    ? 'Belum ada produk di KEDAI KHANXA. Tambahkan produk pertama atau impor dari file Excel.'
                    : 'Tidak ada produk yang cocok dengan pencarian atau filter Anda.'}
                </div>
                {isAdmin && products.length === 0 && (
                  <button
                    type="button"
                    onClick={openAddProduct}
                    className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Tambah Produk Pertama</span>
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* Tabel Desktop */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Produk &amp; Satuan Jual</th>
                        <th className="py-3 px-4 whitespace-nowrap">Kode / Barcode</th>
                        <th className="py-3 px-4 whitespace-nowrap">Kategori</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Modal Dasar</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Ecer &amp; Grosir</th>
                        <th className="py-3 px-4 text-right whitespace-nowrap">Stok Dasar</th>
                        {isAdmin && <th className="py-3 px-4 text-right whitespace-nowrap">Aksi</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {filteredProducts.map((p) => {
                        const isOut = p.stock <= 0;
                        const isLow = p.stock > 0 && p.stock <= p.minStock;
                        const baseProfit = p.sellPrice - p.costPrice;
                        const extraUnits = p.sellUnits || [];
                        const stockSummary = formatProductStockSummary(p.stock, p);
                        const baseRoleNote =
                          p.baseCanBuy === false && p.baseCanSell === false
                            ? ' [Non-Jual/Beli]'
                            : p.baseCanBuy === false
                              ? ' [Khusus Jual]'
                              : p.baseCanSell === false
                                ? ' [Khusus Beli]'
                                : '';
                        const bSummary = batchSummaryByProductId.get(p.id);
                        const batchCount = bSummary?.allBatchesEvaluated.filter((b) => b.status === 'active' && b.remainingBaseQty > 0.0001).length || 0;
                        const prodExp = resolveProductExpiryDates(p);
                        const prodExpStatus = getExpiryStatus(prodExp.effectiveExpiryDate);
                        const prodDays = calculateDaysRemaining(prodExp.effectiveExpiryDate);
                        return (
                          <tr key={p.id} className="hover:bg-slate-50 align-top">
                            <td className="py-3 px-4">
                              <div className="flex items-start gap-3 min-w-[230px]">
                                {p.photoDataUrl ? (
                                  <img
                                    src={p.photoDataUrl}
                                    alt={p.name}
                                    referrerPolicy="no-referrer"
                                    className="w-10 h-10 rounded-lg object-cover border border-slate-200 shrink-0"
                                  />
                                ) : (
                                  <div className="w-10 h-10 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center shrink-0">
                                    <Package className="w-5 h-5" />
                                  </div>
                                )}
                                <div className="min-w-0 space-y-0.5">
                                  <div className="font-medium text-slate-900 truncate">
                                    {p.name}
                                    {!p.isActive && (
                                      <span className="ml-1.5 text-xs text-slate-400 font-normal">
                                        (Nonaktif)
                                      </span>
                                    )}
                                  </div>
                                  {(p.brand || p.variant) && (
                                    <div className="text-[11px] font-medium text-slate-600">
                                      {[p.brand, p.variant].filter(Boolean).join(' · ')}
                                    </div>
                                  )}
                                  {bSummary && (bSummary.hasExpiredStock || bSummary.hasNearExpiry || batchCount > 0) ? (
                                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                      {bSummary.hasExpiredStock && (
                                        <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-bold">
                                          EXPIRED ({formatQty(bSummary.expiredBatchStock)} {p.unit})
                                        </span>
                                      )}
                                      {bSummary.hasNearExpiry && (
                                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">
                                          MENDEKATI EXPIRED
                                        </span>
                                      )}
                                      {batchCount > 0 && bSummary.nearestNonExpired && (
                                        <span className="text-[10px] font-mono-num text-slate-500">
                                          {batchCount} batch · ED terdekat {formatShortIdDate(bSummary.nearestNonExpired.effectiveExpiryDate)}
                                        </span>
                                      )}
                                    </div>
                                  ) : prodExp.hasExplicitDates && (
                                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                      {prodExpStatus === 'EXPIRED' && (
                                        <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-bold">
                                          EXPIRED ({formatDaysRemainingLabel(prodDays)})
                                        </span>
                                      )}
                                      {prodExpStatus === 'MENDEKATI EXPIRED' && (
                                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">
                                          MENDEKATI EXPIRED · {formatDaysRemainingLabel(prodDays)}
                                        </span>
                                      )}
                                      <span className="text-[10px] font-mono-num text-slate-500">
                                        Input {formatShortIdDate(prodExp.inputDate)} · ED {formatShortIdDate(prodExp.effectiveExpiryDate)}
                                      </span>
                                    </div>
                                  )}
                                  <div className="text-xs text-slate-500">
                                    Dasar: <span className="font-semibold text-slate-700">{p.unit}</span>
                                    {baseRoleNote && (
                                      <span className="text-[11px] text-amber-700">{baseRoleNote}</span>
                                    )}
                                    {extraUnits.length > 0 && (
                                      <span className="font-mono-num">
                                        {' '}
                                        ·{' '}
                                        {extraUnits
                                          .map((u) => {
                                            const convLbl = formatUnitConversionLabel(
                                              {
                                                unitName: u.unitName,
                                                conversion: u.conversion,
                                                conversionMode:
                                                  u.conversionMode === 'divide'
                                                    ? 'divide'
                                                    : 'multiply',
                                                perBaseQty: u.perBaseQty,
                                                isBase: false,
                                              },
                                              p.unit
                                            );
                                            const flags = `${u.canBuy !== false ? 'B' : ''}${
                                              u.canSell !== false ? 'J' : ''
                                            }`;
                                            return `${u.unitName} (${convLbl} = ${formatRupiah(
                                              u.sellPrice
                                            )}${flags ? ` [${flags}]` : ''})`;
                                          })
                                          .join(' · ')}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                              <div className="font-semibold text-slate-800">{p.sku}</div>
                              {p.barcode && <div className="text-slate-500">{p.barcode}</div>}
                            </td>
                            <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                              {p.categoryName}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-num text-slate-600 whitespace-nowrap">
                              <div>{formatRupiah(p.costPrice)}</div>
                              <div className="text-[11px] text-slate-400">per {p.unit}</div>
                            </td>
                            <td className="py-3 px-4 text-right font-mono-num whitespace-nowrap">
                              <div className="font-semibold text-slate-900">
                                {formatRupiah(p.sellPrice)}/{p.unit}
                              </div>
                              <div className="text-[11px] text-emerald-700">
                                Laba +{formatRupiah(baseProfit)}
                              </div>
                              {p.wholesalePrice !== undefined && p.wholesalePrice > 0 && (
                                <div className="text-[11px] text-slate-500">
                                  Grosir {formatRupiah(p.wholesalePrice)}
                                  {p.wholesaleMinQty ? ` (min ${formatQty(p.wholesaleMinQty)})` : ''}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <div
                                className={`font-mono-num font-semibold ${
                                  isOut
                                    ? 'text-red-700'
                                    : isLow
                                      ? 'text-amber-700'
                                      : 'text-slate-900'
                                }`}
                              >
                                {stockSummary.primary}
                              </div>
                              {stockSummary.secondary && (
                                <div className="text-[11px] font-mono-num text-slate-500">
                                  {stockSummary.secondary}
                                </div>
                              )}
                              <div className="text-[11px] text-slate-500">
                                {isOut
                                  ? 'Stok Habis'
                                  : isLow
                                    ? `Menipis (min ${formatQty(p.minStock)})`
                                    : `Min ${formatQty(p.minStock)}`}
                              </div>
                            </td>
                            {isAdmin && (
                              <td className="py-3 px-4 text-right whitespace-nowrap">
                                {confirmDeleteId === p.id ? (
                                  <span className="inline-flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteProduct(p.id, p.name)}
                                      className="text-xs font-semibold text-red-700 hover:underline cursor-pointer"
                                    >
                                      Ya, Hapus
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteId(null)}
                                      className="text-xs text-slate-500 hover:underline cursor-pointer"
                                    >
                                      Batal
                                    </button>
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => openBatchDetailModal(p)}
                                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1 cursor-pointer"
                                      title="Lihat & Kelola Batch Kedaluwarsa"
                                    >
                                      <Calendar className="w-3.5 h-3.5 text-emerald-700" />
                                      <span>Batch{batchCount > 0 ? ` (${batchCount})` : ''}</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openAdjustModal(p)}
                                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1 cursor-pointer"
                                      title="Sesuaikan Stok"
                                    >
                                      <SlidersHorizontal className="w-3.5 h-3.5" />
                                      <span>Stok</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openEditProduct(p)}
                                      className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                                      aria-label={`Ubah ${p.name}`}
                                    >
                                      <Pencil className="w-4 h-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteId(p.id)}
                                      className="p-2 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 cursor-pointer"
                                      aria-label={`Hapus ${p.name}`}
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </span>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Tampilan Kartu Mobile Android */}
                <div className="md:hidden divide-y divide-slate-100">
                  {filteredProducts.map((p) => {
                    const isOut = p.stock <= 0;
                    const isLow = p.stock > 0 && p.stock <= p.minStock;
                    const extraUnits = p.sellUnits || [];
                    const stockSummary = formatProductStockSummary(p.stock, p);
                    const bSummary = batchSummaryByProductId.get(p.id);
                    const batchCount = bSummary?.allBatchesEvaluated.filter((b) => b.status === 'active' && b.remainingBaseQty > 0.0001).length || 0;
                    const prodExp = resolveProductExpiryDates(p);
                    const prodExpStatus = getExpiryStatus(prodExp.effectiveExpiryDate);
                    const prodDays = calculateDaysRemaining(prodExp.effectiveExpiryDate);
                    return (
                      <div key={p.id} className="p-4 space-y-2.5">
                        <div className="flex items-start gap-3">
                          {p.photoDataUrl ? (
                            <img
                              src={p.photoDataUrl}
                              alt={p.name}
                              referrerPolicy="no-referrer"
                              className="w-12 h-12 rounded-lg object-cover border border-slate-200 shrink-0"
                            />
                          ) : (
                            <div className="w-12 h-12 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center shrink-0">
                              <Package className="w-6 h-6" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm text-slate-900 truncate">
                              {p.name}
                            </div>
                            {(p.brand || p.variant) && (
                              <div className="text-[11px] font-medium text-slate-600">
                                {[p.brand, p.variant].filter(Boolean).join(' · ')}
                              </div>
                            )}
                            <div className="text-xs text-slate-500">
                              <span className="font-mono-num">{p.sku}</span>
                              <span className="mx-1.5" aria-hidden="true">·</span>
                              <span>{p.categoryName}</span>
                              <span className="mx-1.5" aria-hidden="true">·</span>
                              <span>Dasar {p.unit}</span>
                            </div>
                            {p.barcode && (
                              <div className="text-[11px] font-mono-num text-slate-400">
                                Barcode: {p.barcode}
                              </div>
                            )}
                            {bSummary && (bSummary.hasExpiredStock || bSummary.hasNearExpiry || batchCount > 0) ? (
                              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                {bSummary.hasExpiredStock && (
                                  <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-bold">
                                    EXPIRED
                                  </span>
                                )}
                                {bSummary.hasNearExpiry && (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">
                                    MENDEKATI EXPIRED
                                  </span>
                                )}
                                {batchCount > 0 && bSummary.nearestNonExpired && (
                                  <span className="text-[10px] font-mono-num text-slate-500">
                                    {batchCount} batch · ED {formatShortIdDate(bSummary.nearestNonExpired.effectiveExpiryDate)}
                                  </span>
                                )}
                              </div>
                            ) : prodExp.hasExplicitDates && (
                              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                {prodExpStatus === 'EXPIRED' && (
                                  <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-bold">
                                    EXPIRED
                                  </span>
                                )}
                                {prodExpStatus === 'MENDEKATI EXPIRED' && (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">
                                    MENDEKATI EXPIRED · {formatDaysRemainingLabel(prodDays)}
                                  </span>
                                )}
                                <span className="text-[10px] font-mono-num text-slate-500">
                                  Input {formatShortIdDate(prodExp.inputDate)} · ED {formatShortIdDate(prodExp.effectiveExpiryDate)}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-xs pt-0.5 gap-2">
                          <div className="space-y-0.5">
                            <div>
                              <span className="text-slate-500">Ecer: </span>
                              <span className="font-mono-num font-semibold text-sm text-slate-900">
                                {formatRupiah(p.sellPrice)}/{p.unit}
                              </span>
                              <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
                              <span className="text-slate-500">
                                HPP {formatRupiah(p.costPrice)}
                              </span>
                            </div>
                            {p.wholesalePrice !== undefined && p.wholesalePrice > 0 && (
                              <div className="text-[11px] font-mono-num text-slate-600">
                                Grosir {formatRupiah(p.wholesalePrice)}/{p.unit}
                                {p.wholesaleMinQty ? ` (min ${formatQty(p.wholesaleMinQty)})` : ''}
                              </div>
                            )}
                            {extraUnits.length > 0 && (
                              <div className="text-[11px] font-mono-num text-slate-600">
                                {extraUnits
                                  .map((u) => {
                                    const convLbl = formatUnitConversionLabel(
                                      {
                                        unitName: u.unitName,
                                        conversion: u.conversion,
                                        conversionMode:
                                          u.conversionMode === 'divide' ? 'divide' : 'multiply',
                                        perBaseQty: u.perBaseQty,
                                        isBase: false,
                                      },
                                      p.unit
                                    );
                                    return `${u.unitName} (${convLbl}): ${formatRupiah(u.sellPrice)}`;
                                  })
                                  .join(' · ')}
                              </div>
                            )}
                          </div>
                          <div
                            className={`font-mono-num font-semibold text-right shrink-0 ${
                              isOut
                                ? 'text-red-700'
                                : isLow
                                  ? 'text-amber-700'
                                  : 'text-emerald-700'
                            }`}
                          >
                            <div>
                              {stockSummary.primary}
                              {isOut ? ' (Habis)' : isLow ? ' (Menipis)' : ''}
                            </div>
                            {stockSummary.secondary && (
                              <div className="text-[10px] font-normal text-slate-500">
                                {stockSummary.secondary}
                              </div>
                            )}
                          </div>
                        </div>

                        {isAdmin && (
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => openBatchDetailModal(p)}
                              className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1"
                            >
                              <Calendar className="w-3.5 h-3.5 text-emerald-700" />
                              <span>Batch ({batchCount})</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openAdjustModal(p)}
                              className="flex-1 min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
                            >
                              <SlidersHorizontal className="w-3.5 h-3.5" />
                              <span>Stok</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditProduct(p)}
                              className="min-h-[40px] px-3.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                confirmDeleteId === p.id
                                  ? handleDeleteProduct(p.id, p.name)
                                  : setConfirmDeleteId(p.id)
                              }
                              className="min-h-[40px] px-3.5 py-1.5 rounded-lg border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50"
                            >
                              {confirmDeleteId === p.id ? 'Konfirmasi' : 'Hapus'}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: RIWAYAT STOK MASUK & KELUAR */}
      {subTab === 'movements' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Riwayat Stok Masuk &amp; Keluar
              </h3>
              <p className="text-xs text-slate-500">
                Semua pergerakan stok (Admin &amp; Kasir) dikonversi dan dicatat otomatis ke satuan dasar produk secara real-time.
              </p>
            </div>
            <ArrowUpDown className="w-4 h-4 text-slate-400" />
          </div>

          {movementsLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : movements.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Belum ada riwayat pergerakan stok yang tercatat.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                    <th className="py-3 px-4 whitespace-nowrap">No. Transaksi</th>
                    <th className="py-3 px-4">Produk</th>
                    <th className="py-3 px-4 whitespace-nowrap">Jenis</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Satuan Transaksi</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Perubahan Dasar</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Stok Akhir</th>
                    <th className="py-3 px-4 whitespace-nowrap">Petugas</th>
                    <th className="py-3 px-4">Keterangan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {movements.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                        {m.transactionDate} · {m.transactionTime}
                      </td>
                      <td className="py-3 px-4 font-mono-num text-xs font-medium text-slate-800 whitespace-nowrap">
                        {m.transactionNumber}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-900">{m.productName}</td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`text-xs font-semibold ${
                            m.type === 'in'
                              ? 'text-emerald-700'
                              : m.type === 'out'
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }`}
                        >
                          {m.type === 'in'
                            ? 'Stok Masuk'
                            : m.type === 'out'
                              ? 'Stok Keluar'
                              : 'Penyesuaian'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-xs text-slate-600 whitespace-nowrap">
                        {m.unitQuantity !== undefined && m.unitName
                          ? `${formatQty(m.unitQuantity)} ${m.unitName}${
                              m.conversion && m.conversion !== 1 ? ` (×${formatQty(m.conversion)})` : ''
                            }`
                          : '-'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num font-semibold whitespace-nowrap">
                        {m.type === 'in'
                          ? `+${formatQty(m.quantity)}`
                          : m.type === 'out'
                            ? `-${formatQty(m.quantity)}`
                            : formatQty(m.quantity)}{' '}
                        {m.baseUnit || ''}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-slate-900 whitespace-nowrap">
                        {formatQty(m.stockBefore)} → <strong>{formatQty(m.stockAfter)}</strong>{' '}
                        {m.baseUnit || ''}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {m.recordedByName}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 min-w-[180px]">
                        {m.notes || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: RIWAYAT PERUBAHAN HARGA */}
      {subTab === 'prices' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Riwayat Perubahan Harga &amp; Satuan
              </h3>
              <p className="text-xs text-slate-500">
                Catatan otomatis tersinkronisasi real-time setiap kali harga modal, harga ecer, harga grosir, atau konversi satuan ditetapkan atau diubah.
              </p>
            </div>
            <History className="w-4 h-4 text-slate-400" />
          </div>

          {priceHistoryLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : priceHistory.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Belum ada riwayat perubahan harga yang tercatat.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                    <th className="py-3 px-4 whitespace-nowrap">No. Catatan</th>
                    <th className="py-3 px-4">Produk</th>
                    <th className="py-3 px-4 whitespace-nowrap">Status</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Modal Dasar</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Ecer Dasar</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">Grosir Dasar</th>
                    <th className="py-3 px-4">Ringkasan Perubahan</th>
                    <th className="py-3 px-4 whitespace-nowrap">Petugas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {priceHistory.map((h) => (
                    <tr key={h.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                        {h.transactionDate} · {h.transactionTime}
                      </td>
                      <td className="py-3 px-4 font-mono-num text-xs font-medium text-slate-800 whitespace-nowrap">
                        {h.transactionNumber}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-900">
                        {h.productName}
                        <span className="text-xs font-normal text-slate-500"> ({h.baseUnit})</span>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`text-xs font-semibold ${
                            h.changeType === 'initial' ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {h.changeType === 'initial' ? 'Harga Awal' : 'Ubah Harga'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-xs whitespace-nowrap">
                        {h.changeType === 'initial'
                          ? formatRupiah(h.costPriceAfter)
                          : `${formatRupiah(h.costPriceBefore)} → ${formatRupiah(h.costPriceAfter)}`}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-xs font-semibold text-slate-900 whitespace-nowrap">
                        {h.changeType === 'initial'
                          ? formatRupiah(h.sellPriceAfter)
                          : `${formatRupiah(h.sellPriceBefore)} → ${formatRupiah(h.sellPriceAfter)}`}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-num text-xs whitespace-nowrap">
                        {h.wholesalePriceAfter !== undefined
                          ? h.changeType === 'initial'
                            ? formatRupiah(h.wholesalePriceAfter)
                            : `${
                                h.wholesalePriceBefore !== undefined
                                  ? formatRupiah(h.wholesalePriceBefore)
                                  : '-'
                              } → ${formatRupiah(h.wholesalePriceAfter)}`
                          : '-'}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 min-w-[200px]">
                        {h.summary}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {h.recordedByName}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: KATEGORI PRODUK */}
      {subTab === 'categories' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Daftar Kategori Produk ({categories.length})
              </h3>
            </div>
            <div className="divide-y divide-slate-100">
              {categories.map((cat) => {
                const count = products.filter((p) => p.categoryId === cat.id).length;
                return (
                  <div
                    key={cat.id}
                    className="px-5 py-3.5 flex items-center justify-between gap-4 text-sm"
                  >
                    <div>
                      <div className="font-medium text-slate-900">{cat.name}</div>
                      {cat.description && (
                        <div className="text-xs text-slate-500">{cat.description}</div>
                      )}
                    </div>
                    <div className="font-mono-num text-xs text-slate-600 shrink-0">
                      {count} produk
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {isAdmin && (
            <form
              onSubmit={handleAddCategory}
              className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4 self-start"
            >
              <h3 className="font-display font-semibold text-base text-slate-900">
                Tambah Kategori Tambahan
              </h3>
              <div className="space-y-1.5">
                <label htmlFor="cat-name" className="block text-xs font-medium text-slate-700">
                  Nama Kategori
                </label>
                <input
                  id="cat-name"
                  type="text"
                  required
                  maxLength={60}
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="Contoh: Alat Tulis & Kertas"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="cat-desc" className="block text-xs font-medium text-slate-700">
                  Keterangan (Opsional)
                </label>
                <input
                  id="cat-desc"
                  type="text"
                  maxLength={200}
                  value={newCatDesc}
                  onChange={(e) => setNewCatDesc(e.target.value)}
                  placeholder="Deskripsi singkat kategori..."
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <button
                type="submit"
                disabled={savingCategory}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>{savingCategory ? 'Menyimpan...' : 'Simpan Kategori'}</span>
              </button>
            </form>
          )}
        </div>
      )}

      {/* MODAL TAMBAH / EDIT PRODUK */}
      {showProductModal && (
        <div className="fixed inset-0 z-40 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full max-h-[92vh] overflow-y-auto">
            <div className="sticky top-0 bg-white px-5 py-4 border-b border-slate-200 flex items-center justify-between z-10">
              <h3 className="font-display font-semibold text-base text-slate-900">
                {editingProduct ? 'Edit Produk & Multi-Satuan' : 'Tambah Produk Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowProductModal(false)}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
                aria-label="Tutup Form Produk"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="p-5 space-y-5">
              {/* Foto Produk (Kamera atau Galeri) */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                {photoDataUrl ? (
                  <img
                    src={photoDataUrl}
                    alt="Preview Produk"
                    referrerPolicy="no-referrer"
                    className="w-20 h-20 rounded-lg object-cover border border-slate-300 shrink-0 bg-white"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-lg bg-white border border-dashed border-slate-300 flex items-center justify-center text-slate-400 shrink-0">
                    <Package className="w-8 h-8" />
                  </div>
                )}

                <div className="flex-1 space-y-2">
                  <div className="text-xs font-medium text-slate-700">
                    Foto Produk (Otomatis dikompres untuk sinkronisasi cepat)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setShowCameraModal(true)}
                      className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Camera className="w-4 h-4 text-emerald-700" />
                      <span>Kamera Langsung</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => mobileCameraInputRef.current?.click()}
                      className="sm:hidden min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      <Camera className="w-4 h-4 text-emerald-700" />
                      <span>Kamera HP</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => galleryInputRef.current?.click()}
                      className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <ImageIcon className="w-4 h-4 text-slate-600" />
                      <span>Pilih dari Galeri</span>
                    </button>
                    {photoDataUrl && (
                      <button
                        type="button"
                        onClick={() => setPhotoDataUrl('')}
                        className="min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-medium text-red-700 hover:bg-red-50 cursor-pointer"
                      >
                        Hapus Foto
                      </button>
                    )}
                  </div>
                  <input
                    ref={galleryInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handleImageSelected(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <input
                    ref={mobileCameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                      handleImageSelected(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>

              {/* Peringatan Duplikasi Produk */}
              {activeDuplicateInfo && (
                <div className="p-4 rounded-xl bg-red-50 border border-red-300 text-red-900 space-y-2.5">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1 text-xs">
                      <div className="font-bold text-sm text-red-800">
                        {activeDuplicateInfo.message}
                      </div>
                      {activeDuplicateInfo.existingProduct && (
                        <div className="text-red-800">
                          Data terdaftar:{' '}
                          <strong>{formatProductFullName(activeDuplicateInfo.existingProduct)}</strong> · Kode{' '}
                          <span className="font-mono-num">{activeDuplicateInfo.existingProduct.sku}</span>
                          {activeDuplicateInfo.existingProduct.barcode
                            ? ` · Barcode ${activeDuplicateInfo.existingProduct.barcode}`
                            : ''}
                          {' '}· Stok {formatQty(activeDuplicateInfo.existingProduct.stock)}{' '}
                          {activeDuplicateInfo.existingProduct.unit}
                        </div>
                      )}
                      <div className="text-[11px] text-red-700">
                        Jika merek sama tetapi ukuran, rasa, berat, atau varian berbeda, isi kolom{' '}
                        <strong>Varian / Ukuran</strong> agar tetap dapat didaftarkan sebagai produk berbeda.
                      </div>
                    </div>
                  </div>
                  {activeDuplicateInfo.existingProduct && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          if (activeDuplicateInfo.existingProduct) {
                            openEditProduct(activeDuplicateInfo.existingProduct);
                          }
                        }}
                        className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-red-700 text-white text-xs font-semibold hover:bg-red-800 cursor-pointer"
                      >
                        Buka Data Produk
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Identitas Barang */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="prd-sku" className="block text-xs font-medium text-slate-700">
                    Kode Barang (Otomatis, Bisa Diedit)
                  </label>
                  <input
                    id="prd-sku"
                    type="text"
                    required
                    maxLength={40}
                    value={sku}
                    onChange={(e) => setSku(e.target.value.toUpperCase())}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="prd-barcode" className="block text-xs font-medium text-slate-700">
                    Barcode Kemasan (Opsional)
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="prd-barcode"
                      type="text"
                      maxLength={64}
                      value={barcode}
                      onChange={(e) => {
                        setBarcode(e.target.value.toUpperCase());
                        setDuplicateConflict(null);
                      }}
                      placeholder="Scan atau ketik barcode"
                      className="flex-1 min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                    <button
                      type="button"
                      onClick={() => setScannerTarget('form')}
                      className="min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <ScanBarcode className="w-4 h-4 text-emerald-700" />
                      <span>Scan</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="prd-name" className="block text-xs font-medium text-slate-700">
                    Nama Barang
                  </label>
                  <input
                    id="prd-name"
                    type="text"
                    required
                    maxLength={120}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value.toUpperCase());
                      setDuplicateConflict(null);
                    }}
                    placeholder="Contoh: Mi Instan Goreng"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="prd-cat" className="block text-xs font-medium text-slate-700">
                    Kategori
                  </label>
                  <select
                    id="prd-cat"
                    required
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="prd-brand" className="block text-xs font-medium text-slate-700">
                    Merek (Opsional)
                  </label>
                  <input
                    id="prd-brand"
                    type="text"
                    maxLength={60}
                    value={brand}
                    onChange={(e) => {
                      setBrand(e.target.value.toUpperCase());
                      setDuplicateConflict(null);
                    }}
                    placeholder="Contoh: Indomie / Kapal Api / Aqua"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="prd-variant" className="block text-xs font-medium text-slate-700">
                    Varian / Ukuran / Rasa / Berat (Opsional)
                  </label>
                  <input
                    id="prd-variant"
                    type="text"
                    maxLength={80}
                    value={variant}
                    onChange={(e) => {
                      setVariant(e.target.value.toUpperCase());
                      setDuplicateConflict(null);
                    }}
                    placeholder="Contoh: 85gr / 600ml / Rasa Soto / Jumbo"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              </div>

              {/* Harga & Satuan Dasar */}
              <div className="border-t border-slate-200 pt-4 space-y-4">
                <div className="space-y-2">
                  <div>
                    <h4 className="font-display font-semibold text-sm text-slate-900">
                      Satuan Dasar, Harga Modal &amp; Harga Ecer / Grosir
                    </h4>
                    <p className="text-xs text-slate-500">
                      Tentukan sendiri satuan terkecil produk (misal GRAM, BATANG, ML, BUTIR, KG, atau PCS). Mendukung angka desimal untuk berat &amp; volume.
                    </p>
                  </div>

                  {/* Paket Template Cepat Multi-Satuan Universal */}
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-600">
                      Paket Satuan Cepat (Klik untuk mengisi struktur, konversi &amp; harga tetap bebas diubah):
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {UNIVERSAL_UNIT_TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => applyUnitTemplate(tpl)}
                          title={tpl.description}
                          className="px-2.5 py-1.5 rounded-md border border-slate-300 bg-white text-[11px] font-medium text-slate-700 hover:border-emerald-600 hover:text-emerald-700 transition-colors cursor-pointer"
                        >
                          {tpl.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {(() => {
                    const baseUnitLocked = Boolean(
                      editingProduct && usedUnitNames.has(editingProduct.unit.trim().toUpperCase())
                    );
                    return (
                      <div className="space-y-1.5">
                        <label htmlFor="prd-unit" className="block text-xs font-medium text-slate-700">
                          Satuan Dasar (Acuan Stok)
                        </label>
                        <div className="flex gap-2">
                          <select
                            id="prd-unit"
                            value={unit}
                            disabled={baseUnitLocked}
                            onChange={(e) => setUnit(e.target.value)}
                            className="flex-1 min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-slate-100 disabled:text-slate-500"
                          >
                            {UNIT_PRESETS.map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                            <option value="__custom__">Kustom Lainnya...</option>
                          </select>
                          {unit === '__custom__' && (
                            <input
                              type="text"
                              required
                              disabled={baseUnitLocked}
                              maxLength={24}
                              value={customUnit}
                              onChange={(e) => setCustomUnit(e.target.value)}
                              placeholder="Misal: POTONG"
                              className="w-28 min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-slate-100"
                            />
                          )}
                        </div>
                        <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-slate-700">
                          <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={baseCanBuy}
                              onChange={(e) => setBaseCanBuy(e.target.checked)}
                              className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                            />
                            <span>Pembelian</span>
                          </label>
                          <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={baseCanSell}
                              onChange={(e) => setBaseCanSell(e.target.checked)}
                              className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                            />
                            <span>Kasir / Jual</span>
                          </label>
                        </div>
                        {baseUnitLocked && (
                          <div className="text-[11px] text-amber-700">
                            Satuan dasar sudah dipakai dalam transaksi (nama dikunci).
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="space-y-1.5">
                    <label htmlFor="prd-cost" className="block text-xs font-medium text-slate-700">
                      Harga Modal / {baseUnitPreview} (Rp)
                    </label>
                    <input
                      id="prd-cost"
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={costPrice}
                      onChange={(e) => setCostPrice(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="prd-sell" className="block text-xs font-medium text-slate-700">
                      Harga Ecer / {baseUnitPreview} (Rp)
                    </label>
                    <input
                      id="prd-sell"
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={sellPrice}
                      onChange={(e) => setSellPrice(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                    <div className="text-[11px] font-mono-num text-slate-500">
                      Laba Ecer:{' '}
                      <span className={formRetailMargin >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                        {formatRupiah(formRetailMargin)}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="prd-wh-price" className="block text-xs font-medium text-slate-700">
                      Harga Grosir / {baseUnitPreview} (Opsional)
                    </label>
                    <input
                      id="prd-wh-price"
                      type="number"
                      min="0"
                      step="any"
                      value={wholesalePrice}
                      onChange={(e) => setWholesalePrice(e.target.value)}
                      placeholder="Contoh: 2800"
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                    {formWholesaleMargin !== null && (
                      <div className="text-[11px] font-mono-num text-slate-500">
                        Laba Grosir:{' '}
                        <span
                          className={
                            formWholesaleMargin >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }
                        >
                          {formatRupiah(formWholesaleMargin)}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="prd-wh-min" className="block text-xs font-medium text-slate-700">
                      Minimal Beli Grosir ({baseUnitPreview})
                    </label>
                    <input
                      id="prd-wh-min"
                      type="number"
                      min="0.0001"
                      step="any"
                      value={wholesaleMinQty}
                      onChange={(e) => setWholesaleMinQty(e.target.value)}
                      placeholder="Opsional, misal 10 atau 0.5"
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                    <div className="text-[11px] text-slate-400">
                      Kasir tetap bisa memilih Ecer / Grosir secara manual
                    </div>
                  </div>

                  {!editingProduct ? (
                    <div className="space-y-1.5">
                      <label htmlFor="prd-stock" className="block text-xs font-medium text-slate-700">
                        Stok Awal ({baseUnitPreview})
                      </label>
                      <input
                        id="prd-stock"
                        type="number"
                        min="0"
                        step="any"
                        required
                        value={stock}
                        onChange={(e) => setStock(e.target.value)}
                        className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      />
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="block text-xs font-medium text-slate-700">Stok Saat Ini</div>
                      <div className="min-h-[44px] px-3.5 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm font-mono-num flex items-center justify-between">
                        <span>
                          {formatQty(editingProduct.stock)} {editingProduct.unit}
                        </span>
                        <span className="text-[11px] text-slate-500">Ubah via Stok</span>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label htmlFor="prd-min" className="block text-xs font-medium text-slate-700">
                      Stok Minimum ({baseUnitPreview})
                    </label>
                    <input
                      id="prd-min"
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={minStock}
                      onChange={(e) => setMinStock(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                      <Calendar className="w-4 h-4 text-emerald-700 shrink-0" />
                      <span>Tanggal Input &amp; Expired Otomatis (+6 Bulan)</span>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] font-bold font-mono-num ${
                        initialExpiryStatus === 'EXPIRED'
                          ? 'bg-red-100 text-red-800'
                          : initialExpiryStatus === 'MENDEKATI EXPIRED'
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {initialExpiryStatus} ({formatDaysRemainingLabel(initialDaysRemaining)})
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                    <div className="space-y-1">
                      <label htmlFor="prd-exp-start" className="block text-[11px] font-medium text-slate-600">
                        Tanggal Input Produk / Stok
                      </label>
                      <input
                        id="prd-exp-start"
                        type="date"
                        value={initialExpiryStartDate}
                        onChange={(e) => setInitialExpiryStartDate(e.target.value)}
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-[11px] font-medium text-slate-600">
                        Expired Otomatis (+6 Bln)
                      </div>
                      <div className="min-h-[40px] px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs font-mono-num font-semibold text-slate-800 flex items-center">
                        {formatShortIdDate(estimatedInitialExpiry)} ({estimatedInitialExpiry})
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="prd-exp-actual" className="block text-[11px] font-medium text-slate-600">
                        ED Aktual Kemasan (Opsional, Diutamakan)
                      </label>
                      <input
                        id="prd-exp-actual"
                        type="date"
                        value={initialActualExpiryDate}
                        onChange={(e) => setInitialActualExpiryDate(e.target.value)}
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-600">
                    Pemberitahuan otomatis aktif mulai <strong>1 bulan (30 hari)</strong> sebelum tanggal expired (<strong>{formatShortIdDate(effectiveInitialExpiry)}</strong>). {EXPIRY_ESTIMATE_DISCLAIMER}
                  </p>
                </div>
              </div>

              {/* Satuan Tambahan (Multi-Satuan Universal Pembelian & Penjualan) */}
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <h4 className="font-display font-semibold text-sm text-slate-900 flex items-center gap-1.5">
                      <Layers className="w-4 h-4 text-emerald-700" />
                      <span>Satuan Pembelian &amp; Penjualan Tambahan</span>
                    </h4>
                    <p className="text-xs text-slate-500">
                      Atur satuan kemasan besar (misal 1 SLOP = 10 {baseUnitPreview}) atau sub-satuan pecahan (misal 1 {baseUnitPreview} = 20 BATANG).
                      {loadingUsedUnits ? ' Memeriksa riwayat pemakaian satuan...' : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addSellUnitRow}
                    className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-700 text-emerald-700 text-xs font-semibold hover:bg-emerald-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Tambah Satuan</span>
                  </button>
                </div>

                {sellUnitDrafts.length === 0 ? (
                  <div className="p-3.5 rounded-lg bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-500 text-center">
                    Belum ada satuan tambahan. Produk hanya memakai satuan dasar {baseUnitPreview}.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sellUnitDrafts.map((row, rowIndex) => {
                      const uName = (
                        row.unitPreset === '__custom__' ? row.customUnitName : row.unitPreset
                      ).trim();
                      const displayUName = uName || 'Satuan';
                      const uUpper = uName.toUpperCase();
                      const sameAsBase = uUpper !== '' && uUpper === baseUnitPreview.toUpperCase();
                      const duplicatedElsewhere =
                        uUpper !== '' &&
                        sellUnitDrafts.some(
                          (other, oIdx) =>
                            oIdx !== rowIndex &&
                            (other.unitPreset === '__custom__'
                              ? other.customUnitName
                              : other.unitPreset
                            )
                              .trim()
                              .toUpperCase() === uUpper
                        );

                      const isUnitLocked = Boolean(
                        editingProduct &&
                          row.originalUnitName &&
                          usedUnitNames.has(row.originalUnitName.trim().toUpperCase())
                      );
                      const isDivide = row.conversionMode === 'divide';
                      const perBaseNum = Math.max(0, Number(row.perBaseQty) || 0);
                      const conv = isDivide
                        ? perBaseNum > 0
                          ? computeSubUnitConversion(perBaseNum)
                          : 0
                        : Math.max(0, Number(row.conversion) || 0);

                      const unitCost = roundMoney(formCostNum * conv);
                      const unitBuy =
                        row.buyPrice.trim() !== ''
                          ? Math.max(0, Number(row.buyPrice) || 0)
                          : null;
                      const unitSell = Math.max(0, Number(row.sellPrice) || 0);
                      const unitProfit = roundMoney(unitSell - unitCost);
                      const unitWh =
                        row.wholesalePrice.trim() !== ''
                          ? Math.max(0, Number(row.wholesalePrice) || 0)
                          : null;
                      const unitWhProfit = unitWh !== null ? roundMoney(unitWh - unitCost) : null;

                      return (
                        <div
                          key={row.id}
                          className={`p-3.5 rounded-lg border space-y-3 ${
                            sameAsBase || duplicatedElsewhere
                              ? 'bg-red-50/40 border-red-300'
                              : isUnitLocked
                                ? 'bg-amber-50/30 border-amber-200'
                                : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                            <div className="sm:col-span-3 space-y-1">
                              <label className="block text-[11px] font-medium text-slate-600">
                                Nama Satuan
                              </label>
                              <select
                                value={row.unitPreset}
                                disabled={isUnitLocked}
                                onChange={(e) =>
                                  updateSellUnitRow(row.id, { unitPreset: e.target.value })
                                }
                                className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-slate-100 disabled:text-slate-500"
                              >
                                {UNIT_PRESETS.filter(
                                  (u) => u.toUpperCase() !== baseUnitPreview.toUpperCase()
                                ).map((u) => (
                                  <option key={u} value={u}>
                                    {u}
                                  </option>
                                ))}
                                <option value="__custom__">Kustom...</option>
                              </select>
                              {row.unitPreset === '__custom__' && (
                                <input
                                  type="text"
                                  maxLength={24}
                                  disabled={isUnitLocked}
                                  value={row.customUnitName}
                                  onChange={(e) =>
                                    updateSellUnitRow(row.id, { customUnitName: e.target.value })
                                  }
                                  placeholder="Misal: SLOP / BATANG"
                                  className="w-full min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-300 text-xs mt-1 bg-white disabled:bg-slate-100"
                                />
                              )}
                            </div>

                            <div className="sm:col-span-3 space-y-1">
                              <label className="block text-[11px] font-medium text-slate-600">
                                Hubungan ke {baseUnitPreview}
                              </label>
                              <select
                                value={row.conversionMode}
                                disabled={isUnitLocked}
                                onChange={(e) => {
                                  const mode = e.target.value as 'multiply' | 'divide';
                                  updateSellUnitRow(row.id, { conversionMode: mode });
                                }}
                                className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-slate-100 disabled:text-slate-500"
                              >
                                <option value="multiply">
                                  1 {displayUName} = X {baseUnitPreview}
                                </option>
                                <option value="divide">
                                  1 {baseUnitPreview} = Y {displayUName}
                                </option>
                              </select>
                            </div>

                            <div className="sm:col-span-2 space-y-1">
                              <label className="block text-[11px] font-medium text-slate-600">
                                {isDivide
                                  ? `Isi per ${baseUnitPreview}`
                                  : `Isi (${baseUnitPreview})`}
                              </label>
                              {isDivide ? (
                                <input
                                  type="number"
                                  min="0.0001"
                                  step="any"
                                  required
                                  disabled={isUnitLocked}
                                  value={row.perBaseQty}
                                  onChange={(e) =>
                                    updateSellUnitRow(row.id, {
                                      perBaseQty: e.target.value,
                                      conversion: String(
                                        computeSubUnitConversion(Number(e.target.value) || 0)
                                      ),
                                    })
                                  }
                                  placeholder="20"
                                  className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-slate-100"
                                />
                              ) : (
                                <input
                                  type="number"
                                  min="0.0001"
                                  step="any"
                                  required
                                  disabled={isUnitLocked}
                                  value={row.conversion}
                                  onChange={(e) =>
                                    updateSellUnitRow(row.id, { conversion: e.target.value })
                                  }
                                  className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-slate-100"
                                />
                              )}
                            </div>

                            <div className="sm:col-span-2 space-y-1">
                              <label className="block text-[11px] font-medium text-slate-600">
                                Beli / {displayUName}
                              </label>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={row.buyPrice}
                                onChange={(e) =>
                                  updateSellUnitRow(row.id, { buyPrice: e.target.value })
                                }
                                placeholder="Opsional"
                                className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                              />
                            </div>

                            <div className="sm:col-span-2 space-y-1">
                              <label className="block text-[11px] font-medium text-slate-600">
                                Ecer / {displayUName}
                              </label>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                required
                                value={row.sellPrice}
                                onChange={(e) =>
                                  updateSellUnitRow(row.id, { sellPrice: e.target.value })
                                }
                                className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                            <div className="sm:col-span-3 space-y-1">
                              <label className="block text-[11px] font-medium text-slate-600">
                                Harga Grosir (Ops)
                              </label>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={row.wholesalePrice}
                                onChange={(e) =>
                                  updateSellUnitRow(row.id, { wholesalePrice: e.target.value })
                                }
                                placeholder="-"
                                className="w-full min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                              />
                            </div>

                            <div className="sm:col-span-2 space-y-1">
                              <label className="block text-[11px] font-medium text-slate-600">
                                Min Grosir
                              </label>
                              <input
                                type="number"
                                min="0.0001"
                                step="any"
                                value={row.wholesaleMinQty}
                                onChange={(e) =>
                                  updateSellUnitRow(row.id, { wholesaleMinQty: e.target.value })
                                }
                                placeholder="-"
                                className="w-full min-h-[38px] px-2 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                              />
                            </div>

                            <div className="sm:col-span-6 flex flex-wrap items-center gap-4 pt-3 sm:pt-4 text-xs text-slate-700">
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={row.canBuy}
                                  onChange={(e) =>
                                    updateSellUnitRow(row.id, { canBuy: e.target.checked })
                                  }
                                  className="w-4 h-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                                />
                                <span>Aktif Pembelian</span>
                              </label>
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={row.canSell}
                                  onChange={(e) =>
                                    updateSellUnitRow(row.id, { canSell: e.target.checked })
                                  }
                                  className="w-4 h-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                                />
                                <span>Aktif Kasir / Jual</span>
                              </label>
                            </div>

                            <div className="sm:col-span-1 flex justify-end pt-2 sm:pt-4">
                              <button
                                type="button"
                                disabled={isUnitLocked}
                                onClick={() => removeSellUnitRow(row.id)}
                                title={
                                  isUnitLocked
                                    ? 'Sudah dipakai transaksi, tidak bisa dihapus'
                                    : `Hapus satuan ${displayUName}`
                                }
                                className="h-[38px] w-9 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center shrink-0 cursor-pointer"
                                aria-label={`Hapus satuan ${displayUName}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          {(sameAsBase || duplicatedElsewhere) && (
                            <div className="text-[11px] font-semibold text-red-700">
                              {sameAsBase
                                ? `Satuan tambahan "${uName}" tidak boleh sama dengan satuan dasar "${baseUnitPreview}".`
                                : `Satuan "${uName}" sudah ada di baris lain.`}
                            </div>
                          )}

                          {isUnitLocked && (
                            <div className="text-[11px] text-amber-800">
                              Satuan ini sudah pernah tercatat di transaksi. Nama dan konversi dikunci agar riwayat &amp; HPP aman (tetap bisa ubah harga atau nonaktifkan centang Pembelian/Kasir).
                            </div>
                          )}

                          <div className="text-[11px] font-mono-num text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                            <span>
                              {isDivide
                                ? `1 ${baseUnitPreview} = ${formatQty(perBaseNum)} ${displayUName} (×${formatQty(conv)})`
                                : `1 ${displayUName} = ${formatQty(conv)} ${baseUnitPreview}`}
                            </span>
                            {unitBuy !== null && (
                              <>
                                <span>·</span>
                                <span>Beli Set: {formatRupiah(unitBuy)}</span>
                              </>
                            )}
                            <span>·</span>
                            <span>HPP: {formatRupiah(unitCost)}</span>
                            <span>·</span>
                            <span className={unitProfit >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                              Laba Ecer: {formatRupiah(unitProfit)}
                            </span>
                            {unitWhProfit !== null && (
                              <>
                                <span>·</span>
                                <span
                                  className={
                                    unitWhProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                                  }
                                >
                                  Laba Grosir: {formatRupiah(unitWhProfit)}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {editingProduct && (
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                  />
                  <span>Produk aktif tampil di Kasir Retail</span>
                </label>
              )}

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowProductModal(false)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingProduct}
                  className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>{savingProduct ? 'Menyimpan...' : 'Simpan Produk'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL PENYESUAIAN STOK */}
      {adjustTarget && (
        <div className="fixed inset-0 z-40 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full max-h-[90dvh] overflow-y-auto">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Penyesuaian Stok Produk
              </h3>
              <button
                type="button"
                onClick={() => setAdjustTarget(null)}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveAdjustment} className="p-5 space-y-4">
              <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-sm">
                <div className="font-semibold text-slate-900">{adjustTarget.name}</div>
                <div className="text-xs text-slate-500 font-mono-num">
                  Stok saat ini: {formatProductStockSummary(adjustTarget.stock, adjustTarget).primary}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
                {(
                  [
                    { id: 'in', label: 'Masuk (+)' },
                    { id: 'out', label: 'Keluar (-)' },
                    { id: 'adjustment', label: 'Opname (=)' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setAdjustMode(m.id)}
                    className={`min-h-[38px] text-xs font-medium rounded-md transition-colors cursor-pointer ${
                      adjustMode === m.id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="adj-unit" className="block text-xs font-medium text-slate-700">
                    Satuan Input
                  </label>
                  <select
                    id="adj-unit"
                    value={activeAdjustUnit?.unitName || adjustTarget.unit}
                    onChange={(e) => setAdjustUnitName(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {adjustOptions.map((opt) => (
                      <option key={opt.unitName} value={opt.unitName}>
                        {opt.unitName} ({formatUnitConversionLabel(opt, adjustTarget.unit)})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="adj-qty" className="block text-xs font-medium text-slate-700">
                    {adjustMode === 'adjustment' ? 'Stok Fisik Baru' : 'Jumlah'}
                  </label>
                  <input
                    id="adj-qty"
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              </div>

              <div
                className={`p-3 rounded-lg border text-xs font-mono-num space-y-1 ${
                  adjustPreviewAfter < 0
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-slate-50 border-slate-200 text-slate-600'
                }`}
              >
                <div>
                  Konversi: {formatQty(Number(adjustQty) || 0)} {activeAdjustUnit?.unitName} ={' '}
                  <strong>
                    {formatQty(adjustConvertedBaseQty)} {adjustTarget.unit}
                  </strong>
                </div>
                <div>
                  Stok akhir: {formatProductStockSummary(adjustTarget.stock, adjustTarget).primary} →{' '}
                  <strong>
                    {adjustPreviewAfter < 0
                      ? `${formatQty(adjustPreviewAfter)} ${adjustTarget.unit}`
                      : formatProductStockSummary(adjustPreviewAfter, adjustTarget).primary}
                  </strong>
                  {adjustPreviewAfter < 0 ? ' (Ditolak: stok tidak boleh negatif)' : ''}
                </div>
              </div>

              {adjustMode === 'in' && (() => {
                const estAdjustExp = computeEstimatedExpiryDate(adjustStartDate);
                const effAdjustExp = getEffectiveExpiryDate(
                  estAdjustExp,
                  adjustActualExpiryDate || undefined
                );
                const adjExpStatus = getExpiryStatus(effAdjustExp);
                const adjDays = calculateDaysRemaining(effAdjustExp);
                return (
                  <div className="p-3.5 rounded-lg bg-emerald-50/60 border border-emerald-200 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-emerald-900 flex items-center gap-1.5">
                        <Calendar className="w-4 h-4 text-emerald-700" />
                        <span>Batch Baru &amp; Expired Otomatis (+6 Bulan)</span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono-num ${
                          adjExpStatus === 'EXPIRED'
                            ? 'bg-red-100 text-red-800'
                            : adjExpStatus === 'MENDEKATI EXPIRED'
                              ? 'bg-amber-100 text-amber-900'
                              : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {adjExpStatus} ({formatDaysRemainingLabel(adjDays)})
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div className="space-y-1">
                        <label htmlFor="adj-start-date" className="block text-[11px] font-medium text-slate-700">
                          Tanggal Input Stok
                        </label>
                        <input
                          id="adj-start-date"
                          type="date"
                          value={adjustStartDate}
                          onChange={(e) => setAdjustStartDate(e.target.value)}
                          className="w-full min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-300 text-xs font-mono-num bg-white"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="adj-actual-exp" className="block text-[11px] font-medium text-slate-700">
                          ED Aktual Kemasan (Opsional)
                        </label>
                        <input
                          id="adj-actual-exp"
                          type="date"
                          value={adjustActualExpiryDate}
                          onChange={(e) => setAdjustActualExpiryDate(e.target.value)}
                          className="w-full min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-300 text-xs font-mono-num bg-white"
                        />
                      </div>
                    </div>
                    <div className="text-[11px] font-mono-num text-emerald-900">
                      Expired otomatis (+6 bulan): <strong>{formatShortIdDate(estAdjustExp)}</strong> ({estAdjustExp})
                    </div>
                    <p className="text-[11px] text-slate-600">
                      Pemberitahuan otomatis aktif mulai <strong>1 bulan (30 hari)</strong> sebelum expired ({formatShortIdDate(effAdjustExp)}). {EXPIRY_ESTIMATE_DISCLAIMER}
                    </p>
                  </div>
                );
              })()}

              {adjustMode === 'out' && (() => {
                const activeBatches = (batchSummaryByProductId.get(adjustTarget.id)?.allBatchesEvaluated || []).filter(
                  (b) => b.status === 'active' && b.remainingBaseQty > 0.0001
                );
                if (activeBatches.length === 0) return null;
                return (
                  <div className="space-y-1.5">
                    <label htmlFor="adj-target-batch" className="block text-xs font-medium text-slate-700">
                      Potong dari Batch Tertentu (Opsional)
                    </label>
                    <select
                      id="adj-target-batch"
                      value={adjustTargetBatchId}
                      onChange={(e) => setAdjustTargetBatchId(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    >
                      <option value="">Tidak pilih batch spesifik (stok umum)</option>
                      {activeBatches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.batchNumber} · ED {b.effectiveExpiryDate} ({b.expiryStatus}) · Sisa {formatQty(b.remainingBaseQty)} {b.baseUnit}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}

              <div className="space-y-1.5">
                <label htmlFor="adj-notes" className="block text-xs font-medium text-slate-700">
                  Catatan / Alasan
                </label>
                <input
                  id="adj-notes"
                  type="text"
                  maxLength={240}
                  value={adjustNotes}
                  onChange={(e) => setAdjustNotes(e.target.value)}
                  placeholder="Contoh: Tambah kulakan, barang rusak, atau hasil opname"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setAdjustTarget(null)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingAdjust || adjustPreviewAfter < 0}
                  className="min-h-[44px] px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                >
                  {savingAdjust ? 'Menyimpan...' : 'Simpan Stok'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL DETAIL & EDIT BATCH KEDALUWARSA */}
      {batchDetailProduct && (() => {
        const summary = batchSummaryByProductId.get(batchDetailProduct.id) || summarizeProductBatches(batchDetailProduct, stockBatches);
        const batches = summary.allBatchesEvaluated;
        return (
          <div className="fixed inset-0 z-40 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
            <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full max-h-[88vh] flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h3 className="font-display font-semibold text-base text-slate-900">
                    Batch &amp; Masa Kedaluwarsa — {formatProductFullName(batchDetailProduct)}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Setiap pembelian atau input stok tanggal berbeda dicatat terpisah. Total stok: {formatQty(batchDetailProduct.stock)} {batchDetailProduct.unit}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setBatchDetailProduct(null)}
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
                  aria-label="Tutup Detail Batch"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-5 overflow-y-auto space-y-4 flex-1">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
                  {EXPIRY_ESTIMATE_DISCLAIMER}
                </div>

                {batches.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg">
                    Belum ada catatan batch kedaluwarsa untuk produk ini (stok lama tetap dapat dijual normal). Batch baru akan terbentuk otomatis saat pembelian atau penambahan stok baru.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {batches.map((b) => {
                      const isEditingThis = editingBatchId === b.id;
                      const statusBadgeClass =
                        b.status === 'pulled'
                          ? 'bg-slate-200 text-slate-700'
                          : b.status === 'handled'
                            ? 'bg-blue-100 text-blue-800'
                            : b.status === 'depleted' || b.remainingBaseQty <= 0.0001
                              ? 'bg-slate-100 text-slate-500'
                              : b.expiryStatus === 'EXPIRED'
                                ? 'bg-red-100 text-red-800'
                                : b.expiryStatus === 'MENDEKATI EXPIRED'
                                  ? 'bg-amber-100 text-amber-900'
                                  : 'bg-emerald-100 text-emerald-800';
                      const statusLabel =
                        b.status === 'pulled'
                          ? 'Ditarik Admin'
                          : b.status === 'handled'
                            ? 'Ditangani Admin'
                            : b.status === 'depleted' || b.remainingBaseQty <= 0.0001
                              ? 'Stok Habis'
                              : b.expiryStatus;
                      return (
                        <div
                          key={b.id}
                          className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono-num text-xs font-bold text-slate-900">
                                  {b.batchNumber}
                                </span>
                                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${statusBadgeClass}`}>
                                  {statusLabel}
                                </span>
                                {b.isActualPackagingDate ? (
                                  <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-[10px] font-semibold">
                                    ED Kemasan Aktual
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">
                                    Perkiraan +6 Bulan
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-slate-500 mt-1">
                                Sumber:{' '}
                                {b.sourceType === 'purchase'
                                  ? `Pembelian${b.supplierName ? ` (${b.supplierName})` : ''}`
                                  : b.sourceType === 'initial_product'
                                    ? 'Stok Awal Produk'
                                    : b.sourceType === 'excel_import'
                                      ? 'Import Excel'
                                      : 'Input Stok Manual'}
                                {b.sourceNumber ? ` · ${b.sourceNumber}` : ''}
                              </div>
                            </div>
                            <div className="text-right font-mono-num">
                              <div className="text-sm font-bold text-slate-900">
                                Sisa {formatQty(b.remainingBaseQty)} / {formatQty(b.initialBaseQty)} {b.baseUnit}
                              </div>
                              <div className="text-xs text-slate-500">
                                {b.remainingLabel}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-xs">
                            <div>
                              <span className="text-slate-500">Tanggal Awal: </span>
                              <strong className="font-mono-num text-slate-800">{formatShortIdDate(b.startDate)}</strong>
                            </div>
                            <div>
                              <span className="text-slate-500">Perkiraan +6 Bln: </span>
                              <strong className="font-mono-num text-slate-800">{formatShortIdDate(b.estimatedExpiryDate)}</strong>
                            </div>
                            <div>
                              <span className="text-slate-500">ED Aktif: </span>
                              <strong className="font-mono-num text-slate-900">{formatShortIdDate(b.effectiveExpiryDate)}</strong>
                            </div>
                          </div>

                          {b.handlingNotes && (
                            <div className="text-xs text-slate-600 bg-slate-50 px-2.5 py-1.5 rounded border border-slate-200">
                              Catatan penanganan ({b.handledDate || '-'} oleh {b.handledByName || 'Admin'}): {b.handlingNotes}
                            </div>
                          )}

                          {isAdmin && (
                            <div className="pt-1 flex flex-wrap items-center justify-between gap-2">
                              {isEditingThis ? (
                                <div className="flex flex-wrap items-center gap-2 w-full">
                                  <input
                                    type="date"
                                    value={editingBatchDate}
                                    onChange={(e) => setEditingBatchDate(e.target.value)}
                                    className="min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-300 text-xs font-mono-num"
                                  />
                                  <button
                                    type="button"
                                    disabled={savingBatchDate}
                                    onClick={() => handleSaveBatchActualExpiry(b)}
                                    className="min-h-[38px] px-3 py-1 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                                  >
                                    {savingBatchDate ? 'Menyimpan...' : 'Simpan ED Kemasan'}
                                  </button>
                                  {b.actualExpiryDate && (
                                    <button
                                      type="button"
                                      disabled={savingBatchDate}
                                      onClick={() => {
                                        setEditingBatchDate('');
                                        void updateBatchActualExpiry(b, null).then(() => {
                                          setEditingBatchId(null);
                                        });
                                      }}
                                      className="min-h-[38px] px-3 py-1 rounded-lg border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 cursor-pointer"
                                    >
                                      Reset ke +6 Bln
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setEditingBatchId(null)}
                                    className="min-h-[38px] px-3 py-1 rounded-lg text-xs text-slate-500 hover:bg-slate-100 cursor-pointer"
                                  >
                                    Batal
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingBatchId(b.id);
                                    setEditingBatchDate(b.actualExpiryDate || b.effectiveExpiryDate);
                                  }}
                                  className="min-h-[36px] px-3 py-1 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                                >
                                  Ubah Tanggal Kedaluwarsa Kemasan
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="px-5 py-3.5 border-t border-slate-200 flex justify-end">
                <button
                  type="button"
                  onClick={() => setBatchDetailProduct(null)}
                  className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Tutup
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* MODAL PREVIEW IMPORT EXCEL */}
      {importPreview && (
        <div className="fixed inset-0 z-40 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-4xl w-full max-h-[88vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Pratinjau Import Excel ({importPreview.rows.length} Produk Valid)
              </h3>
              <button
                type="button"
                onClick={() => setImportPreview(null)}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              {importPreview.errors.length > 0 && (
                <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
                  <div className="font-semibold">Beberapa baris dilewati:</div>
                  {importPreview.errors.slice(0, 5).map((e, i) => (
                    <div key={i}>{e}</div>
                  ))}
                </div>
              )}

              {importPreview.rows.length === 0 ? (
                <div className="text-sm text-slate-600 text-center py-8">
                  Tidak ada baris produk yang valid untuk diimpor. Gunakan tombol Template Excel
                  sebagai acuan format kolom.
                </div>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <th className="py-2.5 px-3">Kode</th>
                        <th className="py-2.5 px-3">Nama, Merek &amp; Varian</th>
                        <th className="py-2.5 px-3">Kategori</th>
                        <th className="py-2.5 px-3 text-right">HPP</th>
                        <th className="py-2.5 px-3 text-right">Ecer</th>
                        <th className="py-2.5 px-3 text-right">Grosir</th>
                        <th className="py-2.5 px-3 text-right">Stok</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {importPreview.rows.slice(0, 50).map((row) => {
                        const rowDup = checkDuplicateProduct(
                          { name: row.name, brand: row.brand, variant: row.variant, barcode: row.barcode },
                          products
                        );
                        return (
                          <tr key={row.rowIndex} className={rowDup.isDuplicate ? 'bg-red-50' : ''}>
                            <td className="py-2 px-3 font-mono-num">{row.sku}</td>
                            <td className="py-2 px-3 font-medium text-slate-900">
                              <div>{row.name}</div>
                              {(row.brand || row.variant) && (
                                <div className="text-[11px] font-normal text-slate-600">
                                  {[row.brand, row.variant].filter(Boolean).join(' · ')}
                                </div>
                              )}
                              {rowDup.isDuplicate && (
                                <div className="text-[11px] font-bold text-red-700">
                                  PRODUK SUDAH TERDAFTAR
                                </div>
                              )}
                              {row.sellUnits && row.sellUnits.length > 0 && (
                                <div className="text-[11px] font-normal text-slate-500">
                                  {row.sellUnits.map((u) => `${u.unitName}=${u.conversion}`).join(', ')}
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-3">{row.categoryName}</td>
                            <td className="py-2 px-3 text-right font-mono-num">
                              {formatRupiah(row.costPrice)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num">
                              {formatRupiah(row.sellPrice)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num">
                              {row.wholesalePrice !== undefined
                                ? formatRupiah(row.wholesalePrice)
                                : '-'}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num">
                              {row.stock} {row.unit}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setImportPreview(null)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={importingExcel || importPreview.rows.length === 0}
                onClick={handleConfirmExcelImport}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>
                  {importingExcel
                    ? 'Mengimpor...'
                    : `Import ${importPreview.rows.length} Produk`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL PEMINDAI BARCODE */}
      {scannerTarget && (
        <BarcodeScannerModal
          title={scannerTarget === 'form' ? 'Scan Barcode Produk' : 'Cari Produk via Barcode'}
          onDetected={handleBarcodeResult}
          onClose={() => setScannerTarget(null)}
        />
      )}

      {/* MODAL KAMERA FOTO PRODUK */}
      {showCameraModal && (
        <CameraCaptureModal
          onCapture={(dataUrl) => {
            setPhotoDataUrl(dataUrl);
            setShowCameraModal(false);
          }}
          onClose={() => setShowCameraModal(false)}
        />
      )}
    </div>
  );
}
