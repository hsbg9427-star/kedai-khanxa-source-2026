import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileDown,
  Lock,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import type {
  Category,
  Product,
  StockMovement,
  StockOpname,
  StockOpnameItem,
  StockOpnameVarianceStatus,
  StoreSetting,
} from '../types/database';
import {
  createStockOpnameSession,
  deleteDraftStockOpname,
  finalizeStockOpname,
  saveStockOpnameDraft,
  subscribeMovementsDuringOpname,
  subscribeStockOpnameItems,
  subscribeStockOpnames,
  syncMissingProductsToDraft,
  type StockOpnameDraftEdit,
} from '../services/stockOpnameService';
import {
  computeItemVariance,
  computeMovementAdjustedFinalStock,
  computePhysicalStockBase,
  formatSignedStockDifference,
  summarizeOpnameItems,
} from '../utils/stockOpnameMath';
import {
  exportStockOpnamePdf,
  getVarianceStatusLabel,
} from '../utils/stockOpnameExporter';
import { formatQty, formatRupiah } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import {
  formatProductStockSummary,
  formatUnitConversionLabel,
  getProductAllUnitOptions,
  roundQty,
  snapStockToProductPrecision,
} from '../utils/unitConversion';

interface StockOpnamePageProps {
  products: Product[];
  categories: Category[];
  storeSetting: StoreSetting | null;
}

type VarianceFilter = 'all' | 'uncounted' | 'surplus' | 'deficit' | 'match';

