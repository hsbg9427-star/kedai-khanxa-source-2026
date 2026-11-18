import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertCircle,
  Building2,
  Calendar,
  CheckCircle2,
  CreditCard,
  Edit3,
  Eye,
  FileSpreadsheet,
  PackagePlus,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  Trash2,
  TrendingUp,
  Truck,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import type {
  Account,
  PriceHistory,
  Product,
  Purchase,
  PurchaseItem,
  PurchaseReturn,
  StockMovement,
  StoreSetting,
  Supplier,
  SupplierPayment,
} from '../types/database';
import {
  createSupplier,
  deleteSupplier,
  fetchPurchaseItems,
  recordPurchaseReturn,
  recordPurchaseTransaction,
  recordSupplierDebtPayment,
  subscribePurchases,
  subscribePurchaseReturns,
  subscribeSupplierPayments,
  subscribeSuppliers,
  updateSupplier,
} from '../services/purchaseService';
import { subscribePriceHistory, subscribeStockMovements } from '../services/inventoryService';
import {
  formatQty,
  formatRupiah,
  getAccountTypeLabel,
  getTodayDateString,
} from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import {
  buildPurchaseReportSummary,
  calculatePurchaseSettlement,
  computePurchaseDraft,
  computePurchaseReturnPlan,
  getPurchaseDebtAmount,
  getPurchasePaymentStatus,
  roundUnitCost,
  type PurchasePaymentMethod,
} from '../utils/purchaseCalculations';
import type { ReportPeriodType } from '../utils/qrisFee';
import {
  computeBaseQuantityFromUnit,
  formatProductStockSummary,
  formatUnitConversionLabel,
  getProductAllUnitOptions,
  getProductBuyOptions,
  roundMoney,
} from '../utils/unitConversion';

interface PurchasesPageProps {
  products: Product[];
  accounts: Account[];
  storeSetting: StoreSetting | null;
}

type PurchaseSubTab = 'buy' | 'history' | 'suppliers' | 'debts' | 'returns';

interface FormLineRow {
  rowId: string;
  productId: string;
  unitName: string;
  quantity: string;
  unitCost: string;
  lineDiscount: string;
}

const PERIOD_OPTIONS: { id: ReportPeriodType; label: string }[] = [
  { id: 'daily', label: 'Harian' },
  { id: 'weekly', label: 'Mingguan' },
  { id: 'monthly', label: 'Bulanan' },
  { id: 'yearly', label: 'Tahunan' },
];