export function StockOpnamePage({
  products,
  categories,
  storeSetting,
}: StockOpnamePageProps) {
  const { user, profile, isAdmin } = useAuth();

  const [opnames, setOpnames] = useState<StockOpname[]>([]);
  const [opnamesLoading, setOpnamesLoading] = useState(true);
  const [selectedOpnameId, setSelectedOpnameId] = useState<string | null>(null);
  const [opnameItems, setOpnameItems] = useState<StockOpnameItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [movementsDuringOpname, setMovementsDuringOpname] = useState<StockMovement[]>([]);

  // Edits lokal sebelum Simpan Sementara / Finalisasi
  const [edits, setEdits] = useState<Record<string, StockOpnameDraftEdit>>({});
  const [sessionNotes, setSessionNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [expandedSubUnits, setExpandedSubUnits] = useState<Record<string, boolean>>({});

  // Pencarian & Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [varianceFilter, setVarianceFilter] = useState<VarianceFilter>('all');

  // Modal Buat Sesi Baru
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [creating, setCreating] = useState(false);

  // Aksi Simpan / Finalisasi / Hapus Draft
  const [savingDraft, setSavingDraft] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [confirmFinalizeOpen, setConfirmFinalizeOpen] = useState(false);
  const [confirmDeleteDraft, setConfirmDeleteDraft] = useState<StockOpname | null>(null);
  const [deletingDraft, setDeletingDraft] = useState(false);
  const [syncingNewProducts, setSyncingNewProducts] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const productsById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of products) {
      map.set(p.id, p);
    }
    return map;
  }, [products]);

  const activeOpname = useMemo(
    () => opnames.find((o) => o.id === selectedOpnameId) || null,
    [opnames, selectedOpnameId]
  );

  // Langganan daftar sesi Stok Opname secara real-time (hanya Admin)
  useEffect(() => {
    if (!isAdmin) {
      setOpnames([]);
      setOpnamesLoading(false);
      return;
    }
    setOpnamesLoading(true);
    const unsub = subscribeStockOpnames(
      (list) => {
        setOpnames(list);
        setOpnamesLoading(false);
      },
      (err) => {
        setOpnamesLoading(false);
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
      }
    );
    return () => unsub();
  }, [isAdmin]);

  // Langganan item & pergerakan stok selama opname berlangsung (hanya Admin)
  useEffect(() => {
    if (!isAdmin || !selectedOpnameId) {
      setOpnameItems([]);
      setMovementsDuringOpname([]);
      setEdits({});
      setNotesDirty(false);
      setExpandedSubUnits({});
      return;
    }

    setItemsLoading(true);
    const unsubItems = subscribeStockOpnameItems(
      selectedOpnameId,
      (list) => {
        setOpnameItems(list);
        setItemsLoading(false);
      },
      (err) => {
        setItemsLoading(false);
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
      }
    );

    return () => unsubItems();
  }, [isAdmin, selectedOpnameId]);

  useEffect(() => {
    if (!isAdmin || !activeOpname) {
      setMovementsDuringOpname([]);
      return;
    }
    setSessionNotes(activeOpname.notes || '');
    setNotesDirty(false);

    if (activeOpname.status !== 'draft') {
      setMovementsDuringOpname([]);
      return;
    }

    const unsubMoves = subscribeMovementsDuringOpname(activeOpname.startedAtMs, (moves) => {
      setMovementsDuringOpname(moves);
    });
    return () => unsubMoves();
  }, [isAdmin, activeOpname?.id, activeOpname?.status, activeOpname?.startedAtMs]);

  const canEditSession = Boolean(isAdmin && activeOpname && activeOpname.status === 'draft');

  // Hitung mutasi stok per produk sejak opname dimulai dari log stock_movements
  const movementStatsByProduct = useMemo(() => {
    const map = new Map<string, { count: number; netQty: number }>();
    for (const m of movementsDuringOpname) {
      const signed =
        m.type === 'in'
          ? Number(m.quantity) || 0
          : m.type === 'out'
            ? -(Number(m.quantity) || 0)
            : (Number(m.stockAfter) || 0) - (Number(m.stockBefore) || 0);
      const prev = map.get(m.productId) || { count: 0, netQty: 0 };
      map.set(m.productId, {
        count: prev.count + 1,
        netQty: roundQty(prev.netQty + signed),
      });
    }
    return map;
  }, [movementsDuringOpname]);

  // Hitung state tampilan gabungan (Firestore item + edit lokal + stok live produk)
  const displayRows = useMemo(() => {
    return opnameItems.map((item) => {
      const liveProduct = productsById.get(item.productId);
      const productMeta: Product =
        liveProduct ||
        ({
          id: item.productId,
          sku: item.sku,
          barcode: item.barcode,
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

      const edit = edits[item.productId];
      const liveStock = liveProduct
        ? snapStockToProductPrecision(Math.max(0, Number(liveProduct.stock) || 0), productMeta)
        : item.systemStockAtCount;

      const effectiveIsCounted = edit ? edit.isCounted : item.isCounted;
      const effectiveBaseline = edit
        ? edit.systemStockAtCount
        : item.isCounted
          ? item.systemStockAtCount
          : liveStock;

      const physicalUnitName = edit ? edit.physicalUnitName : item.physicalUnitName;
      const physicalUnitQty = edit ? edit.physicalUnitQty : item.physicalUnitQty;
      const physicalSubUnitName = edit ? edit.physicalSubUnitName : item.physicalSubUnitName;
      const physicalSubUnitQty = edit ? edit.physicalSubUnitQty : item.physicalSubUnitQty;
      const reason = edit ? edit.reason || '' : item.reason || '';

      const physicalStockBase = effectiveIsCounted
        ? computePhysicalStockBase(
            productMeta,
            physicalUnitName,
            physicalUnitQty,
            physicalSubUnitName,
            physicalSubUnitQty
          )
        : undefined;

      const { varianceBase, varianceStatus } = computeItemVariance(
        physicalStockBase,
        effectiveBaseline,
        productMeta
      );

      const movementSinceStart =
        activeOpname?.status === 'finalized'
          ? item.movementSinceStart
          : roundQty(liveStock - item.systemStockAtStart);

      const movementAfterCount =
        activeOpname?.status === 'finalized'
          ? 0
          : effectiveIsCounted
            ? roundQty(liveStock - effectiveBaseline)
            : 0;

      let projectedFinalStock = liveStock;
      let projectionError: string | null = null;
      if (effectiveIsCounted && activeOpname?.status === 'draft') {
        try {
          projectedFinalStock = computeMovementAdjustedFinalStock(
            liveStock,
            varianceBase,
            productMeta
          ).finalStock;
        } catch (err) {
          projectionError = err instanceof Error ? err.message : 'Proyeksi stok negatif';
        }
      } else if (activeOpname?.status === 'finalized' && item.finalStockApplied !== undefined) {
        projectedFinalStock = item.finalStockApplied;
      }

      const liveMoveLog = movementStatsByProduct.get(item.productId);

      return {
        item,
        productMeta,
        liveStock,
        effectiveIsCounted,
        effectiveBaseline,
        physicalUnitName,
        physicalUnitQty,
        physicalSubUnitName,
        physicalSubUnitQty,
        physicalStockBase,
        varianceBase,
        varianceStatus,
        reason,
        movementSinceStart,
        movementAfterCount,
        projectedFinalStock,
        projectionError,
        liveMoveCount: liveMoveLog?.count || 0,
        isDirty: Boolean(edit),
      };
    });
  }, [opnameItems, productsById, edits, activeOpname?.status, movementStatsByProduct]);

  const liveSummary = useMemo(() => {
    return summarizeOpnameItems(
      displayRows.map((r) => ({
        isCounted: r.effectiveIsCounted,
        varianceStatus: r.varianceStatus,
        varianceBase: r.varianceBase,
        costPrice: r.item.costPrice,
      }))
    );
  }, [displayRows]);

  const uncountedCount = Math.max(0, liveSummary.totalProducts - liveSummary.countedProducts);
  const hasUnsavedChanges = Object.keys(edits).length > 0 || notesDirty;

  // Produk aktif baru yang belum masuk ke sesi draft
  const missingProductCount = useMemo(() => {
    if (!activeOpname || activeOpname.status !== 'draft') return 0;
    const existingIds = new Set(opnameItems.map((i) => i.productId));
    return products.filter(
      (p) =>
        p.isActive &&
        (!activeOpname.categoryFilterId || p.categoryId === activeOpname.categoryFilterId) &&
        !existingIds.has(p.id)
    ).length;
  }, [activeOpname, opnameItems, products]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return displayRows.filter((row) => {
      if (categoryFilter && row.item.categoryId !== categoryFilter) {
        return false;
      }
      if (varianceFilter !== 'all' && row.varianceStatus !== varianceFilter) {
        return false;
      }
      if (q) {
        const hay = `${row.item.productName} ${row.item.sku} ${row.item.barcode || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [displayRows, categoryFilter, varianceFilter, searchQuery]);

  // Helper ubah input item opname
  const updateItemEdit = (
    row: (typeof displayRows)[number],
    patch: Partial<StockOpnameDraftEdit>
  ) => {
    if (!canEditSession) return;
    setEdits((prev) => {
      const current: StockOpnameDraftEdit = prev[row.item.productId] || {
        physicalUnitName: row.physicalUnitName,
        physicalUnitQty: row.physicalUnitQty,
        physicalSubUnitName: row.physicalSubUnitName,
        physicalSubUnitQty: row.physicalSubUnitQty,
        systemStockAtCount: row.effectiveBaseline,
        countedAtMs: row.item.countedAtMs,
        reason: row.reason,
        isCounted: row.effectiveIsCounted,
      };
      const next: StockOpnameDraftEdit = {
        ...current,
        ...patch,
      };
      return { ...prev, [row.item.productId]: next };
    });
  };

  const handleOpenCreateModal = () => {
    if (!isAdmin) return;
    const today = new Date().toLocaleDateString('id-ID');
    setNewTitle(`Stok Opname ${today}`);
    setNewCategoryId('');
    setNewNotes('');
    setCreateModalOpen(true);
  };

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isAdmin) return;

    const selectedCat = categories.find((c) => c.id === newCategoryId);
    setCreating(true);
    setFeedback(null);
    try {
      const opnameId = await createStockOpnameSession({
        title: newTitle,
        categoryFilterId: selectedCat?.id,
        categoryFilterName: selectedCat?.name,
        notes: newNotes,
        products,
        user: {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        },
      });
      setCreateModalOpen(false);
      setSelectedOpnameId(opnameId);
      setFeedback({
        kind: 'ok',
        text: 'Sesi stok opname berhasil dibuat. Stok sistem tetap aman dan belum berubah sebelum finalisasi.',
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text:
          err instanceof Error && !err.message.startsWith('{')
            ? err.message
            : getReadableFirestoreError(err),
      });
    } finally {
      setCreating(false);
    }
  };

  const handleSyncMissingProducts = async () => {
    if (!user || !isAdmin || !activeOpname || activeOpname.status !== 'draft') return;
    setSyncingNewProducts(true);
    try {
      const added = await syncMissingProductsToDraft({
        opname: activeOpname,
        existingItems: opnameItems,
        products,
        user: {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        },
      });
      setFeedback({
        kind: 'ok',
        text:
          added > 0
            ? `${added} produk baru berhasil ditambahkan ke daftar opname.`
            : 'Semua produk aktif sudah ada di dalam daftar opname.',
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSyncingNewProducts(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!isAdmin || !activeOpname || activeOpname.status !== 'draft') return;
    setSavingDraft(true);
    setFeedback(null);
    try {
      await saveStockOpnameDraft({
        opname: activeOpname,
        items: opnameItems,
        edits,
        productsById,
        notes: sessionNotes,
      });
      setEdits({});
      setNotesDirty(false);
      setFeedback({
        kind: 'ok',
        text: 'Hasil sementara stok opname berhasil disimpan ke database. Anda dapat melanjutkannya kapan saja.',
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text:
          err instanceof Error && !err.message.startsWith('{')
            ? err.message
            : getReadableFirestoreError(err),
      });
    } finally {
      setSavingDraft(false);
    }
  };

  const handleFinalize = async () => {
    if (!user || !isAdmin || !activeOpname || activeOpname.status !== 'draft') return;
    setFinalizing(true);
    setFeedback(null);
    try {
      const result = await finalizeStockOpname({
        opname: activeOpname,
        items: opnameItems,
        edits,
        productsById,
        notes: sessionNotes,
        user: {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        },
      });
      setEdits({});
      setNotesDirty(false);
      setConfirmFinalizeOpen(false);
      setFeedback({
        kind: 'ok',
        text: `Stok opname selesai difinalisasi! ${result.adjustedCount} produk disesuaikan stoknya (${result.surplusCount} selisih lebih, ${result.deficitCount} selisih kurang, ${result.matchedCount} cocok) dan tersinkronisasi ke Kasir.`,
      });
    } catch (err) {
      setConfirmFinalizeOpen(false);
      setFeedback({
        kind: 'err',
        text:
          err instanceof Error && !err.message.startsWith('{')
            ? err.message
            : getReadableFirestoreError(err),
      });
    } finally {
      setFinalizing(false);
    }
  };

  const handleDeleteDraft = async () => {
    if (!isAdmin || !confirmDeleteDraft || confirmDeleteDraft.status !== 'draft') return;
    setDeletingDraft(true);
    try {
      await deleteDraftStockOpname(confirmDeleteDraft.id);
      if (selectedOpnameId === confirmDeleteDraft.id) {
        setSelectedOpnameId(null);
      }
      setConfirmDeleteDraft(null);
      setFeedback({
        kind: 'ok',
        text: 'Draft stok opname berhasil dibatalkan dan dihapus tanpa mengubah stok produk.',
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setDeletingDraft(false);
    }
  };

  const handlePrintReport = () => {
    if (!activeOpname || typeof document === 'undefined') return;
    document.body.classList.add('opname-print-mode');
    const cleanup = () => {
      document.body.classList.remove('opname-print-mode');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  };

  const handleDownloadPdf = () => {
    if (!activeOpname) return;
    const mergedOpname: StockOpname = {
      ...activeOpname,
      ...liveSummary,
      notes: sessionNotes,
    };
    const mergedItems: StockOpnameItem[] = displayRows.map((r) => ({
      ...r.item,
      systemStockAtCount: r.effectiveBaseline,
      movementSinceStart: r.movementSinceStart,
      physicalUnitName: r.physicalUnitName,
      physicalUnitQty: r.physicalUnitQty,
      physicalSubUnitName: r.physicalSubUnitName,
      physicalSubUnitQty: r.physicalSubUnitQty,
      physicalStockBase: r.physicalStockBase,
      varianceBase: r.varianceBase,
      varianceStatus: r.varianceStatus,
      finalStockApplied:
        activeOpname.status === 'finalized' ? r.item.finalStockApplied : r.projectedFinalStock,
      reason: r.reason,
      isCounted: r.effectiveIsCounted,
    }));

    exportStockOpnamePdf({
      opname: mergedOpname,
      items: mergedItems,
      productsById,
      storeSetting,
    });
  };

  const renderVarianceLabel = (
    status: StockOpnameVarianceStatus,
    varianceBase: number,
    productMeta: Product
  ) => {
    if (status === 'uncounted') {
      return <span className="text-xs text-slate-400">Belum dihitung</span>;
    }
    if (status === 'match') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 font-mono-num tabular-nums">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span>Stok Cocok (0)</span>
        </span>
      );
    }
    if (status === 'surplus') {
      return (
        <span className="text-xs font-semibold text-emerald-700 font-mono-num tabular-nums">
          Selisih Lebih ({formatSignedStockDifference(varianceBase, productMeta)})
        </span>
      );
    }
    return (
      <span className="text-xs font-semibold text-red-700 font-mono-num tabular-nums">
        Selisih Kurang ({formatSignedStockDifference(varianceBase, productMeta)})
      </span>
    );
  };

  if (!isAdmin) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>
          Akses ditolak. Modul Stok Opname dan Penyesuaian Persediaan hanya dapat diakses oleh Admin.
        </span>
      </div>
    );
  }

  // ============================================================================
  // VIEW 1: DAFTAR SESI STOK OPNAME
  // ============================================================================
  if (!activeOpname) {
    return (
      <div className="space-y-6 max-w-6xl mx-auto">
        {feedback && (
          <div
            className={`p-4 rounded-xl border text-sm flex items-start justify-between gap-3 ${
              feedback.kind === 'ok'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-red-50 border-red-200 text-red-700'
            }`}
          >
            <div>{feedback.text}</div>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-slate-400 hover:text-slate-600 shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Header Aksi */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display font-bold text-lg text-slate-900">
              Stok Opname Fisik Barang
            </h2>
            <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
              Cocokkan stok fisik di rak dengan catatan sistem dalam semua satuan produk. Stok produk hanya diperbarui saat Admin menekan finalisasi, dan transaksi kasir/kulakan yang berjalan selama opname otomatis diperhitungkan.
            </p>
          </div>

          {isAdmin ? (
            <button
              type="button"
              onClick={handleOpenCreateModal}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Mulai Stok Opname Baru</span>
            </button>
          ) : (
            <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-medium shrink-0">
              <Lock className="w-3.5 h-3.5 text-slate-500" />
              <span>Mode Lihat Saja (Khusus Admin untuk Mengubah)</span>
            </div>
          )}
        </div>

        {!isAdmin && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <span>
              Akun Kasir tidak dapat membuat, mengubah, menyetujui, atau memfinalisasi stok opname. Anda dapat membuka hasil stok opname yang tersinkronisasi untuk memantau laporan dan pencocokan stok.
            </span>
          </div>
        )}

        {/* Daftar Sesi Opname */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <h3 className="font-display font-semibold text-sm text-slate-900">
              Riwayat &amp; Draft Stok Opname
            </h3>
            <span className="text-xs text-slate-500 font-mono-num tabular-nums">
              {opnames.length} sesi tersimpan
            </span>
          </div>

          {opnamesLoading ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Memuat data stok opname dari server...
            </div>
          ) : opnames.length === 0 ? (
            <div className="p-10 text-center space-y-3">
              <ClipboardCheck className="w-8 h-8 text-slate-300 mx-auto" />
              <div className="text-sm font-medium text-slate-800">
                Belum ada sesi stok opname
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                {isAdmin
                  ? 'Mulai stok opname baru untuk memeriksa kecocokan stok fisik barang di KEDAI KHANXA.'
                  : 'Belum ada stok opname yang dibuat oleh Admin.'}
              </p>
              {isAdmin && (
                <button
                  type="button"
                  onClick={handleOpenCreateModal}
                  className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Mulai Stok Opname Pertama</span>
                </button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {opnames.map((opn) => {
                const isDraft = opn.status === 'draft';
                return (
                  <div
                    key={opn.id}
                    className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 hover:bg-slate-50/70 transition-colors"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono-num font-semibold text-slate-700">
                          {opn.transactionNumber}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`font-semibold ${
                            isDraft ? 'text-amber-700' : 'text-emerald-700'
                          }`}
                        >
                          {isDraft ? 'Draft (Simpan Sementara)' : 'Selesai / Difinalisasi'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{opn.categoryFilterName || 'Semua Kategori'}</span>
                      </div>

                      <div className="font-display font-semibold text-base text-slate-900 truncate">
                        {opn.title}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 font-mono-num tabular-nums">
                        <span>
                          Diperiksa: <strong>{opn.countedProducts}</strong>/{opn.totalProducts}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Cocok: <strong>{opn.matchedCount}</strong>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="text-emerald-700">
                          Lebih: <strong>{opn.surplusCount}</strong>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="text-red-700">
                          Kurang: <strong>{opn.deficitCount}</strong>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Nilai selisih: <strong>{formatRupiah(opn.totalVarianceValue)}</strong>
                        </span>
                      </div>

                      <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>
                          Mulai: {opn.transactionDate} {opn.transactionTime} ({opn.recordedByName})
                        </span>
                        {opn.finalizedDate && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              Finalisasi: {opn.finalizedDate} {opn.finalizedTime} (
                              {opn.finalizedByName || opn.recordedByName})
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setSelectedOpnameId(opn.id)}
                        className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium whitespace-nowrap cursor-pointer ${
                          isDraft && isAdmin
                            ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                            : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                        }`}
                      >
                        <ClipboardCheck className="w-4 h-4" />
                        <span>
                          {isDraft && isAdmin
                            ? 'Lanjutkan Opname'
                            : 'Lihat Hasil & Laporan'}
                        </span>
                      </button>

                      {isDraft && isAdmin && (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDraft(opn)}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 text-xs font-medium cursor-pointer"
                          title="Hapus Draft Opname"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Buat Sesi Stok Opname Baru */}
        {createModalOpen && isAdmin && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
            <form
              onSubmit={handleCreateSession}
              className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display font-bold text-base text-slate-900">
                    Buat Sesi Stok Opname Baru
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Pilih ruang lingkup produk yang akan diperiksa fisiknya.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label htmlFor="opn-title" className="block text-xs font-medium text-slate-700">
                    Judul / Nama Sesi Opname
                  </label>
                  <input
                    id="opn-title"
                    type="text"
                    required
                    maxLength={120}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Contoh: Stok Opname Mingguan"
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="opn-cat" className="block text-xs font-medium text-slate-700">
                    Kategori Produk
                  </label>
                  <select
                    id="opn-cat"
                    value={newCategoryId}
                    onChange={(e) => setNewCategoryId(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    <option value="">Semua Kategori Produk Aktif</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="opn-notes" className="block text-xs font-medium text-slate-700">
                    Catatan Opname (Opsional)
                  </label>
                  <textarea
                    id="opn-notes"
                    rows={2}
                    maxLength={300}
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    placeholder="Misal: Pemeriksaan rak rokok dan minuman..."
                    className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 leading-relaxed">
                  Stok di kasir dan produk <strong>tidak berubah</strong> saat sesi dibuat. Penyesuaian hanya terjadi setelah Anda menekan tombol Finalisasi.
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  disabled={creating}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="min-h-[44px] px-5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                >
                  {creating ? 'Membuat Sesi...' : 'Buat & Mulai Opname'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Modal Konfirmasi Hapus Draft */}
        {confirmDeleteDraft && isAdmin && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-red-300 max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl">
              <h3 className="font-display font-bold text-base text-red-900">
                Hapus Draft Stok Opname?
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Draft <strong>{confirmDeleteDraft.title}</strong> ({confirmDeleteDraft.transactionNumber}) akan dihapus. Stok produk tidak terpengaruh karena sesi ini belum difinalisasi.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setConfirmDeleteDraft(null)}
                  disabled={deletingDraft}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleDeleteDraft}
                  disabled={deletingDraft}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-red-700 text-white text-xs font-medium hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                >
                  {deletingDraft ? 'Menghapus...' : 'Ya, Hapus Draft'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ============================================================================
  // VIEW 2: DETAIL / LEMBAR KERJA STOK OPNAME
  // ============================================================================
  const isDraft = activeOpname.status === 'draft';
  const itemsWithLiveMovements = displayRows.filter(
    (r) => Math.abs(r.movementSinceStart) > 1e-5 || Math.abs(r.movementAfterCount) > 1e-5
  );

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      {feedback && (
        <div
          className={`p-4 rounded-xl border text-sm flex items-start justify-between gap-3 ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <div>{feedback.text}</div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-600 shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header Lembar Kerja */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <button
              type="button"
              onClick={() => setSelectedOpnameId(null)}
              className="min-h-[40px] inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer -ml-1 px-1"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Kembali ke Daftar Stok Opname</span>
            </button>

            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-mono-num font-semibold text-slate-700">
                {activeOpname.transactionNumber}
              </span>
              <span aria-hidden="true">·</span>
              <span
                className={`font-semibold ${
                  isDraft ? 'text-amber-700' : 'text-emerald-700'
                }`}
              >
                {isDraft ? 'Draft (Simpan Sementara)' : 'Final (Stok Sudah Disesuaikan)'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{activeOpname.categoryFilterName || 'Semua Kategori'}</span>
            </div>

            <h2 className="font-display font-bold text-lg sm:text-xl text-slate-900">
              {activeOpname.title}
            </h2>

            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                Mulai: {activeOpname.transactionDate} {activeOpname.transactionTime} · Admin:{' '}
                <strong className="text-slate-700">{activeOpname.recordedByName}</strong>
              </span>
              {activeOpname.finalizedDate && (
                <span>
                  · Finalisasi: {activeOpname.finalizedDate} {activeOpname.finalizedTime} · oleh{' '}
                  <strong className="text-slate-700">
                    {activeOpname.finalizedByName || activeOpname.recordedByName}
                  </strong>
                </span>
              )}
            </div>
          </div>

          {/* Tombol Aksi */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handlePrintReport}
              className="min-h-[44px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              <span>Cetak Laporan</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadPdf}
              className="min-h-[44px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              <FileDown className="w-4 h-4" />
              <span>Unduh PDF</span>
            </button>

            {canEditSession && missingProductCount > 0 && (
              <button
                type="button"
                onClick={handleSyncMissingProducts}
                disabled={syncingNewProducts}
                className="min-h-[44px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-amber-300 bg-amber-50 text-xs font-medium text-amber-800 hover:bg-amber-100 whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncingNewProducts ? 'animate-spin' : ''}`} />
                <span>+{missingProductCount} Produk Baru</span>
              </button>
            )}

            {canEditSession && (
              <>
                <button
                  type="button"
                  onClick={handleSaveDraft}
                  disabled={savingDraft || finalizing}
                  className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-700 text-emerald-700 bg-white text-xs font-medium hover:bg-emerald-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                >
                  <Save className="w-4 h-4" />
                  <span>
                    {savingDraft
                      ? 'Menyimpan...'
                      : hasUnsavedChanges
                        ? 'Simpan Sementara *'
                        : 'Simpan Sementara'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmFinalizeOpen(true)}
                  disabled={savingDraft || finalizing || liveSummary.countedProducts === 0}
                  className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>Finalisasi Stok</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Info Banner untuk Kasir atau saat ada Mutasi Selama Opname */}
        {!isAdmin && (
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 flex items-center gap-2">
            <Lock className="w-4 h-4 text-slate-500 shrink-0" />
            <span>
              Mode Lihat Saja: Hanya Admin yang dapat mengubah hitungan fisik, menyimpan draft, atau memfinalisasi stok opname.
            </span>
          </div>
        )}

        {isDraft && itemsWithLiveMovements.length > 0 && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
            <Clock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <span>
              Terdeteksi pergerakan stok dari transaksi penjualan/pembelian pada{' '}
              <strong>{itemsWithLiveMovements.length} produk</strong> selama sesi opname berjalan. Sistem otomatis memperhitungkan seluruh mutasi tersebut saat finalisasi agar stok akhir tetap akurat.
            </span>
          </div>
        )}
      </div>

      {/* Ringkasan KPI (4 Kolom Tabular) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Produk Diperiksa</div>
          <div className="text-xl font-bold text-slate-900 font-mono-num tabular-nums">
            {liveSummary.countedProducts}{' '}
            <span className="text-sm font-normal text-slate-500">/ {liveSummary.totalProducts}</span>
          </div>
          <div className="text-[11px] text-slate-500 font-mono-num tabular-nums">
            {uncountedCount} belum diisi
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Stok Cocok</div>
          <div className="text-xl font-bold text-slate-900 font-mono-num tabular-nums">
            {liveSummary.matchedCount}
          </div>
          <div className="text-[11px] text-slate-500">Selisih 0 sesuai sistem</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Selisih Lebih / Kurang</div>
          <div className="text-xl font-bold font-mono-num tabular-nums flex items-baseline gap-2">
            <span className="text-emerald-700">+{liveSummary.surplusCount}</span>
            <span className="text-slate-300 text-sm">/</span>
            <span className="text-red-700">-{liveSummary.deficitCount}</span>
          </div>
          <div className="text-[11px] text-slate-500">Item lebih / kurang</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-500">Estimasi Nilai Selisih</div>
          <div
            className={`text-xl font-bold font-mono-num tabular-nums ${
              liveSummary.totalVarianceValue > 0
                ? 'text-emerald-700'
                : liveSummary.totalVarianceValue < 0
                  ? 'text-red-700'
                  : 'text-slate-900'
            }`}
          >
            {liveSummary.totalVarianceValue > 0 ? '+' : ''}
            {formatRupiah(liveSummary.totalVarianceValue)}
          </div>
          <div className="text-[11px] text-slate-500">Berdasarkan harga modal</div>
        </div>
      </div>

      {/* Filter & Pencarian */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama produk, kode produk (SKU), atau barcode..."
              className="w-full min-h-[44px] pl-10 pr-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>

          <div className="md:col-span-3">
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              <option value="">Semua Kategori</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <input
              type="text"
              disabled={!canEditSession}
              maxLength={300}
              value={sessionNotes}
              onChange={(e) => {
                setSessionNotes(e.target.value);
                setNotesDirty(true);
              }}
              placeholder="Catatan sesi opname..."
              className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>
        </div>

        {/* Segmented Filter Status Selisih */}
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 rounded-lg">
          {(
            [
              { id: 'all', label: `Semua (${liveSummary.totalProducts})` },
              { id: 'uncounted', label: `Belum Diisi (${uncountedCount})` },
              { id: 'surplus', label: `Selisih Lebih (${liveSummary.surplusCount})` },
              { id: 'deficit', label: `Selisih Kurang (${liveSummary.deficitCount})` },
              { id: 'match', label: `Stok Cocok (${liveSummary.matchedCount})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setVarianceFilter(tab.id)}
              className={`min-h-[36px] px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                varianceFilter === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Daftar Produk Opname */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {itemsLoading ? (
          <div className="p-8 text-center text-xs text-slate-500">
            Memuat daftar produk stok opname...
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            Tidak ada produk yang cocok dengan pencarian atau filter yang dipilih.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {filteredRows.map((row) => {
              const unitOptions = getProductAllUnitOptions(row.productMeta);
              const hasMultipleUnits = unitOptions.length > 1;
              const subUnitExpanded =
                Boolean(expandedSubUnits[row.item.productId]) ||
                Boolean(row.physicalSubUnitName && Number(row.physicalSubUnitQty) > 0);
              const systemSummary = formatProductStockSummary(row.liveStock, row.productMeta);
              const baselineSummary = formatProductStockSummary(
                row.effectiveBaseline,
                row.productMeta
              );
              const hasBaselineShift =
                isDraft &&
                row.effectiveIsCounted &&
                Math.abs(row.movementAfterCount) > 1e-5;

              return (
                <div
                  key={row.item.id}
                  className="p-4 sm:p-5 space-y-3 hover:bg-slate-50/40 transition-colors"
                >
                  {/* Baris Atas: Identitas Produk + Status Selisih */}
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono-num text-slate-700 font-medium">
                          {row.item.sku}
                        </span>
                        {row.item.barcode && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-num">{row.item.barcode}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>{row.item.categoryName}</span>
                        <span aria-hidden="true">·</span>
                        <span>Dasar: {row.item.baseUnit}</span>
                      </div>

                      <div className="font-display font-semibold text-sm sm:text-base text-slate-900">
                        {row.item.productName}
                      </div>
                    </div>

                    <div className="shrink-0">
                      {renderVarianceLabel(row.varianceStatus, row.varianceBase, row.productMeta)}
                    </div>
                  </div>

                  {/* Baris Grid Kontrol (Stok Sistem, Input Fisik, Keterangan) */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-4 items-start">
                    {/* Kolom 1: Stok Menurut Sistem */}
                    <div className="lg:col-span-3 p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1 text-xs">
                      <div className="text-slate-500">
                        {isDraft ? 'Stok Sistem Saat Ini' : 'Stok Sistem Saat Hitung'}
                      </div>
                      <div className="font-mono-num font-bold text-sm text-slate-900 tabular-nums">
                        {isDraft ? systemSummary.primary : baselineSummary.primary}
                      </div>
                      {isDraft && systemSummary.secondary && (
                        <div className="text-[11px] text-slate-500 font-mono-num">
                          Setara {systemSummary.secondary}
                        </div>
                      )}

                      {isDraft && Math.abs(row.movementSinceStart) > 1e-5 && (
                        <div className="text-[11px] text-amber-800 pt-1 border-t border-slate-200 font-mono-num">
                          Awal opname: {formatQty(row.item.systemStockAtStart)} {row.item.baseUnit} · Mutasi:{' '}
                          {row.movementSinceStart > 0 ? '+' : ''}
                          {formatQty(row.movementSinceStart)} {row.item.baseUnit}
                          {row.liveMoveCount > 0 ? ` (${row.liveMoveCount} trx)` : ''}
                        </div>
                      )}

                      {!isDraft && row.item.finalStockApplied !== undefined && (
                        <div className="text-[11px] text-emerald-800 pt-1 border-t border-slate-200 font-mono-num">
                          Stok Akhir Diterapkan:{' '}
                          <strong>
                            {formatQty(row.item.finalStockApplied)} {row.item.baseUnit}
                          </strong>
                        </div>
                      )}
                    </div>

                    {/* Kolom 2: Input Stok Fisik Multi-Satuan */}
                    <div className="lg:col-span-5 space-y-2">
                      {canEditSession ? (
                        <>
                          <div className="flex flex-col sm:flex-row gap-2">
                            <div className="flex-1 flex gap-2">
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={row.effectiveIsCounted ? row.physicalUnitQty : ''}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  if (raw === '') {
                                    updateItemEdit(row, {
                                      physicalUnitQty: 0,
                                      physicalSubUnitQty: 0,
                                      isCounted: false,
                                      systemStockAtCount: row.liveStock,
                                      countedAtMs: undefined,
                                    });
                                    return;
                                  }
                                  const num = Math.max(0, Number(raw) || 0);
                                  updateItemEdit(row, {
                                    physicalUnitQty: num,
                                    isCounted: true,
                                    systemStockAtCount: row.effectiveIsCounted
                                      ? row.effectiveBaseline
                                      : row.liveStock,
                                    countedAtMs: row.item.countedAtMs || Date.now(),
                                  });
                                }}
                                placeholder="Isi stok fisik..."
                                aria-label={`Stok fisik ${row.item.productName}`}
                                className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-600"
                              />

                              <select
                                value={row.physicalUnitName}
                                onChange={(e) =>
                                  updateItemEdit(row, {
                                    physicalUnitName: e.target.value,
                                  })
                                }
                                aria-label={`Satuan ${row.item.productName}`}
                                className="min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                              >
                                {unitOptions.map((opt) => (
                                  <option key={opt.unitName} value={opt.unitName}>
                                    {opt.unitName} ({formatUnitConversionLabel(opt, row.item.baseUnit)})
                                  </option>
                                ))}
                              </select>
                            </div>

                            <button
                              type="button"
                              onClick={() => {
                                updateItemEdit(row, {
                                  physicalUnitName: row.item.baseUnit,
                                  physicalUnitQty: row.liveStock,
                                  physicalSubUnitName: undefined,
                                  physicalSubUnitQty: 0,
                                  isCounted: true,
                                  systemStockAtCount: row.liveStock,
                                  countedAtMs: Date.now(),
                                });
                              }}
                              className="min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                            >
                              Sesuai Sistem
                            </button>
                          </div>

                          {/* Input Satuan Tambahan / Eceran (Opsional, misal 9 Bungkus + 17 Batang) */}
                          {hasMultipleUnits && (
                            <div className="space-y-1.5">
                              {!subUnitExpanded ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedSubUnits((prev) => ({
                                      ...prev,
                                      [row.item.productId]: true,
                                    }))
                                  }
                                  className="text-[11px] font-medium text-emerald-700 hover:underline cursor-pointer"
                                >
                                  + Tambah pecahan satuan lain (misal bungkus + batang)
                                </button>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-slate-500 font-bold">+</span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    value={row.physicalSubUnitQty || ''}
                                    onChange={(e) => {
                                      const num = Math.max(0, Number(e.target.value) || 0);
                                      const defaultSub =
                                        unitOptions.find(
                                          (o) =>
                                            o.unitName.toUpperCase() !==
                                            row.physicalUnitName.toUpperCase()
                                        )?.unitName || row.item.baseUnit;
                                      updateItemEdit(row, {
                                        physicalSubUnitName: row.physicalSubUnitName || defaultSub,
                                        physicalSubUnitQty: num,
                                        isCounted: true,
                                        systemStockAtCount: row.effectiveIsCounted
                                          ? row.effectiveBaseline
                                          : row.liveStock,
                                        countedAtMs: row.item.countedAtMs || Date.now(),
                                      });
                                    }}
                                    placeholder="Qty pecahan..."
                                    className="w-28 min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono-num tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-600"
                                  />
                                  <select
                                    value={
                                      row.physicalSubUnitName ||
                                      unitOptions.find(
                                        (o) =>
                                          o.unitName.toUpperCase() !==
                                          row.physicalUnitName.toUpperCase()
                                      )?.unitName ||
                                      row.item.baseUnit
                                    }
                                    onChange={(e) =>
                                      updateItemEdit(row, {
                                        physicalSubUnitName: e.target.value,
                                      })
                                    }
                                    className="min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                                  >
                                    {unitOptions
                                      .filter(
                                        (o) =>
                                          o.unitName.toUpperCase() !==
                                          row.physicalUnitName.toUpperCase()
                                      )
                                      .map((opt) => (
                                        <option key={opt.unitName} value={opt.unitName}>
                                          {opt.unitName}
                                        </option>
                                      ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setExpandedSubUnits((prev) => ({
                                        ...prev,
                                        [row.item.productId]: false,
                                      }));
                                      updateItemEdit(row, {
                                        physicalSubUnitName: undefined,
                                        physicalSubUnitQty: 0,
                                      });
                                    }}
                                    className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                                    title="Tutup pecahan"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Konversi Total Fisik & Proyeksi Mutasi */}
                          {row.effectiveIsCounted && row.physicalStockBase !== undefined && (
                            <div className="text-[11px] text-slate-600 font-mono-num space-y-0.5">
                              <div>
                                Total fisik:{' '}
                                <strong>
                                  {formatQty(row.physicalStockBase)} {row.item.baseUnit}
                                </strong>
                              </div>
                              {hasBaselineShift && (
                                <div className="text-amber-800 space-y-1">
                                  <div>
                                    Dihitung saat sistem {formatQty(row.effectiveBaseline)} · Mutasi
                                    setelah hitung: {row.movementAfterCount > 0 ? '+' : ''}
                                    {formatQty(row.movementAfterCount)} · Proyeksi stok akhir:{' '}
                                    <strong>
                                      {formatQty(row.projectedFinalStock)} {row.item.baseUnit}
                                    </strong>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateItemEdit(row, {
                                        systemStockAtCount: row.liveStock,
                                        countedAtMs: Date.now(),
                                      })
                                    }
                                    className="text-emerald-700 font-sans font-medium underline cursor-pointer"
                                  >
                                    Perbarui baseline ke stok sistem sekarang (
                                    {formatQty(row.liveStock)})
                                  </button>
                                </div>
                              )}
                              {row.projectionError && (
                                <div className="text-red-700 font-sans font-medium">
                                  {row.projectionError}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                          <div className="text-slate-500">Hasil Hitung Fisik</div>
                          {row.effectiveIsCounted ? (
                            <div className="font-mono-num font-semibold text-slate-900">
                              {formatQty(row.physicalUnitQty)} {row.physicalUnitName}
                              {row.physicalSubUnitName && Number(row.physicalSubUnitQty) > 0
                                ? ` + ${formatQty(Number(row.physicalSubUnitQty || 0))} ${row.physicalSubUnitName}`
                                : ''}{' '}
                              <span className="text-slate-500 font-normal">
                                ({formatQty(row.physicalStockBase ?? 0)} {row.item.baseUnit})
                              </span>
                            </div>
                          ) : (
                            <div className="text-slate-400">Belum dihitung</div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Kolom 3: Keterangan / Alasan Selisih */}
                    <div className="lg:col-span-4 space-y-1">
                      <label className="block text-[11px] font-medium text-slate-500 lg:sr-only">
                        Keterangan / Alasan Selisih
                      </label>
                      <input
                        type="text"
                        disabled={!canEditSession}
                        maxLength={240}
                        value={row.reason}
                        onChange={(e) => updateItemEdit(row, { reason: e.target.value })}
                        placeholder={
                          canEditSession
                            ? 'Alasan selisih (misal: barang rusak, susut, bonus)...'
                            : 'Tidak ada keterangan'
                        }
                        className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-xs disabled:bg-slate-50 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal Konfirmasi Finalisasi (Admin) */}
      {confirmFinalizeOpen && canEditSession && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display font-bold text-base text-slate-900">
                  Konfirmasi Finalisasi Stok Opname
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{activeOpname.title}</p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmFinalizeOpen(false)}
                disabled={finalizing}
                className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5 font-mono-num tabular-nums">
                <div className="flex justify-between">
                  <span className="text-slate-600">Produk dihitung:</span>
                  <strong>
                    {liveSummary.countedProducts} dari {liveSummary.totalProducts} produk
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Stok cocok (tanpa perubahan):</span>
                  <strong>{liveSummary.matchedCount} produk</strong>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>Selisih lebih (stok bertambah):</span>
                  <strong>{liveSummary.surplusCount} produk</strong>
                </div>
                <div className="flex justify-between text-red-700">
                  <span>Selisih kurang (stok berkurang):</span>
                  <strong>{liveSummary.deficitCount} produk</strong>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-slate-200">
                  <span className="text-slate-700 font-semibold">Estimasi nilai selisih:</span>
                  <strong>{formatRupiah(liveSummary.totalVarianceValue)}</strong>
                </div>
              </div>

              {uncountedCount > 0 && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
                  <strong>{uncountedCount} produk</strong> belum diisi stok fisiknya. Stok produk yang belum diisi tidak akan diubah.
                </div>
              )}

              {itemsWithLiveMovements.length > 0 && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 space-y-1">
                  <div className="font-semibold">
                    Penyesuaian Otomatis Transaksi Berjalan ({itemsWithLiveMovements.length} produk):
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    Transaksi penjualan dan pembelian yang terjadi sejak opname dimulai tetap dipertahankan dan dihitung otomatis ke stok akhir saat tombol di bawah diklik.
                  </p>
                </div>
              )}

              <p className="text-slate-600 leading-relaxed">
                Setelah difinalisasi, hasil opname akan dikunci permanen sebagai riwayat audit dan stok produk di Kasir serta Produk &amp; Stok akan langsung tersinkronisasi.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setConfirmFinalizeOpen(false)}
                disabled={finalizing}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Periksa Lagi
              </button>
              <button
                type="button"
                onClick={handleFinalize}
                disabled={finalizing}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{finalizing ? 'Memfinalisasi...' : 'Ya, Finalisasi & Perbarui Stok'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Portal Cetak Laporan A4 via window.print() */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div id="opname-report-print-portal" className="text-slate-900 text-xs">
            <div className="border-b-2 border-slate-800 pb-3 mb-4">
              <h1 className="text-lg font-bold uppercase">
                LAPORAN HASIL STOK OPNAME — {storeSetting?.storeName || 'KEDAI KHANXA'}
              </h1>
              <div className="mt-1 text-[11px] space-y-0.5">
                <div>
                  No. Opname: <strong>{activeOpname.transactionNumber}</strong> · Judul:{' '}
                  <strong>{activeOpname.title}</strong> · Status:{' '}
                  <strong>{isDraft ? 'DRAFT' : 'FINAL'}</strong>
                </div>
                <div>
                  Mulai: {activeOpname.transactionDate} {activeOpname.transactionTime} ({activeOpname.recordedByName})
                  {activeOpname.finalizedDate
                    ? ` · Finalisasi: ${activeOpname.finalizedDate} ${activeOpname.finalizedTime} (${
                        activeOpname.finalizedByName || activeOpname.recordedByName
                      })`
                    : ''}
                </div>
                <div>
                  Diperiksa: {liveSummary.countedProducts}/{liveSummary.totalProducts} · Cocok:{' '}
                  {liveSummary.matchedCount} · Lebih: {liveSummary.surplusCount} · Kurang:{' '}
                  {liveSummary.deficitCount} · Nilai Selisih:{' '}
                  {formatRupiah(liveSummary.totalVarianceValue)}
                </div>
              </div>
            </div>

            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr className="bg-slate-100">
                  <th className="border border-slate-300 px-2 py-1 text-center">No</th>
                  <th className="border border-slate-300 px-2 py-1 text-left">Kode</th>
                  <th className="border border-slate-300 px-2 py-1 text-left">Produk</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Stok Sistem</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Mutasi Opname</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Stok Fisik</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Selisih</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Stok Akhir</th>
                  <th className="border border-slate-300 px-2 py-1 text-left">Status</th>
                  <th className="border border-slate-300 px-2 py-1 text-left">Keterangan</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, idx) => (
                  <tr key={row.item.id}>
                    <td className="border border-slate-300 px-2 py-1 text-center">{idx + 1}</td>
                    <td className="border border-slate-300 px-2 py-1 font-mono">{row.item.sku}</td>
                    <td className="border border-slate-300 px-2 py-1">{row.item.productName}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right font-mono">
                      {formatQty(row.effectiveBaseline)} {row.item.baseUnit}
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-right font-mono">
                      {row.movementSinceStart > 0 ? '+' : ''}
                      {formatQty(row.movementSinceStart)} {row.item.baseUnit}
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-right font-mono">
                      {row.effectiveIsCounted
                        ? `${formatQty(row.physicalStockBase ?? 0)} ${row.item.baseUnit}`
                        : '-'}
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-right font-mono">
                      {row.effectiveIsCounted
                        ? formatSignedStockDifference(row.varianceBase, row.productMeta)
                        : '-'}
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-right font-mono">
                      {row.effectiveIsCounted
                        ? `${formatQty(row.projectedFinalStock)} ${row.item.baseUnit}`
                        : '-'}
                    </td>
                    <td className="border border-slate-300 px-2 py-1">
                      {getVarianceStatusLabel(row.varianceStatus)}
                    </td>
                    <td className="border border-slate-300 px-2 py-1">{row.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {sessionNotes && (
              <div className="mt-3 text-[11px]">
                <strong>Catatan Sesi:</strong> {sessionNotes}
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