function createEmptyLine(): FormLineRow {
  return {
    rowId: `row_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    productId: '',
    unitName: '',
    quantity: '1',
    unitCost: '',
    lineDiscount: '0',
  };
}

function getPaymentMethodLabel(method: PurchasePaymentMethod | string): string {
  switch (method) {
    case 'cash':
      return 'Tunai (Laci Kas)';
    case 'transfer':
      return 'DANA / Transfer Bank';
    case 'credit':
      return 'Utang Pemasok (Kredit)';
    case 'partial':
      return 'Bayar Sebagian';
    default:
      return method;
  }
}

export function PurchasesPage({ products, accounts, storeSetting }: PurchasesPageProps) {
  const { user, profile, isAdmin } = useAuth();

  const [subTab, setSubTab] = useState<PurchaseSubTab>('buy');
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPayment[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
  const [priceHistory, setPriceHistory] = useState<PriceHistory[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);

  // Form Pembelian Baru
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(getTodayDateString());
  const [lines, setLines] = useState<FormLineRow[]>([createEmptyLine()]);
  const [invoiceDiscount, setInvoiceDiscount] = useState('0');
  const [extraCost, setExtraCost] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState<PurchasePaymentMethod>('cash');
  const [paidAmountInput, setPaidAmountInput] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [purchaseNotes, setPurchaseNotes] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [savingPurchase, setSavingPurchase] = useState(false);
  const purchaseSubmitLockRef = useRef(false);

  // Modal Tambah/Edit Pemasok (juga untuk tambah cepat dari form pembelian)
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [supName, setSupName] = useState('');
  const [supPhone, setSupPhone] = useState('');
  const [supAddress, setSupAddress] = useState('');
  const [supNotes, setSupNotes] = useState('');
  const [savingSupplier, setSavingSupplier] = useState(false);
  const [deletingSupplierId, setDeletingSupplierId] = useState<string | null>(null);

  // Riwayat & Laporan Pembelian
  const [periodType, setPeriodType] = useState<ReportPeriodType>('daily');
  const [anchorDate, setAnchorDate] = useState(getTodayDateString());
  const [historySearch, setHistorySearch] = useState('');
  const [historySubView, setHistorySubView] = useState<'invoices' | 'stock_in' | 'hpp'>('invoices');
  const [detailPurchase, setDetailPurchase] = useState<Purchase | null>(null);
  const [detailItems, setDetailItems] = useState<PurchaseItem[]>([]);
  const [loadingDetailItems, setLoadingDetailItems] = useState(false);

  // Modal Bayar Utang Pemasok
  const [payingPurchase, setPayingPurchase] = useState<Purchase | null>(null);
  const [debtPayAmount, setDebtPayAmount] = useState('');
  const [debtPayAccountId, setDebtPayAccountId] = useState('');
  const [debtPayNotes, setDebtPayNotes] = useState('');
  const [savingDebtPayment, setSavingDebtPayment] = useState(false);
  const debtPayLockRef = useRef(false);

  // Form Retur Pembelian
  const [returnPurchaseId, setReturnPurchaseId] = useState('');
  const [returnPurchaseItems, setReturnPurchaseItems] = useState<PurchaseItem[]>([]);
  const [loadingReturnItems, setLoadingReturnItems] = useState(false);
  const [returnItemId, setReturnItemId] = useState('');
  const [returnUnitName, setReturnUnitName] = useState('');
  const [returnQty, setReturnQty] = useState('1');
  const [returnUnitRefundPrice, setReturnUnitRefundPrice] = useState('');
  const [returnSettlementPref, setReturnSettlementPref] = useState<'auto' | 'reduce_debt' | 'cash_refund'>('auto');
  const [returnAccountId, setReturnAccountId] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [savingReturn, setSavingReturn] = useState(false);
  const returnLockRef = useRef(false);

  const activeProducts = useMemo(() => products.filter((p) => p.isActive), [products]);
  const activeAccounts = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return activeProducts;
    return activeProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode && p.barcode.toLowerCase().includes(q))
    );
  }, [activeProducts, productSearch]);

  useEffect(() => {
    if (!isAdmin || !user) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubSup = subscribeSuppliers(
      (list) => setSuppliers(list),
      () => {}
    );
    const unsubPur = subscribePurchases(
      (list) => {
        setPurchases(list);
        setLoading(false);
      },
      () => setLoading(false)
    );
    const unsubPay = subscribeSupplierPayments(
      (list) => setSupplierPayments(list),
      () => {}
    );
    const unsubRet = subscribePurchaseReturns(
      (list) => setPurchaseReturns(list),
      () => {}
    );
    const unsubPrice = subscribePriceHistory(
      true,
      user.uid,
      (list) => setPriceHistory(list),
      () => {}
    );
    const unsubMove = subscribeStockMovements(
      true,
      user.uid,
      (list) => setStockMovements(list),
      () => {}
    );

    return () => {
      unsubSup();
      unsubPur();
      unsubPay();
      unsubRet();
      unsubPrice();
      unsubMove();
    };
  }, [isAdmin, user]);

  useEffect(() => {
    if (activeAccounts.length === 0) return;
    if (!selectedAccountId || !activeAccounts.some((a) => a.id === selectedAccountId)) {
      if (paymentMethod === 'cash') {
        const cash = activeAccounts.find((a) => a.type === 'cash');
        setSelectedAccountId((cash || activeAccounts[0]).id);
      } else if (paymentMethod === 'transfer') {
        const bankOrWallet = activeAccounts.find((a) => a.type === 'ewallet' || a.type === 'bank');
        setSelectedAccountId((bankOrWallet || activeAccounts[0]).id);
      } else {
        setSelectedAccountId(activeAccounts[0].id);
      }
    }
    if (!debtPayAccountId || !activeAccounts.some((a) => a.id === debtPayAccountId)) {
      const cash = activeAccounts.find((a) => a.type === 'cash');
      setDebtPayAccountId((cash || activeAccounts[0]).id);
    }
    if (!returnAccountId || !activeAccounts.some((a) => a.id === returnAccountId)) {
      const cash = activeAccounts.find((a) => a.type === 'cash');
      setReturnAccountId((cash || activeAccounts[0]).id);
    }
  }, [activeAccounts, paymentMethod, selectedAccountId, debtPayAccountId, returnAccountId]);

  useEffect(() => {
    if (paymentMethod === 'cash') {
      const cash = activeAccounts.find((a) => a.type === 'cash');
      if (cash) setSelectedAccountId(cash.id);
    } else if (paymentMethod === 'transfer') {
      const nonCash = activeAccounts.find((a) => a.type === 'ewallet' || a.type === 'bank');
      if (nonCash) setSelectedAccountId(nonCash.id);
    }
  }, [paymentMethod, activeAccounts]);

  if (!isAdmin) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>
          Akses ditolak. Modul Pembelian Barang, Data Pemasok, Utang Pemasok, dan Retur hanya tersedia untuk Admin.
        </span>
      </div>
    );
  }

  // Live preview perhitungan form pembelian
  const draftPreview = useMemo(() => {
    const validRows = lines.filter((r) => r.productId && Number(r.quantity) > 0 && r.unitCost !== '');
    if (validRows.length === 0) return { draft: null, error: null as string | null };
    try {
      const mapped = validRows.map((r) => {
        const product = products.find((p) => p.id === r.productId);
        if (!product) {
          throw new Error('Produk tidak ditemukan.');
        }
        return {
          product,
          unitName: r.unitName || product.unit,
          quantity: Number(r.quantity),
          unitCost: Number(r.unitCost),
          lineDiscount: Number(r.lineDiscount) || 0,
        };
      });
      const draft = computePurchaseDraft(
        mapped,
        Number(invoiceDiscount) || 0,
        Number(extraCost) || 0
      );
      return { draft, error: null as string | null };
    } catch (err) {
      return {
        draft: null,
        error: err instanceof Error ? err.message : 'Periksa kembali input pembelian.',
      };
    }
  }, [lines, products, invoiceDiscount, extraCost]);

  const settlementPreview = useMemo(() => {
    if (!draftPreview.draft) return { settlement: null, error: null as string | null };
    try {
      const settlement = calculatePurchaseSettlement({
        totalAmount: draftPreview.draft.totalAmount,
        paymentMethod,
        paidAmount: paymentMethod === 'partial' ? Number(paidAmountInput) || 0 : undefined,
      });
      return { settlement, error: null as string | null };
    } catch (err) {
      return {
        settlement: null,
        error: err instanceof Error ? err.message : 'Nominal pembayaran belum valid.',
      };
    }
  }, [draftPreview.draft, paymentMethod, paidAmountInput]);

  const report = useMemo(
    () =>
      buildPurchaseReportSummary({
        periodType,
        anchorDateStr: anchorDate,
        purchases,
        supplierPayments,
        purchaseReturns,
        products,
        priceHistory,
      }),
    [periodType, anchorDate, purchases, supplierPayments, purchaseReturns, products, priceHistory]
  );

  const unpaidPurchases = useMemo(
    () => purchases.filter((p) => p.status === 'completed' && getPurchaseDebtAmount(p) > 0),
    [purchases]
  );

  const filteredPeriodPurchases = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return report.periodPurchases;
    return report.periodPurchases.filter(
      (p) =>
        p.transactionNumber.toLowerCase().includes(q) ||
        p.supplierName.toLowerCase().includes(q) ||
        (p.invoiceNumber && p.invoiceNumber.toLowerCase().includes(q))
    );
  }, [report.periodPurchases, historySearch]);

  const purchaseStockInMovements = useMemo(
    () =>
      stockMovements.filter(
        (m) =>
          m.type === 'in' &&
          m.transactionDate >= report.startDate &&
          m.transactionDate <= report.endDate &&
          (m.referenceId?.startsWith('pur_') || m.notes?.toLowerCase().includes('pembelian'))
      ),
    [stockMovements, report.startDate, report.endDate]
  );

  const handleSelectProductInRow = (rowId: string, productId: string) => {
    const prod = products.find((p) => p.id === productId);
    setLines((prev) =>
      prev.map((row) => {
        if (row.rowId !== rowId) return row;
        if (!prod) {
          return { ...row, productId: '', unitName: '', unitCost: '' };
        }
        const buyOptions = getProductBuyOptions(prod);
        const defaultOpt = buyOptions[0];
        const defaultUnitName = defaultOpt?.unitName || prod.unit;
        const suggestedCost =
          defaultOpt?.buyPrice !== undefined && defaultOpt.buyPrice > 0
            ? roundMoney(defaultOpt.buyPrice)
            : prod.costPrice > 0 && defaultOpt
              ? roundMoney(prod.costPrice * defaultOpt.conversion)
              : 0;
        return {
          ...row,
          productId: prod.id,
          unitName: defaultUnitName,
          unitCost: suggestedCost > 0 ? String(suggestedCost) : '',
        };
      })
    );
  };

  const handleSelectUnitInRow = (rowId: string, newUnitName: string) => {
    setLines((prev) =>
      prev.map((row) => {
        if (row.rowId !== rowId) return row;
        const prod = products.find((p) => p.id === row.productId);
        if (!prod) return { ...row, unitName: newUnitName };
        const options = getProductBuyOptions(prod);
        const opt = options.find((o) => o.unitName.toUpperCase() === newUnitName.toUpperCase());
        const suggestedCost =
          opt?.buyPrice !== undefined && opt.buyPrice > 0
            ? String(roundMoney(opt.buyPrice))
            : opt && prod.costPrice > 0
              ? String(roundMoney(prod.costPrice * opt.conversion))
              : row.unitCost;
        return {
          ...row,
          unitName: newUnitName,
          unitCost: suggestedCost,
        };
      })
    );
  };

  const handleUpdateRow = (rowId: string, patch: Partial<FormLineRow>) => {
    setLines((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  };

  const handleAddLine = () => {
    setLines((prev) => [...prev, createEmptyLine()]);
  };

  const handleRemoveLine = (rowId: string) => {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.rowId !== rowId)));
  };

  const handleSubmitPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || purchaseSubmitLockRef.current) return;
    setFeedback(null);

    const supplier = suppliers.find((s) => s.id === selectedSupplierId);
    if (!supplier) {
      setFeedback({
        kind: 'err',
        text: 'Pilih pemasok terlebih dahulu (atau klik "+ Pemasok Baru").',
      });
      return;
    }

    const filledLines = lines.filter((r) => r.productId);
    if (filledLines.length === 0) {
      setFeedback({ kind: 'err', text: 'Pilih minimal 1 produk pada daftar barang pembelian.' });
      return;
    }

    const mappedLines = [];
    for (const r of filledLines) {
      const prod = products.find((p) => p.id === r.productId);
      if (!prod) {
        setFeedback({ kind: 'err', text: 'Salah satu produk yang dipilih tidak ditemukan.' });
        return;
      }
      mappedLines.push({
        product: prod,
        unitName: r.unitName || prod.unit,
        quantity: Number(r.quantity) || 0,
        unitCost: r.unitCost === '' ? -1 : Number(r.unitCost),
        lineDiscount: Number(r.lineDiscount) || 0,
      });
    }

    const targetAccount =
      paymentMethod === 'credit'
        ? null
        : activeAccounts.find((a) => a.id === selectedAccountId) || null;

    purchaseSubmitLockRef.current = true;
    setSavingPurchase(true);
    try {
      const res = await recordPurchaseTransaction(
        {
          supplier,
          supplierName: supplier.name,
          invoiceNumber,
          purchaseDate,
          lines: mappedLines,
          discount: Number(invoiceDiscount) || 0,
          extraCost: Number(extraCost) || 0,
          paymentMethod,
          paidAmount: paymentMethod === 'partial' ? Number(paidAmountInput) || 0 : undefined,
          account: targetAccount,
          notes: purchaseNotes,
          existingPurchases: purchases,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        }
      );

      setFeedback({
        kind: 'ok',
        text: `Pembelian ${res.transactionNumber} (${formatRupiah(
          res.totalAmount
        )}) berhasil disimpan. Stok & HPP rata-rata tertimbang otomatis diperbarui.${
          res.debtAmount > 0 ? ` Sisa utang pemasok: ${formatRupiah(res.debtAmount)}.` : ''
        }`,
      });

      setInvoiceNumber('');
      setLines([createEmptyLine()]);
      setInvoiceDiscount('0');
      setExtraCost('0');
      setPaidAmountInput('');
      setPurchaseNotes('');
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      purchaseSubmitLockRef.current = false;
      setSavingPurchase(false);
    }
  };

  // Pemasok CRUD
  const openSupplierModal = (sup?: Supplier) => {
    setFeedback(null);
    if (sup) {
      setEditingSupplier(sup);
      setSupName(sup.name);
      setSupPhone(sup.phone || '');
      setSupAddress(sup.address || '');
      setSupNotes(sup.notes || '');
    } else {
      setEditingSupplier(null);
      setSupName('');
      setSupPhone('');
      setSupAddress('');
      setSupNotes('');
    }
    setSupplierModalOpen(true);
  };

  const handleSaveSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSavingSupplier(true);
    setFeedback(null);
    try {
      if (editingSupplier) {
        await updateSupplier(editingSupplier.id, {
          name: supName,
          phone: supPhone,
          address: supAddress,
          notes: supNotes,
        });
        setFeedback({ kind: 'ok', text: `Data pemasok "${supName.trim()}" berhasil diperbarui.` });
      } else {
        const created = await createSupplier(
          {
            name: supName,
            phone: supPhone,
            address: supAddress,
            notes: supNotes,
          },
          user.uid
        );
        setSelectedSupplierId(created.id);
        setFeedback({ kind: 'ok', text: `Pemasok "${created.name}" berhasil ditambahkan.` });
      }
      setSupplierModalOpen(false);
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setSavingSupplier(false);
    }
  };

  const handleDeleteSupplier = async (sup: Supplier) => {
    setFeedback(null);
    setDeletingSupplierId(sup.id);
    try {
      await deleteSupplier(sup);
      if (selectedSupplierId === sup.id) setSelectedSupplierId('');
      setFeedback({ kind: 'ok', text: `Pemasok "${sup.name}" berhasil dihapus.` });
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setDeletingSupplierId(null);
    }
  };

  // Detail Faktur (Read-only, never recalculates stock/HPP)
  const handleOpenPurchaseDetail = async (purchase: Purchase) => {
    setDetailPurchase(purchase);
    setDetailItems([]);
    setLoadingDetailItems(true);
    try {
      const items = await fetchPurchaseItems(purchase.id);
      setDetailItems(items);
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setLoadingDetailItems(false);
    }
  };

  // Bayar Utang Pemasok
  const openDebtPayModal = (purchase: Purchase) => {
    setPayingPurchase(purchase);
    setDebtPayAmount(String(getPurchaseDebtAmount(purchase)));
    setDebtPayNotes('');
    setFeedback(null);
  };

  const handleConfirmDebtPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !payingPurchase || debtPayLockRef.current) return;
    const account = activeAccounts.find((a) => a.id === debtPayAccountId);
    if (!account) {
      setFeedback({ kind: 'err', text: 'Pilih akun kas/bank sumber dana pembayaran utang.' });
      return;
    }

    debtPayLockRef.current = true;
    setSavingDebtPayment(true);
    setFeedback(null);
    try {
      const supplier = suppliers.find((s) => s.id === payingPurchase.supplierId) || null;
      const res = await recordSupplierDebtPayment(
        {
          purchase: payingPurchase,
          supplier,
          amount: Number(debtPayAmount) || 0,
          account,
          notes: debtPayNotes,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        }
      );
      setFeedback({
        kind: 'ok',
        text: `Pembayaran utang ${res.transactionNumber} berhasil dicatat. Sisa utang faktur: ${formatRupiah(
          res.debtAfter
        )}.`,
      });
      setPayingPurchase(null);
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      debtPayLockRef.current = false;
      setSavingDebtPayment(false);
    }
  };

  // Retur Pembelian
  const handleSelectReturnPurchase = async (purchaseId: string) => {
    setReturnPurchaseId(purchaseId);
    setReturnItemId('');
    setReturnUnitName('');
    setReturnUnitRefundPrice('');
    setReturnPurchaseItems([]);
    if (!purchaseId) return;

    setLoadingReturnItems(true);
    try {
      const items = await fetchPurchaseItems(purchaseId);
      setReturnPurchaseItems(items);
      if (items.length > 0) {
        const first = items[0];
        setReturnItemId(first.id);
        setReturnUnitName(first.unitName || first.baseUnit || 'PCS');
        setReturnUnitRefundPrice(String(roundMoney(first.unitCost)));
      }
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      setLoadingReturnItems(false);
    }
  };

  const selectedReturnPurchase = useMemo(
    () => purchases.find((p) => p.id === returnPurchaseId) || null,
    [purchases, returnPurchaseId]
  );

  const selectedReturnItem = useMemo(
    () => returnPurchaseItems.find((i) => i.id === returnItemId) || null,
    [returnPurchaseItems, returnItemId]
  );

  const selectedReturnProduct = useMemo(
    () =>
      selectedReturnItem ? products.find((p) => p.id === selectedReturnItem.productId) || null : null,
    [products, selectedReturnItem]
  );

  const returnPlanPreview = useMemo(() => {
    if (!selectedReturnPurchase || !selectedReturnItem || !selectedReturnProduct) {
      return { plan: null, error: null as string | null };
    }
    try {
      const priorReturns = purchaseReturns.filter(
        (r) => r.purchaseId === selectedReturnPurchase.id && r.productId === selectedReturnItem.productId
      );
      const plan = computePurchaseReturnPlan({
        purchase: selectedReturnPurchase,
        item: selectedReturnItem,
        product: selectedReturnProduct,
        priorReturnsForItem: priorReturns,
        unitName: returnUnitName || selectedReturnProduct.unit,
        returnQty: Number(returnQty) || 0,
        unitRefundPrice: Number(returnUnitRefundPrice) || 0,
        settlementPreference: returnSettlementPref,
      });
      return { plan, error: null as string | null };
    } catch (err) {
      return {
        plan: null,
        error: err instanceof Error ? err.message : 'Input retur belum valid.',
      };
    }
  }, [
    selectedReturnPurchase,
    selectedReturnItem,
    selectedReturnProduct,
    purchaseReturns,
    returnUnitName,
    returnQty,
    returnUnitRefundPrice,
    returnSettlementPref,
  ]);

  const handleSubmitReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedReturnPurchase || !selectedReturnItem || !selectedReturnProduct) return;
    if (returnLockRef.current) return;

    setFeedback(null);
    const targetAcc = activeAccounts.find((a) => a.id === returnAccountId) || null;
    const supplier = suppliers.find((s) => s.id === selectedReturnPurchase.supplierId) || null;
    const priorReturns = purchaseReturns.filter(
      (r) => r.purchaseId === selectedReturnPurchase.id && r.productId === selectedReturnItem.productId
    );

    returnLockRef.current = true;
    setSavingReturn(true);
    try {
      const res = await recordPurchaseReturn(
        {
          purchase: selectedReturnPurchase,
          item: selectedReturnItem,
          product: selectedReturnProduct,
          supplier,
          priorReturnsForItem: priorReturns,
          unitName: returnUnitName || selectedReturnProduct.unit,
          returnQty: Number(returnQty) || 0,
          unitRefundPrice: Number(returnUnitRefundPrice) || 0,
          settlementPreference: returnSettlementPref,
          account: targetAcc,
          reason: returnReason,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Admin',
        }
      );

      setFeedback({
        kind: 'ok',
        text: `Retur pembelian ${res.transactionNumber} senilai ${formatRupiah(
          res.refundTotal
        )} berhasil dicatat. Stok barang dan saldo/utang telah disesuaikan.`,
      });
      setReturnQty('1');
      setReturnReason('');
    } catch (err) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
    } finally {
      returnLockRef.current = false;
      setSavingReturn(false);
    }
  };

  // Export Laporan Pembelian & Persediaan Excel
  const handleExportPurchaseExcel = () => {
    const wb = XLSX.utils.book_new();

    const summaryRows = [
      ['LAPORAN PEMBELIAN & PERSEDIAAN - ' + (storeSetting?.storeName || 'KEDAI KHANXA')],
      ['Periode', report.periodLabel],
      ['Jumlah Transaksi Pembelian', report.purchaseCount],
      ['Total Pembelian Periode', report.totalPurchasesAmount],
      ['Pembelian Tunai/Transfer', report.cashPurchasesAmount],
      ['Pembelian Kredit/Sebagian', report.creditPurchasesAmount],
      ['Pembayaran Utang Pemasok (Periode)', report.supplierPaymentsTotalInPeriod],
      ['Retur Pembelian (Periode)', report.returnsTotalInPeriod],
      ['Total Utang Pemasok Belum Lunas (Aktif)', report.unpaidSupplierDebtAllTime],
      ['Total Nilai Persediaan Saat Ini', report.inventoryTotalValue],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Ringkasan');

    const purchaseRows = report.periodPurchases.map((p) => ({
      'No. Transaksi': p.transactionNumber,
      Tanggal: p.transactionDate,
      'No. Faktur': p.invoiceNumber || '-',
      Pemasok: p.supplierName,
      Metode: getPaymentMethodLabel(p.paymentMethod),
      Subtotal: p.subtotal ?? p.totalAmount,
      Diskon: p.discount ?? 0,
      'Biaya Tambahan': p.extraCost ?? 0,
      Total: p.totalAmount,
      Dibayar: p.paidAmount ?? (p.paymentMethod === 'credit' ? 0 : p.totalAmount),
      'Sisa Utang': getPurchaseDebtAmount(p),
      Retur: p.returnedAmount ?? 0,
      Status: getPurchasePaymentStatus(p).toUpperCase(),
    }));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(purchaseRows.length > 0 ? purchaseRows : [{ Info: 'Tidak ada data' }]),
      'Pembelian'
    );

    const debtRows = unpaidPurchases.map((p) => ({
      'No. Transaksi': p.transactionNumber,
      Tanggal: p.transactionDate,
      'No. Faktur': p.invoiceNumber || '-',
      Pemasok: p.supplierName,
      Total: p.totalAmount,
      Dibayar: p.paidAmount ?? 0,
      'Sisa Utang': getPurchaseDebtAmount(p),
    }));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(debtRows.length > 0 ? debtRows : [{ Info: 'Tidak ada utang aktif' }]),
      'Utang Pemasok'
    );

    const invRows = activeProducts.map((p) => ({
      Kode: p.sku,
      'Nama Produk': p.name,
      Kategori: p.categoryName,
      'Satuan Dasar': p.unit,
      Stok: p.stock,
      'HPP Satuan Dasar': p.costPrice,
      'Nilai Persediaan': roundMoney(Math.max(0, p.stock) * Math.max(0, p.costPrice)),
    }));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(invRows.length > 0 ? invRows : [{ Info: 'Belum ada produk' }]),
      'Nilai Persediaan'
    );

    const hppRows = report.periodHppChanges.map((h) => ({
      Tanggal: h.transactionDate,
      'No. Ref': h.transactionNumber,
      Produk: h.productName,
      Satuan: h.baseUnit,
      'HPP Sebelum': h.costPriceBefore,
      'HPP Sesudah': h.costPriceAfter,
      Keterangan: h.summary,
    }));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(hppRows.length > 0 ? hppRows : [{ Info: 'Tidak ada perubahan HPP' }]),
      'Perubahan HPP'
    );

    XLSX.writeFile(wb, `Laporan_Pembelian_${report.startDate}_${report.endDate}.xlsx`);
  };

  return (
    <div className="space-y-6">
      {/* Header & Navigasi Sub-Menu Pembelian */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold text-slate-900">
                Pembelian Barang &amp; Stok Masuk
              </h2>
              <p className="text-xs text-slate-500">
                Konversi multi-satuan otomatis, HPP rata-rata tertimbang, kas &amp; utang pemasok, serta retur pembelian.
              </p>
            </div>
          </div>

          <div className="text-right hidden sm:block">
            <div className="text-[11px] font-medium text-slate-500">Total Utang Pemasok</div>
            <div className="font-mono-num text-base font-bold text-amber-700">
              {formatRupiah(report.unpaidSupplierDebtAllTime)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          {(
            [
              { id: 'buy', label: 'Pembelian Barang', icon: PackagePlus },
              { id: 'history', label: 'Riwayat & Laporan', icon: Receipt },
              { id: 'suppliers', label: `Data Pemasok (${suppliers.length})`, icon: Building2 },
              { id: 'debts', label: `Utang Pemasok (${unpaidPurchases.length})`, icon: CreditCard },
              { id: 'returns', label: 'Retur Pembelian', icon: RotateCcw },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = subTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setSubTab(tab.id);
                  setFeedback(null);
                }}
                className={`min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-emerald-700 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-xl p-4 border text-sm flex items-start gap-3 ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {feedback.kind === 'ok' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
          )}
          <span className="flex-1">{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-500 hover:text-slate-800"
            aria-label="Tutup pesan"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* TAB 1: TRANSAKSI PEMBELIAN BARANG */}
      {subTab === 'buy' && (
        <form onSubmit={handleSubmitPurchase} className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-display font-semibold text-base text-slate-900">
                1. Informasi Faktur &amp; Pemasok
              </h3>
              <button
                type="button"
                onClick={() => openSupplierModal()}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-800 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Pemasok Baru</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Pemasok <span className="text-red-600">*</span>
                </label>
                <select
                  value={selectedSupplierId}
                  onChange={(e) => setSelectedSupplierId(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  required
                >
                  <option value="">-- Pilih Pemasok --</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.totalDebt > 0 ? ` (Utang: ${formatRupiah(s.totalDebt)})` : ''}
                    </option>
                  ))}
                </select>
                {suppliers.length === 0 && (
                  <p className="text-xs text-amber-700 mt-1">
                    Belum ada pemasok. Klik &quot;+ Pemasok Baru&quot; untuk menambahkan.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Nomor Faktur Pemasok (Opsional)
                </label>
                <input
                  type="text"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="Contoh: INV-2026-001"
                  maxLength={60}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Tanggal Pembelian <span className="text-red-600">*</span>
                </label>
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>
          </div>

          {/* Daftar Produk */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  2. Daftar Barang Dibeli
                </h3>
                <p className="text-xs text-slate-500">
                  Pilih satuan beli sesuai pengaturan multi-satuan produk. Stok &amp; HPP dikonversi otomatis ke satuan dasar.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="Filter daftar produk..."
                    className="min-h-[40px] pl-9 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-600 w-48"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAddLine}
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>Tambah Baris</span>
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {lines.map((row, idx) => {
                const selectedProd = products.find((p) => p.id === row.productId);
                const unitOptions = selectedProd ? getProductBuyOptions(selectedProd) : [];
                const activeOption =
                  unitOptions.find(
                    (u) => u.unitName.toUpperCase() === (row.unitName || '').toUpperCase()
                  ) || unitOptions[0];
                const computedLine = draftPreview.draft?.lines.find(
                  (cl, cIdx) =>
                    cl.product.id === row.productId &&
                    cIdx ===
                      lines
                        .slice(0, idx + 1)
                        .filter((r) => r.productId && Number(r.quantity) > 0 && r.unitCost !== '')
                        .length -
                        1
                );

                return (
                  <div
                    key={row.rowId}
                    className="border border-slate-200 rounded-xl p-4 bg-slate-50/50 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">
                        Barang #{idx + 1}
                      </span>
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveLine(row.rowId)}
                          className="text-xs text-red-600 hover:text-red-800 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Hapus</span>
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-4">
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Produk
                        </label>
                        <select
                          value={row.productId}
                          onChange={(e) => handleSelectProductInRow(row.rowId, e.target.value)}
                          className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                          required
                        >
                          <option value="">-- Pilih Produk --</option>
                          {filteredProducts.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} (Stok: {formatProductStockSummary(p.stock, p).primary})
                            </option>
                          ))}
                          {selectedProd &&
                            !filteredProducts.some((fp) => fp.id === selectedProd.id) && (
                              <option value={selectedProd.id}>
                                {selectedProd.name} (Stok:{' '}
                                {formatProductStockSummary(selectedProd.stock, selectedProd).primary})
                              </option>
                            )}
                        </select>
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Satuan Beli
                        </label>
                        <select
                          value={activeOption?.unitName || row.unitName}
                          onChange={(e) => handleSelectUnitInRow(row.rowId, e.target.value)}
                          disabled={!selectedProd}
                          className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-slate-100"
                        >
                          {!selectedProd ? (
                            <option value="">-</option>
                          ) : (
                            unitOptions.map((u) => (
                              <option key={u.unitName} value={u.unitName}>
                                {u.unitName} ({formatUnitConversionLabel(u, selectedProd.unit)})
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Jumlah
                        </label>
                        <input
                          type="number"
                          step="any"
                          min="0.0001"
                          value={row.quantity}
                          onChange={(e) =>
                            handleUpdateRow(row.rowId, { quantity: e.target.value })
                          }
                          className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white font-mono-num text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                          required
                        />
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Harga Beli / {activeOption?.unitName || row.unitName || 'Satuan'}
                        </label>
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={row.unitCost}
                          onChange={(e) =>
                            handleUpdateRow(row.rowId, { unitCost: e.target.value })
                          }
                          placeholder="0"
                          className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white font-mono-num text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                          required
                        />
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Diskon Item (Rp)
                        </label>
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={row.lineDiscount}
                          onChange={(e) =>
                            handleUpdateRow(row.rowId, { lineDiscount: e.target.value })
                          }
                          className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white font-mono-num text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                        />
                      </div>
                    </div>

                    {selectedProd && (
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/80 text-xs text-slate-600">
                        <div className="flex flex-wrap items-center gap-3">
                          <span>
                            Stok sekarang:{' '}
                            <strong className="font-mono-num text-slate-900">
                              {formatProductStockSummary(selectedProd.stock, selectedProd).primary}
                            </strong>
                          </span>
                          {activeOption && Number(row.quantity) > 0 && (
                            <span className="text-emerald-700 font-medium">
                              Stok masuk: +
                              <span className="font-mono-num">
                                {formatQty(
                                  computeBaseQuantityFromUnit(Number(row.quantity) || 0, activeOption)
                                )}{' '}
                                {selectedProd.unit}
                              </span>
                            </span>
                          )}
                          {computedLine && (
                            <span>
                              HPP/{selectedProd.unit}:{' '}
                              <span className="font-mono-num text-slate-700">
                                {formatRupiah(computedLine.hppBefore)}
                              </span>{' '}
                              →{' '}
                              <strong className="font-mono-num text-emerald-700">
                                {formatRupiah(computedLine.hppAfter)}
                              </strong>
                            </span>
                          )}
                        </div>
                        <div className="font-mono-num font-semibold text-slate-900">
                          Subtotal:{' '}
                          {computedLine
                            ? formatRupiah(computedLine.afterLineDiscount)
                            : formatRupiah(
                                Math.max(
                                  0,
                                  (Number(row.quantity) || 0) * (Number(row.unitCost) || 0) -
                                    (Number(row.lineDiscount) || 0)
                                )
                              )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Biaya Tambahan, Diskon Faktur & Pembayaran */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <h3 className="font-display font-semibold text-base text-slate-900 border-b border-slate-100 pb-3">
                3. Potongan, Biaya Tambahan &amp; Metode Pembayaran
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Diskon Faktur (Rp)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={invoiceDiscount}
                    onChange={(e) => setInvoiceDiscount(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 font-mono-num text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Biaya Tambahan / Ongkir (Rp)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={extraCost}
                    onChange={(e) => setExtraCost(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 font-mono-num text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Metode Pembayaran
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(
                    [
                      { id: 'cash', label: 'Tunai Laci Kas' },
                      { id: 'transfer', label: 'DANA / Bank' },
                      { id: 'credit', label: 'Utang Pemasok' },
                      { id: 'partial', label: 'Bayar Sebagian' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setPaymentMethod(opt.id)}
                      className={`min-h-[42px] px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                        paymentMethod === opt.id
                          ? 'border-emerald-700 bg-emerald-50 text-emerald-800'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {paymentMethod !== 'credit' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Akun Sumber Dana <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={selectedAccountId}
                      onChange={(e) => setSelectedAccountId(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      required
                    >
                      {activeAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} ({getAccountTypeLabel(acc.type)}) — Saldo:{' '}
                          {formatRupiah(acc.balance)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {paymentMethod === 'partial' && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                        Nominal Dibayar Sekarang (Rp) <span className="text-red-600">*</span>
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="any"
                        value={paidAmountInput}
                        onChange={(e) => setPaidAmountInput(e.target.value)}
                        placeholder="Masukkan jumlah DP"
                        className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 font-mono-num text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                        required
                      />
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Catatan Pembelian (Opsional)
                </label>
                <input
                  type="text"
                  value={purchaseNotes}
                  onChange={(e) => setPurchaseNotes(e.target.value)}
                  maxLength={240}
                  placeholder="Contoh: Kiriman mingguan, tempo 14 hari"
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            {/* Ringkasan Pembelian */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <h3 className="font-display font-semibold text-base text-slate-900 border-b border-slate-100 pb-3">
                  Ringkasan Faktur Pembelian
                </h3>

                <div className="space-y-2 text-sm">
                  <div className="flex justify-between text-slate-600">
                    <span>Subtotal Barang</span>
                    <span className="font-mono-num font-medium text-slate-900">
                      {formatRupiah(draftPreview.draft?.subtotal ?? 0)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Diskon Faktur</span>
                    <span className="font-mono-num text-red-700">
                      -{formatRupiah(draftPreview.draft?.discount ?? (Number(invoiceDiscount) || 0))}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Biaya Tambahan / Ongkir</span>
                    <span className="font-mono-num text-slate-900">
                      +{formatRupiah(draftPreview.draft?.extraCost ?? (Number(extraCost) || 0))}
                    </span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-200 text-base font-bold text-slate-900">
                    <span>Total Pembelian</span>
                    <span className="font-mono-num text-emerald-700">
                      {formatRupiah(draftPreview.draft?.totalAmount ?? 0)}
                    </span>
                  </div>
                </div>

                {settlementPreview.settlement && (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Dibayar Sekarang (Saldo Berkurang)</span>
                      <span className="font-mono-num font-semibold text-slate-900">
                        {formatRupiah(settlementPreview.settlement.paidAmount)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">Dicatat sebagai Utang Pemasok</span>
                      <span className="font-mono-num font-semibold text-amber-700">
                        {formatRupiah(settlementPreview.settlement.debtAmount)}
                      </span>
                    </div>
                  </div>
                )}

                {(draftPreview.error || settlementPreview.error) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                    {draftPreview.error || settlementPreview.error}
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={
                  savingPurchase ||
                  !draftPreview.draft ||
                  Boolean(draftPreview.error) ||
                  Boolean(settlementPreview.error)
                }
                className="w-full min-h-[46px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <PackagePlus className="w-4 h-4" />
                <span>{savingPurchase ? 'Menyimpan Transaksi...' : 'Simpan Pembelian & Tambah Stok'}</span>
              </button>
            </div>
          </div>
        </form>
      )}

      {/* TAB 2: RIWAYAT PEMBELIAN & LAPORAN */}
      {subTab === 'history' && (
        <div className="space-y-6">
          {/* Filter Periode Laporan */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setPeriodType(opt.id)}
                  className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                    periodType === opt.id
                      ? 'bg-emerald-700 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <div className="inline-flex items-center gap-2 ml-1">
                <Calendar className="w-4 h-4 text-slate-500" />
                <input
                  type="date"
                  value={anchorDate}
                  onChange={(e) => setAnchorDate(e.target.value)}
                  className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleExportPurchaseExcel}
              className="min-h-[40px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 cursor-pointer shrink-0"
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
              <span>Export Excel Laporan Pembelian</span>
            </button>
          </div>

          {/* 4 KPI Strip Laporan Pembelian */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                <span>Total Pembelian ({report.periodLabel})</span>
                <Receipt className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="font-mono-num text-2xl font-semibold text-slate-900">
                {formatRupiah(report.totalPurchasesAmount)}
              </div>
              <div className="text-xs text-slate-500 font-mono-num">
                {report.purchaseCount} faktur · Tunai: {formatRupiah(report.cashPurchasesAmount)} ·
                Kredit: {formatRupiah(report.creditPurchasesAmount)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                <span>Utang Pemasok Belum Lunas</span>
                <CreditCard className="w-4 h-4 text-amber-700" />
              </div>
              <div className="font-mono-num text-2xl font-semibold text-amber-700">
                {formatRupiah(report.unpaidSupplierDebtAllTime)}
              </div>
              <div className="text-xs text-slate-500 font-mono-num">
                {report.unpaidPurchasesCountAllTime} faktur aktif belum lunas
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                <span>Bayar Utang &amp; Retur Periode</span>
                <Wallet className="w-4 h-4 text-slate-600" />
              </div>
              <div className="font-mono-num text-2xl font-semibold text-slate-900">
                {formatRupiah(report.supplierPaymentsTotalInPeriod)}
              </div>
              <div className="text-xs text-slate-500 font-mono-num">
                {report.supplierPaymentsCountInPeriod} bayar utang · Retur:{' '}
                {formatRupiah(report.returnsTotalInPeriod)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                <span>Nilai Persediaan Saat Ini</span>
                <TrendingUp className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="font-mono-num text-2xl font-semibold text-slate-900">
                {formatRupiah(report.inventoryTotalValue)}
              </div>
              <div className="text-xs text-slate-500 font-mono-num">
                {report.activeProductsCount} produk aktif · {report.periodHppChanges.length}{' '}
                perubahan HPP
              </div>
            </div>
          </div>

          {/* Sub-view Switcher Riwayat */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setHistorySubView('invoices')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                    historySubView === 'invoices'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Faktur Pembelian ({filteredPeriodPurchases.length})
                </button>
                <button
                  type="button"
                  onClick={() => setHistorySubView('stock_in')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                    historySubView === 'stock_in'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Riwayat Stok Masuk ({purchaseStockInMovements.length})
                </button>
                <button
                  type="button"
                  onClick={() => setHistorySubView('hpp')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                    historySubView === 'hpp'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Perubahan HPP ({report.periodHppChanges.length})
                </button>
              </div>

              {historySubView === 'invoices' && (
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Cari faktur / pemasok..."
                    className="min-h-[38px] pl-9 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs w-full sm:w-64"
                  />
                </div>
              )}
            </div>

            {loading ? (
              <div className="p-8 text-center text-sm text-slate-500">Memuat riwayat pembelian...</div>
            ) : historySubView === 'invoices' ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Tanggal &amp; No. Ref</th>
                      <th className="py-3 px-4">Pemasok &amp; Faktur</th>
                      <th className="py-3 px-4">Metode</th>
                      <th className="py-3 px-4 text-right">Total</th>
                      <th className="py-3 px-4 text-right">Sisa Utang</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredPeriodPurchases.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          Belum ada transaksi pembelian pada periode ini.
                        </td>
                      </tr>
                    ) : (
                      filteredPeriodPurchases.map((p) => {
                        const debt = getPurchaseDebtAmount(p);
                        const payStatus = getPurchasePaymentStatus(p);
                        return (
                          <tr key={p.id} className="hover:bg-slate-50">
                            <td className="py-3 px-4">
                              <div className="font-mono-num text-xs font-semibold text-slate-900">
                                {p.transactionNumber}
                              </div>
                              <div className="text-xs text-slate-500">
                                {p.transactionDate} · {p.transactionTime}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-medium text-slate-900">{p.supplierName}</div>
                              <div className="text-xs text-slate-500">
                                {p.invoiceNumber ? `Faktur: ${p.invoiceNumber}` : 'Tanpa No. Faktur'}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-700">
                              <div>{getPaymentMethodLabel(p.paymentMethod)}</div>
                              {p.accountName && (
                                <div className="text-[11px] text-slate-500">{p.accountName}</div>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900">
                              {formatRupiah(p.totalAmount)}
                            </td>
                            <td className="py-3 px-4 text-right font-mono-num font-semibold text-amber-700">
                              {formatRupiah(debt)}
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                                  payStatus === 'paid'
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : payStatus === 'partial'
                                      ? 'bg-amber-50 text-amber-800'
                                      : 'bg-red-50 text-red-700'
                                }`}
                              >
                                {payStatus === 'paid'
                                  ? 'Lunas'
                                  : payStatus === 'partial'
                                    ? 'Sebagian'
                                    : 'Belum Bayar'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleOpenPurchaseDetail(p)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  <span>Detail</span>
                                </button>
                                {debt > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => openDebtPayModal(p)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 cursor-pointer"
                                  >
                                    <Wallet className="w-3.5 h-3.5" />
                                    <span>Bayar</span>
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            ) : historySubView === 'stock_in' ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Tanggal</th>
                      <th className="py-3 px-4">Produk</th>
                      <th className="py-3 px-4">Satuan Beli</th>
                      <th className="py-3 px-4 text-right">Stok Masuk (Dasar)</th>
                      <th className="py-3 px-4 text-right">Stok Sebelum → Sesudah</th>
                      <th className="py-3 px-4">Keterangan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {purchaseStockInMovements.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          Belum ada riwayat stok masuk pembelian pada periode ini.
                        </td>
                      </tr>
                    ) : (
                      purchaseStockInMovements.map((m) => (
                        <tr key={m.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 text-xs font-mono-num text-slate-600">
                            {m.transactionDate} {m.transactionTime}
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-900">{m.productName}</td>
                          <td className="py-3 px-4 text-xs text-slate-700">
                            {m.unitQuantity !== undefined && m.unitName
                              ? `${formatQty(m.unitQuantity)} ${m.unitName}`
                              : '-'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700">
                            +{formatQty(m.quantity)} {m.baseUnit || ''}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-xs text-slate-700">
                            {formatQty(m.stockBefore)} → {formatQty(m.stockAfter)}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">{m.notes || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Tanggal &amp; Ref</th>
                      <th className="py-3 px-4">Produk</th>
                      <th className="py-3 px-4 text-right">HPP Sebelum</th>
                      <th className="py-3 px-4 text-right">HPP Sesudah</th>
                      <th className="py-3 px-4">Ringkasan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {report.periodHppChanges.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-500">
                          Belum ada perubahan HPP pada periode ini.
                        </td>
                      </tr>
                    ) : (
                      report.periodHppChanges.map((h) => (
                        <tr key={h.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 text-xs font-mono-num text-slate-600">
                            <div>{h.transactionNumber}</div>
                            <div>{h.transactionDate}</div>
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-900">
                            {h.productName}{' '}
                            <span className="text-xs text-slate-500">/{h.baseUnit}</span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-slate-600">
                            {formatRupiah(h.costPriceBefore)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700">
                            {formatRupiah(h.costPriceAfter)}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">{h.summary}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: DATA PEMASOK */}
      {subTab === 'suppliers' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="font-display font-semibold text-base text-slate-900">
                Daftar Pemasok / Distributor
              </h3>
              <p className="text-xs text-slate-500">
                Kelola data pemasok dan pantau total utang berjalan per pemasok.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openSupplierModal()}
              className="min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs sm:text-sm font-semibold hover:bg-emerald-800 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Tambah Pemasok</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-5">Nama Pemasok</th>
                  <th className="py-3 px-5">Kontak / HP</th>
                  <th className="py-3 px-5">Alamat &amp; Catatan</th>
                  <th className="py-3 px-5 text-right">Total Utang</th>
                  <th className="py-3 px-5 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {suppliers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      Belum ada pemasok terdaftar.
                    </td>
                  </tr>
                ) : (
                  suppliers.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="py-3 px-5 font-semibold text-slate-900">{s.name}</td>
                      <td className="py-3 px-5 font-mono-num text-xs text-slate-600">
                        {s.phone || '-'}
                      </td>
                      <td className="py-3 px-5 text-xs text-slate-600">
                        <div>{s.address || '-'}</div>
                        {s.notes && <div className="text-slate-400">{s.notes}</div>}
                      </td>
                      <td className="py-3 px-5 text-right font-mono-num font-semibold text-amber-700">
                        {formatRupiah(s.totalDebt || 0)}
                      </td>
                      <td className="py-3 px-5 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openSupplierModal(s)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            disabled={deletingSupplierId === s.id}
                            onClick={() => handleDeleteSupplier(s)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Hapus</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: UTANG PEMASOK & RIWAYAT PEMBAYARAN */}
      {subTab === 'debts' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="font-display font-semibold text-base text-slate-900">
                  Daftar Utang Pemasok Belum Lunas
                </h3>
                <p className="text-xs text-slate-500">
                  Mendukung cicilan bertahap atau pelunasan penuh dari Laci Kas, DANA, maupun Rekening Bank.
                </p>
              </div>
              <div className="font-mono-num text-base font-bold text-amber-700">
                Total: {formatRupiah(report.unpaidSupplierDebtAllTime)}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Tanggal &amp; No. Ref</th>
                    <th className="py-3 px-4">Pemasok &amp; Faktur</th>
                    <th className="py-3 px-4 text-right">Total Faktur</th>
                    <th className="py-3 px-4 text-right">Sudah Dibayar</th>
                    <th className="py-3 px-4 text-right">Sisa Utang</th>
                    <th className="py-3 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {unpaidPurchases.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        Tidak ada utang pembelian yang belum lunas.
                      </td>
                    </tr>
                  ) : (
                    unpaidPurchases.map((p) => {
                      const debt = getPurchaseDebtAmount(p);
                      const paid = p.paidAmount ?? 0;
                      return (
                        <tr key={p.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 text-xs font-mono-num">
                            <div className="font-semibold text-slate-900">{p.transactionNumber}</div>
                            <div className="text-slate-500">{p.transactionDate}</div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="font-medium text-slate-900">{p.supplierName}</div>
                            <div className="text-xs text-slate-500">
                              {p.invoiceNumber ? `Faktur: ${p.invoiceNumber}` : '-'}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-slate-700">
                            {formatRupiah(p.totalAmount)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num text-emerald-700">
                            {formatRupiah(paid)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono-num font-bold text-amber-700">
                            {formatRupiah(debt)}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => openDebtPayModal(p)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
                            >
                              <Wallet className="w-3.5 h-3.5" />
                              <span>Bayar Utang</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Riwayat Pembayaran Pemasok */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Riwayat Pembayaran Pemasok
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Tanggal &amp; No. Bayar</th>
                    <th className="py-3 px-4">Pemasok &amp; Ref Pembelian</th>
                    <th className="py-3 px-4">Sumber Dana</th>
                    <th className="py-3 px-4 text-right">Dibayar</th>
                    <th className="py-3 px-4 text-right">Sisa Setelah Bayar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {supplierPayments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        Belum ada riwayat pembayaran utang pemasok.
                      </td>
                    </tr>
                  ) : (
                    supplierPayments.map((pay) => (
                      <tr key={pay.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 text-xs font-mono-num">
                          <div className="font-semibold text-slate-900">{pay.transactionNumber}</div>
                          <div className="text-slate-500">
                            {pay.transactionDate} {pay.transactionTime}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{pay.supplierName}</div>
                          <div className="text-xs text-slate-500 font-mono-num">
                            {pay.purchaseNumber}
                            {pay.invoiceNumber ? ` · Faktur ${pay.invoiceNumber}` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-700">{pay.accountName}</td>
                        <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700">
                          {formatRupiah(pay.amount)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-slate-700">
                          {formatRupiah(pay.debtAfter)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: RETUR PEMBELIAN */}
      {subTab === 'returns' && (
        <div className="space-y-6">
          <form
            onSubmit={handleSubmitReturn}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-5"
          >
            <div className="border-b border-slate-100 pb-3">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Catat Retur Pembelian ke Pemasok
              </h3>
              <p className="text-xs text-slate-500">
                Stok barang otomatis berkurang sesuai konversi satuan, serta utang pemasok atau saldo kas/rekening otomatis disesuaikan.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Pilih Transaksi Pembelian <span className="text-red-600">*</span>
                </label>
                <select
                  value={returnPurchaseId}
                  onChange={(e) => handleSelectReturnPurchase(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
                  required
                >
                  <option value="">-- Pilih Faktur Pembelian --</option>
                  {purchases
                    .filter((p) => p.status === 'completed')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.transactionNumber} · {p.supplierName} ({p.transactionDate}) —{' '}
                        {formatRupiah(p.totalAmount)}
                        {getPurchaseDebtAmount(p) > 0
                          ? ` [Utang: ${formatRupiah(getPurchaseDebtAmount(p))}]`
                          : ''}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Pilih Barang pada Faktur <span className="text-red-600">*</span>
                </label>
                <select
                  value={returnItemId}
                  onChange={(e) => {
                    const it = returnPurchaseItems.find((i) => i.id === e.target.value);
                    setReturnItemId(e.target.value);
                    if (it) {
                      setReturnUnitName(it.unitName || it.baseUnit || 'PCS');
                      setReturnUnitRefundPrice(String(roundMoney(it.unitCost)));
                    }
                  }}
                  disabled={!returnPurchaseId || loadingReturnItems}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm disabled:bg-slate-100"
                  required
                >
                  <option value="">
                    {loadingReturnItems ? 'Memuat item faktur...' : '-- Pilih Barang --'}
                  </option>
                  {returnPurchaseItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.productName} ({formatQty(it.quantity)} {it.unitName || it.baseUnit || ''} @{' '}
                      {formatRupiah(it.unitCost)})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedReturnItem && selectedReturnProduct && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Satuan Retur
                    </label>
                    <select
                      value={returnUnitName}
                      onChange={(e) => {
                        const newUnit = e.target.value;
                        setReturnUnitName(newUnit);
                        const opts = getProductAllUnitOptions(selectedReturnProduct);
                        const opt = opts.find(
                          (o) => o.unitName.toUpperCase() === newUnit.toUpperCase()
                        );
                        if (opt && selectedReturnItem.effectiveBaseUnitCost !== undefined) {
                          setReturnUnitRefundPrice(
                            String(
                              roundMoney(
                                selectedReturnItem.effectiveBaseUnitCost * opt.conversion
                              )
                            )
                          );
                        }
                      }}
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
                    >
                      {getProductAllUnitOptions(selectedReturnProduct).map((o) => (
                        <option key={o.unitName} value={o.unitName}>
                          {o.unitName} (
                          {formatUnitConversionLabel(o, selectedReturnProduct.unit)})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Jumlah Retur <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0.0001"
                      value={returnQty}
                      onChange={(e) => setReturnQty(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 font-mono-num text-sm"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Harga Retur / Satuan (Rp)
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={returnUnitRefundPrice}
                      onChange={(e) => setReturnUnitRefundPrice(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 font-mono-num text-sm"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Penyelesaian Dana Retur
                    </label>
                    <select
                      value={returnSettlementPref}
                      onChange={(e) =>
                        setReturnSettlementPref(
                          e.target.value as 'auto' | 'reduce_debt' | 'cash_refund'
                        )
                      }
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
                    >
                      <option value="auto">Otomatis (Potong Utang Lalu Kas)</option>
                      <option value="reduce_debt">Potong Utang Pemasok</option>
                      <option value="cash_refund">Terima Pengembalian ke Kas/Bank</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(!returnPlanPreview.plan || returnPlanPreview.plan.cashRefundAmount > 0) && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                        Akun Penerima Pengembalian Dana
                      </label>
                      <select
                        value={returnAccountId}
                        onChange={(e) => setReturnAccountId(e.target.value)}
                        className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
                      >
                        {activeAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} — Saldo: {formatRupiah(acc.balance)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Alasan Retur (Opsional)
                    </label>
                    <input
                      type="text"
                      value={returnReason}
                      onChange={(e) => setReturnReason(e.target.value)}
                      maxLength={240}
                      placeholder="Contoh: Kemasan rusak / mendekati kedaluwarsa"
                      className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    />
                  </div>
                </div>

                {returnPlanPreview.plan && (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <div className="text-slate-500">Pengurangan Stok</div>
                      <div className="font-mono-num font-bold text-red-700 text-sm">
                        -{formatQty(returnPlanPreview.plan.returnBaseQty)}{' '}
                        {returnPlanPreview.plan.baseUnit}
                      </div>
                      <div className="text-slate-500 font-mono-num">
                        Sisa stok: {formatQty(returnPlanPreview.plan.stockAfter)}{' '}
                        {returnPlanPreview.plan.baseUnit}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">Total Nilai Retur</div>
                      <div className="font-mono-num font-bold text-slate-900 text-sm">
                        {formatRupiah(returnPlanPreview.plan.refundTotal)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">Pengurangan Utang</div>
                      <div className="font-mono-num font-bold text-amber-700 text-sm">
                        {formatRupiah(returnPlanPreview.plan.debtReducedAmount)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">Dana Kembali ke Kas/Bank</div>
                      <div className="font-mono-num font-bold text-emerald-700 text-sm">
                        {formatRupiah(returnPlanPreview.plan.cashRefundAmount)}
                      </div>
                    </div>
                  </div>
                )}

                {returnPlanPreview.error && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                    {returnPlanPreview.error}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={
                      savingReturn ||
                      !returnPlanPreview.plan ||
                      Boolean(returnPlanPreview.error)
                    }
                    className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>{savingReturn ? 'Memproses Retur...' : 'Simpan Retur Pembelian'}</span>
                  </button>
                </div>
              </>
            )}
          </form>

          {/* Riwayat Retur Pembelian */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Riwayat Retur Pembelian
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Tanggal &amp; No. Retur</th>
                    <th className="py-3 px-4">Pemasok &amp; Faktur</th>
                    <th className="py-3 px-4">Produk Diretur</th>
                    <th className="py-3 px-4 text-right">Total Retur</th>
                    <th className="py-3 px-4">Penyesuaian</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {purchaseReturns.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        Belum ada riwayat retur pembelian.
                      </td>
                    </tr>
                  ) : (
                    purchaseReturns.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 text-xs font-mono-num">
                          <div className="font-semibold text-slate-900">{r.transactionNumber}</div>
                          <div className="text-slate-500">
                            {r.transactionDate} {r.transactionTime}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{r.supplierName}</div>
                          <div className="text-xs font-mono-num text-slate-500">
                            {r.purchaseNumber}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{r.productName}</div>
                          <div className="text-xs text-slate-600 font-mono-num">
                            -{formatQty(r.returnQty)} {r.unitName} (-{formatQty(r.returnBaseQty)}{' '}
                            {r.baseUnit})
                          </div>
                          {r.reason && <div className="text-xs text-slate-400">{r.reason}</div>}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900">
                          {formatRupiah(r.refundTotal)}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {r.debtReducedAmount > 0 && (
                            <div className="text-amber-700 font-medium">
                              Potong Utang: {formatRupiah(r.debtReducedAmount)}
                            </div>
                          )}
                          {r.cashRefundAmount > 0 && (
                            <div className="text-emerald-700 font-medium">
                              Kembali ke {r.accountName || 'Kas'}:{' '}
                              {formatRupiah(r.cashRefundAmount)}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* MODAL TAMBAH / EDIT PEMASOK */}
      {supplierModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveSupplier}
            className="bg-white rounded-xl border border-slate-200 w-full max-w-md p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-display font-bold text-base text-slate-900">
                {editingSupplier ? 'Edit Data Pemasok' : 'Tambah Pemasok Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setSupplierModalOpen(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nama Pemasok / Toko / Sales <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={supName}
                  onChange={(e) => setSupName(e.target.value)}
                  maxLength={100}
                  required
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nomor HP / WhatsApp
                </label>
                <input
                  type="text"
                  value={supPhone}
                  onChange={(e) => setSupPhone(e.target.value)}
                  maxLength={24}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Alamat</label>
                <input
                  type="text"
                  value={supAddress}
                  onChange={(e) => setSupAddress(e.target.value)}
                  maxLength={200}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Catatan</label>
                <input
                  type="text"
                  value={supNotes}
                  onChange={(e) => setSupNotes(e.target.value)}
                  maxLength={200}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSupplierModalOpen(false)}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={savingSupplier}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {savingSupplier ? 'Menyimpan...' : 'Simpan Pemasok'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL DETAIL FAKTUR PEMBELIAN (READ-ONLY) */}
      {detailPurchase && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display font-bold text-base text-slate-900">
                  Detail Pembelian {detailPurchase.transactionNumber}
                </h3>
                <p className="text-xs text-slate-500">
                  {detailPurchase.supplierName} · {detailPurchase.transactionDate}{' '}
                  {detailPurchase.transactionTime}
                  {detailPurchase.invoiceNumber ? ` · Faktur ${detailPurchase.invoiceNumber}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailPurchase(null)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4">
              {loadingDetailItems ? (
                <div className="py-8 text-center text-sm text-slate-500">
                  Memuat daftar barang...
                </div>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                        <th className="py-2.5 px-3">Produk</th>
                        <th className="py-2.5 px-3">Qty &amp; Konversi</th>
                        <th className="py-2.5 px-3 text-right">Harga Beli</th>
                        <th className="py-2.5 px-3 text-right">HPP Sebelum → Sesudah</th>
                        <th className="py-2.5 px-3 text-right">Total Bersih</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {detailItems.map((it) => (
                        <tr key={it.id}>
                          <td className="py-2.5 px-3 font-medium text-slate-900">
                            {it.productName}
                          </td>
                          <td className="py-2.5 px-3 font-mono-num text-slate-700">
                            {formatQty(it.quantity)} {it.unitName || ''}
                            {it.baseQuantity !== undefined && it.baseUnit
                              ? ` (= +${formatQty(it.baseQuantity)} ${it.baseUnit})`
                              : ''}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono-num">
                            {formatRupiah(it.unitCost)}
                            {(it.lineDiscount || 0) > 0 && (
                              <div className="text-[10px] text-red-700">
                                Diskon -{formatRupiah(it.lineDiscount || 0)}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono-num">
                            {it.hppBefore !== undefined && it.hppAfter !== undefined ? (
                              <span>
                                {formatRupiah(roundUnitCost(it.hppBefore))} →{' '}
                                <strong className="text-emerald-700">
                                  {formatRupiah(roundUnitCost(it.hppAfter))}
                                </strong>
                              </span>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono-num font-semibold text-slate-900">
                            {formatRupiah(it.netLineTotal ?? it.subtotal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
                <div>
                  <span className="text-slate-500 block">Total Faktur</span>
                  <strong className="font-mono-num text-sm text-slate-900">
                    {formatRupiah(detailPurchase.totalAmount)}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Sudah Dibayar</span>
                  <strong className="font-mono-num text-sm text-emerald-700">
                    {formatRupiah(
                      detailPurchase.paidAmount ??
                        (detailPurchase.paymentMethod === 'credit' ? 0 : detailPurchase.totalAmount)
                    )}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Sisa Utang</span>
                  <strong className="font-mono-num text-sm text-amber-700">
                    {formatRupiah(getPurchaseDebtAmount(detailPurchase))}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Total Retur</span>
                  <strong className="font-mono-num text-sm text-slate-900">
                    {formatRupiah(detailPurchase.returnedAmount || 0)}
                  </strong>
                </div>
              </div>
              {detailPurchase.notes && (
                <p className="text-xs text-slate-600">Catatan: {detailPurchase.notes}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL BAYAR UTANG PEMASOK */}
      {payingPurchase && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmDebtPayment}
            className="bg-white rounded-xl border border-slate-200 w-full max-w-md p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display font-bold text-base text-slate-900">
                  Bayar Utang Pemasok
                </h3>
                <p className="text-xs text-slate-500">
                  {payingPurchase.supplierName} · {payingPurchase.transactionNumber}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPayingPurchase(null)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center justify-between text-xs">
              <span className="text-amber-900 font-medium">Sisa Utang Faktur</span>
              <strong className="font-mono-num text-sm text-amber-900">
                {formatRupiah(getPurchaseDebtAmount(payingPurchase))}
              </strong>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Akun Sumber Dana <span className="text-red-600">*</span>
                </label>
                <select
                  value={debtPayAccountId}
                  onChange={(e) => setDebtPayAccountId(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
                  required
                >
                  {activeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} — Saldo: {formatRupiah(acc.balance)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nominal Pembayaran (Rp) <span className="text-red-600">*</span>
                </label>
                <input
                  type="number"
                  step="any"
                  min="1"
                  max={getPurchaseDebtAmount(payingPurchase)}
                  value={debtPayAmount}
                  onChange={(e) => setDebtPayAmount(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 font-mono-num text-sm"
                  required
                />
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDebtPayAmount(String(getPurchaseDebtAmount(payingPurchase)))}
                    className="text-[11px] font-semibold text-emerald-700 hover:underline cursor-pointer"
                  >
                    Lunasi Penuh
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Catatan (Opsional)
                </label>
                <input
                  type="text"
                  value={debtPayNotes}
                  onChange={(e) => setDebtPayNotes(e.target.value)}
                  maxLength={240}
                  placeholder="Contoh: Cicilan ke-1"
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayingPurchase(null)}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={savingDebtPayment}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {savingDebtPayment ? 'Memproses...' : 'Bayar Utang Sekarang'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
