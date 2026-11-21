import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  ScanBarcode,
  ShoppingCart,
  Plus,
  Minus,
  Trash2,
  Check,
  Package,
  X,
  Receipt,
  Printer,
  Copy,
  MessageCircle,
  UserPlus,
  Download,
  Share2,
  AlertTriangle,
  ShieldAlert,
  ChevronDown,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import type {
  Account,
  Category,
  Customer,
  Product,
  Sale,
  StockBatch,
  StoreSetting,
} from '../types/database';
import {
  createProductWithInitialStock,
  fetchSaleReceiptFromSale,
  formatProductStockSummary,
  formatUnitConversionLabel,
  getPosSellOptions,
  isStockSufficientWithTolerance,
  recordRetailSale,
  resolveUnitPricing,
  roundMoney,
  roundQty,
  snapStockToProductPrecision,
  subscribeRecentSales,
  type RecordedSaleReceipt,
  type RetailCartItem,
} from '../services/inventoryService';
import { createCustomer } from '../services/receivableService';
import { formatQty, formatRupiah } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';
import {
  calculateCombinedPosSettlement,
  getEffectiveQrisFeePercent,
  resolvePosCustomerMatch,
  type RetailPaymentMethod,
} from '../utils/qrisFee';
import {
  buildWhatsAppShareUrl,
  formatPosReceiptText,
  formatWhatsAppDisplayPhone,
  formatWhatsAppReceiptMessage,
  normalizeWhatsAppPhone,
} from '../utils/posReceipt';
import {
  buildRawBtThermalUrl,
  downloadThermalReceiptPdf,
  printThermalReceiptText,
  shareReceiptTextNative,
  type ReceiptPaperWidth,
} from '../utils/receiptPrinter';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import {
  formatShortIdDate,
  summarizeProductBatches,
  type EvaluatedBatchExpiry,
  type ProductBatchSummary,
} from '../utils/expiryUtils';
import { formatProductFullName } from '../utils/productIdentity';

interface PosPageProps {
  products: Product[];
  categories: Category[];
  accounts: Account[];
  customers: Customer[];
  storeSetting: StoreSetting | null;
  stockBatches?: StockBatch[];
}

interface ExpiredCartConflict {
  product: Product;
  demandedBase: number;
  safeSellableStock: number;
  expiredQtyNeeded: number;
  expiredBatches: (StockBatch & EvaluatedBatchExpiry)[];
}

function CartQtyInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (nextQty: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => {
        const raw = e.target.value.replace(',', '.');
        if (!/^[0-9]*\.?[0-9]*$/.test(raw)) return;
        setDraft(raw);
        const parsed = Number(raw);
        if (raw !== '' && !raw.endsWith('.') && Number.isFinite(parsed) && parsed > 0) {
          onCommit(roundQty(parsed));
        }
      }}
      onBlur={() => {
        const parsed = Number(draft.replace(',', '.'));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          setDraft(String(value));
        } else {
          const clean = roundQty(parsed);
          onCommit(clean);
          setDraft(String(clean));
        }
      }}
      aria-label="Jumlah beli"
      className="w-11 sm:w-16 h-8 px-1 text-center font-mono-num text-xs font-semibold rounded-md border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-600"
    />
  );
}

export function PosPage({
  products,
  categories,
  accounts,
  customers,
  storeSetting,
  stockBatches = [],
}: PosPageProps) {
  const { user, profile, isAdmin } = useAuth();
  const { isOnline } = useNetwork();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCat, setSelectedCat] = useState('all');
  const [mobilePane, setMobilePane] = useState<'products' | 'cart'>('products');
  const [cart, setCart] = useState<RetailCartItem[]>([]);
  const [discount, setDiscount] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState<RetailPaymentMethod>('cash');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedQrisAccountId, setSelectedQrisAccountId] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [paidAmount, setPaidAmount] = useState('');
  const [cashPart, setCashPart] = useState('');
  const [qrisPart, setQrisPart] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [receivablePayAmount, setReceivablePayAmount] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const customerComboRef = useRef<HTMLDivElement | null>(null);

  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [quickCustName, setQuickCustName] = useState('');
  const [quickCustPhone, setQuickCustPhone] = useState('');
  const [creatingCust, setCreatingCust] = useState(false);

  const [showQuickProductModal, setShowQuickProductModal] = useState(false);
  const [newProdName, setNewProdName] = useState('');
  const [newProdBrand, setNewProdBrand] = useState('');
  const [newProdVariant, setNewProdVariant] = useState('');
  const [newProdCategory, setNewProdCategory] = useState(categories[0]?.id || '');
  const [newProdUnit, setNewProdUnit] = useState('PCS');
  const [newProdStock, setNewProdStock] = useState('0');
  const [newProdCost, setNewProdCost] = useState('0');
  const [newProdSell, setNewProdSell] = useState('0');
  const [creatingProduct, setCreatingProduct] = useState(false);

  const handleQuickCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newProdName.trim()) return;
    setCreatingProduct(true);
    setFeedback(null);
    try {
      const selectedCatObj = categories.find((c) => c.id === newProdCategory) || categories[0];
      const categoryName = selectedCatObj ? selectedCatObj.name : 'Umum';
      const catId = selectedCatObj ? selectedCatObj.id : (categories[0]?.id || 'cat_produk_lainnya');
      const generatedSku = `SKU-${Date.now().toString(36).toUpperCase()}`;

      const createdId = await createProductWithInitialStock(
        {
          sku: generatedSku,
          name: newProdName.trim(),
          brand: newProdBrand.trim(),
          variant: newProdVariant.trim(),
          categoryId: catId,
          categoryName,
          unit: newProdUnit.trim() || 'PCS',
          stock: Number(newProdStock) || 0,
          costPrice: Number(newProdCost) || 0,
          sellPrice: Number(newProdSell) || 0,
          minStock: 5,
          isActive: true,
        },
        {
          uid: user.uid,
          displayName: activeCashierName || profile?.displayName || user.displayName || 'Kasir',
        },
        products
      );

      const createdProd = products.find((p) => p.id === createdId);
      if (createdProd) {
        addToCart(createdProd);
      }

      setNewProdName('');
      setNewProdBrand('');
      setNewProdVariant('');
      setNewProdStock('0');
      setNewProdCost('0');
      setNewProdSell('0');
      setShowQuickProductModal(false);
      setFeedback({
        kind: 'ok',
        text: 'Produk baru berhasil ditambahkan dan langsung dimasukkan ke keranjang.',
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: getReadableFirestoreError(error),
      });
    } finally {
      setCreatingProduct(false);
    }
  };

  const [processing, setProcessing] = useState(false);
  const checkoutLockRef = useRef(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [receipt, setReceipt] = useState<RecordedSaleReceipt | null>(null);
  const [receiptViewMode, setReceiptViewMode] = useState<'thermal' | 'detail'>('thermal');
  const [receiptPaperWidth, setReceiptPaperWidth] = useState<ReceiptPaperWidth>(58);
  const [printingReceipt, setPrintingReceipt] = useState(false);
  const [printNotice, setPrintNotice] = useState<string | null>(null);
  const [receiptSelectedCustomerId, setReceiptSelectedCustomerId] = useState('');
  const [receiptWaPhone, setReceiptWaPhone] = useState('');
  const [copiedType, setCopiedType] = useState<'receipt' | 'whatsapp' | null>(null);
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [showScanner, setShowScanner] = useState(false);

  const [expiredConflicts, setExpiredConflicts] = useState<ExpiredCartConflict[]>([]);
  const [showExpiredOverrideModal, setShowExpiredOverrideModal] = useState(false);
  const [expiredOverrideReason, setExpiredOverrideReason] = useState('');

  const [activeCashierName, setActiveCashierName] = useState(() => {
    if (typeof window !== 'undefined') {
      return (
        localStorage.getItem('kedaikhanxa_active_cashier') ||
        profile?.displayName ||
        user?.displayName ||
        'Kasir 1'
      );
    }
    return profile?.displayName || user?.displayName || 'Kasir 1';
  });

  useEffect(() => {
    if (typeof window !== 'undefined' && activeCashierName) {
      localStorage.setItem('kedaikhanxa_active_cashier', activeCashierName);
    }
  }, [activeCashierName]);

  const activeAccounts = accounts.filter((a) => a.isActive);
  const activeProducts = products.filter((p) => p.isActive);
  const customerMatch = useMemo(
    () => resolvePosCustomerMatch(customers, customerName, selectedCustomerId),
    [customers, customerName, selectedCustomerId]
  );
  const selectedCustomer = customerMatch.matchedCustomer;
  const isAutoNewCustomer = customerMatch.isNewCustomer;
  const customerPrevDebt = selectedCustomer
    ? roundMoney(Math.max(0, Number(selectedCustomer.totalDebt) || 0))
    : 0;
  const qrisFeePercent = getEffectiveQrisFeePercent(storeSetting);

  useEffect(() => {
    setReceivablePayAmount('');
  }, [selectedCustomer?.id]);

  useEffect(() => {
    if (!showCustomerDropdown) return;
    const handleOutside = (e: MouseEvent) => {
      if (customerComboRef.current && !customerComboRef.current.contains(e.target as Node)) {
        setShowCustomerDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [showCustomerDropdown]);

  const filteredCustomerOptions = useMemo(() => {
    const q = customerName.trim().toLowerCase();
    const sorted = [...customers].sort((a, b) => {
      const aDebt = Number(a.totalDebt) > 0 ? 1 : 0;
      const bDebt = Number(b.totalDebt) > 0 ? 1 : 0;
      if (aDebt !== bDebt) return bDebt - aDebt;
      return a.name.localeCompare(b.name, 'id');
    });
    if (!q || (selectedCustomer && q === selectedCustomer.name.trim().toLowerCase())) {
      return sorted;
    }
    return sorted.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q)
    );
  }, [customers, customerName, selectedCustomer]);

  const batchSummaryByProductId = useMemo(() => {
    const map = new Map<string, ProductBatchSummary>();
    products.forEach((p) => {
      map.set(p.id, summarizeProductBatches(p, stockBatches));
    });
    return map;
  }, [products, stockBatches]);

  useEffect(() => {
    if (!receipt) {
      setReceiptSelectedCustomerId('');
      setReceiptWaPhone('');
      setCopiedType(null);
      setPrintNotice(null);
      setPrintingReceipt(false);
      return;
    }
    setReceiptViewMode('thermal');
    setCopiedType(null);
    setPrintNotice(null);
    setPrintingReceipt(false);
    const matchedById = receipt.customerId
      ? customers.find((c) => c.id === receipt.customerId)
      : undefined;
    const matchedByName =
      !matchedById && receipt.customerName
        ? customers.find(
            (c) => c.name.trim().toLowerCase() === receipt.customerName!.trim().toLowerCase()
          )
        : undefined;
    const resolvedCustomer = matchedById || matchedByName;
    setReceiptSelectedCustomerId(resolvedCustomer?.id || '');
    setReceiptWaPhone(receipt.customerPhone || resolvedCustomer?.phone || '');
  }, [receipt, customers]);

  const receiptText = useMemo(
    () => (receipt ? formatPosReceiptText(receipt, storeSetting) : ''),
    [receipt, storeSetting]
  );

  const whatsappMessage = useMemo(
    () => (receipt ? formatWhatsAppReceiptMessage(receipt, storeSetting) : ''),
    [receipt, storeSetting]
  );

  const normalizedWaPhone = useMemo(
    () => normalizeWhatsAppPhone(receiptWaPhone),
    [receiptWaPhone]
  );

  const waShareUrl = useMemo(
    () => (receipt ? buildWhatsAppShareUrl(receiptWaPhone, whatsappMessage) : null),
    [receipt, receiptWaPhone, whatsappMessage]
  );

  useEffect(() => {
    if (activeAccounts.length === 0) return;
    if (!selectedAccountId) {
      const preferredCash =
        paymentMethod === 'cash' || paymentMethod === 'mixed' || paymentMethod === 'debt'
          ? activeAccounts.find((a) => a.type === 'cash') || activeAccounts[0]
          : activeAccounts.find((a) => a.type === 'bank' || a.type === 'ewallet') ||
            activeAccounts[0];
      if (preferredCash) setSelectedAccountId(preferredCash.id);
    }
    if (!selectedQrisAccountId) {
      const preferredBank =
        activeAccounts.find((a) => a.type === 'bank' || a.type === 'ewallet') || activeAccounts[0];
      if (preferredBank) setSelectedQrisAccountId(preferredBank.id);
    }
  }, [activeAccounts, paymentMethod, selectedAccountId, selectedQrisAccountId]);

  useEffect(() => {
    if (!user) return;
    const unsub = subscribeRecentSales(
      isAdmin,
      user.uid,
      (list) => setRecentSales(list),
      () => {}
    );
    return () => unsub();
  }, [user, isAdmin]);

  // Sinkronkan produk di keranjang dengan stok/harga terbaru dari Firestore
  const syncedCart = cart.map((item) => {
    const latest = products.find((p) => p.id === item.product.id) || item.product;
    return { ...item, product: latest };
  });

  const resolvedCart = syncedCart.map((item) => ({
    item,
    pricing: resolveUnitPricing(item.product, item.unitName, item.quantity, item.tierPreference),
  }));

  const getTotalBaseUsedForProduct = (
    list: RetailCartItem[],
    productId: string,
    excludeLineKey?: string
  ): number => {
    const latestProd = products.find((p) => p.id === productId);
    const total = list.reduce((sum, line) => {
      if (line.product.id !== productId || line.lineKey === excludeLineKey) return sum;
      const latest = latestProd || line.product;
      const res = resolveUnitPricing(latest, line.unitName, line.quantity, line.tierPreference);
      return roundQty(sum + res.baseQuantity);
    }, 0);
    return latestProd ? snapStockToProductPrecision(total, latestProd) : total;
  };

  const subtotal = resolvedCart.reduce((sum, r) => sum + r.pricing.lineRevenue, 0);
  const totalCost = resolvedCart.reduce((sum, r) => sum + r.pricing.lineCost, 0);
  const totalCartQty = roundQty(resolvedCart.reduce((sum, r) => sum + r.item.quantity, 0));
  const numDiscount = Math.max(0, Math.min(subtotal, Number(discount) || 0));
  const totalAmount = Math.max(0, Number((subtotal - numDiscount).toFixed(2)));
  const estimatedProfit = Number((totalAmount - totalCost).toFixed(2));
  const isDebtPayment = paymentMethod === 'debt';
  const isMixedPayment = paymentMethod === 'mixed';
  const isQrisPayment = paymentMethod === 'qris';

  const rawReceivablePayInput = roundMoney(Math.max(0, Number(receivablePayAmount) || 0));
  const numReceivablePay =
    !isDebtPayment && selectedCustomer && customerPrevDebt > 0
      ? roundMoney(Math.min(customerPrevDebt, rawReceivablePayInput))
      : 0;
  const grandTotalDue = isDebtPayment
    ? totalAmount
    : roundMoney(totalAmount + numReceivablePay);

  const numCashPart = roundMoney(Math.max(0, Number(cashPart) || 0));
  const numQrisPart = roundMoney(Math.max(0, Number(qrisPart) || 0));

  const numPaid = isDebtPayment
    ? roundMoney(Math.max(0, Number(paidAmount) || 0))
    : isMixedPayment
      ? roundMoney(numCashPart + numQrisPart)
      : paidAmount === ''
        ? grandTotalDue
        : roundMoney(Math.max(0, Number(paidAmount) || 0));

  const previewCombined = (() => {
    try {
      return calculateCombinedPosSettlement({
        saleTotalAmount: totalAmount,
        paymentMethod,
        paidAmount: numPaid,
        cashPart: numCashPart,
        qrisPart: numQrisPart,
        qrisFeePercent,
        customerPrevDebt,
        receivablePayAmount: numReceivablePay,
      });
    } catch {
      const saleQrisNominal = isQrisPayment
        ? totalAmount
        : isMixedPayment
          ? Math.min(numQrisPart, totalAmount)
          : 0;
      const fee = roundMoney(saleQrisNominal * (qrisFeePercent / 100));
      return {
        saleSettlement: {
          paymentMethod,
          paidAmount: numPaid,
          changeAmount: isDebtPayment ? 0 : Math.max(0, roundMoney(numPaid - grandTotalDue)),
          debtAmount: isDebtPayment ? Math.max(0, roundMoney(totalAmount - numPaid)) : 0,
          cashPaidPart: isDebtPayment ? numPaid : Math.max(0, roundMoney(totalAmount - saleQrisNominal)),
          qrisAmount: saleQrisNominal,
          qrisFeeRate: saleQrisNominal > 0 ? qrisFeePercent : 0,
          qrisFeeAmount: fee,
          netReceivedAmount: isDebtPayment
            ? numPaid
            : roundMoney(Math.max(0, totalAmount - fee)),
          cashDepositAmount: isDebtPayment
            ? numPaid
            : Math.max(0, roundMoney(totalAmount - saleQrisNominal)),
          qrisNetDepositAmount: roundMoney(Math.max(0, saleQrisNominal - fee)),
        },
        receivablePaidAmount: numReceivablePay,
        receivableCashIn:
          paymentMethod === 'cash' || paymentMethod === 'transfer' ? numReceivablePay : 0,
        receivableQrisIn: paymentMethod === 'qris' ? numReceivablePay : 0,
        grandTotalDue,
        grandPaidAmount: numPaid,
        grandChangeAmount: isDebtPayment ? 0 : Math.max(0, roundMoney(numPaid - grandTotalDue)),
        customerDebtBefore: customerPrevDebt,
        customerDebtAfter: isDebtPayment
          ? roundMoney(customerPrevDebt + Math.max(0, totalAmount - numPaid))
          : roundMoney(Math.max(0, customerPrevDebt - numReceivablePay)),
      };
    }
  })();

  const previewSettlement = previewCombined.saleSettlement;
  const changeAmount = previewCombined.grandChangeAmount;
  const debtAddition = previewSettlement.debtAmount;

  const addToCart = (product: Product, preferredUnitName?: string) => {
    setFeedback(null);
    const sellOpts = getPosSellOptions(product);
    const baseRemaining = Math.max(
      0,
      snapStockToProductPrecision(
        (Number(product.stock) || 0) - getTotalBaseUsedForProduct(cart, product.id),
        product
      )
    );
    const fallbackAutoOption =
      sellOpts.find((o) => isStockSufficientWithTolerance(baseRemaining, o.conversion, product)) ||
      sellOpts[0];
    const unitName = preferredUnitName || fallbackAutoOption?.unitName || product.unit || 'PCS';
    const lineKey = `${product.id}__${unitName.toUpperCase()}`;

    const otherUsedBase = getTotalBaseUsedForProduct(cart, product.id, lineKey);
    const existingLine = cart.find((c) => c.lineKey === lineKey);
    const availableBase = Math.max(
      0,
      snapStockToProductPrecision((Number(product.stock) || 0) - otherUsedBase, product)
    );

    let stepToAdd = 1;
    if (!existingLine) {
      const oneUnitPricing = resolveUnitPricing(product, unitName, 1, 'auto');
      const hasSmallerSellUnit = sellOpts.some((o) => o.conversion < oneUnitPricing.option.conversion);
      if (
        availableBase > 0 &&
        availableBase < oneUnitPricing.baseQuantity &&
        oneUnitPricing.option.isBase &&
        !hasSmallerSellUnit
      ) {
        stepToAdd = availableBase;
      }
    }

    const nextQty = roundQty((existingLine?.quantity || 0) + stepToAdd);
    const nextPricing = resolveUnitPricing(
      product,
      unitName,
      nextQty,
      existingLine?.tierPreference || 'auto'
    );

    const nextProposedBase = roundQty(otherUsedBase + nextPricing.baseQuantity);
    if (
      !isStockSufficientWithTolerance(
        Number(product.stock) || 0,
        nextProposedBase,
        product
      )
    ) {
      setFeedback({
        kind: 'err',
        text: `Stok "${product.name}" tidak cukup (butuh ${formatQty(
          nextProposedBase
        )} ${product.unit}, tersedia ${formatProductStockSummary(product.stock, product).primary}).`,
      });
      return;
    }

    const batchSummary = batchSummaryByProductId.get(product.id);
    const touchesExpiredBatch =
      Boolean(batchSummary) &&
      batchSummary!.expiredBatchStock > 0.0001 &&
      nextProposedBase > batchSummary!.safeSellableStock + 0.0001;

    if (touchesExpiredBatch && !isAdmin) {
      setFeedback({
        kind: 'err',
        text: `Produk "${formatProductFullName(product)}" memiliki stok kedaluwarsa (EXPIRED). Stok aman tersisa ${formatQty(
          batchSummary!.safeSellableStock
        )} ${product.unit}; stok kedaluwarsa tidak boleh dijual tanpa persetujuan Admin.`,
      });
      return;
    }

    if (touchesExpiredBatch && isAdmin) {
      setFeedback({
        kind: 'err',
        text: `Perhatian Admin: Jumlah "${formatProductFullName(product)}" menyentuh batch KEDALUWARSA (${formatQty(
          batchSummary!.expiredBatchStock
        )} ${product.unit}). Persetujuan eksplisit Admin akan diminta saat Checkout.`,
      });
    }

    setCart((prev) => {
      const existing = prev.find((c) => c.lineKey === lineKey);
      if (existing) {
        return prev.map((c) =>
          c.lineKey === lineKey ? { ...c, quantity: roundQty(c.quantity + stepToAdd) } : c
        );
      }
      return [
        ...prev,
        {
          lineKey,
          product,
          unitName,
          quantity: stepToAdd,
          tierPreference: 'auto',
        },
      ];
    });
  };

  const setCartLineQty = (lineKey: string, nextQtyRaw: number) => {
    setFeedback(null);
    const cleanNext = roundQty(nextQtyRaw);
    if (cleanNext <= 0) {
      setCart((prev) => prev.filter((item) => item.lineKey !== lineKey));
      return;
    }

    const target = syncedCart.find((i) => i.lineKey === lineKey);
    if (!target) return;

    const otherUsedBase = getTotalBaseUsedForProduct(syncedCart, target.product.id, lineKey);
    const nextPricing = resolveUnitPricing(
      target.product,
      target.unitName,
      cleanNext,
      target.tierPreference
    );

    const nextProposedBase = roundQty(otherUsedBase + nextPricing.baseQuantity);
    if (
      !isStockSufficientWithTolerance(
        Number(target.product.stock) || 0,
        nextProposedBase,
        target.product
      )
    ) {
      setFeedback({
        kind: 'err',
        text: `Stok "${target.product.name}" tidak mencukupi (butuh ${formatQty(
          nextProposedBase
        )} ${target.product.unit}, tersedia ${formatProductStockSummary(
          target.product.stock,
          target.product
        ).primary}).`,
      });
      return;
    }

    const batchSummary = batchSummaryByProductId.get(target.product.id);
    if (
      batchSummary &&
      batchSummary.expiredBatchStock > 0.0001 &&
      nextProposedBase > batchSummary.safeSellableStock + 0.0001 &&
      !isAdmin
    ) {
      setFeedback({
        kind: 'err',
        text: `Stok aman "${target.product.name}" hanya ${formatQty(
          batchSummary.safeSellableStock
        )} ${target.product.unit}. Sisa stok berstatus EXPIRED dan tidak boleh dijual tanpa persetujuan Admin.`,
      });
      return;
    }

    setCart((prev) =>
      prev.map((item) => (item.lineKey === lineKey ? { ...item, quantity: cleanNext } : item))
    );
  };

  const changeCartLineUnit = (lineKey: string, newUnitName: string) => {
    setFeedback(null);
    const target = syncedCart.find((i) => i.lineKey === lineKey);
    if (!target) return;

    const newLineKey = `${target.product.id}__${newUnitName.toUpperCase()}`;
    const existingSameUnit = syncedCart.find(
      (i) => i.lineKey === newLineKey && i.lineKey !== lineKey
    );
    const combinedQty = roundQty(
      existingSameUnit ? existingSameUnit.quantity + target.quantity : target.quantity
    );
    const otherUsedBase = syncedCart.reduce((sum, line) => {
      if (
        line.product.id !== target.product.id ||
        line.lineKey === lineKey ||
        line.lineKey === newLineKey
      ) {
        return sum;
      }
      const res = resolveUnitPricing(
        line.product,
        line.unitName,
        line.quantity,
        line.tierPreference
      );
      return roundQty(sum + res.baseQuantity);
    }, 0);

    const nextPricing = resolveUnitPricing(target.product, newUnitName, combinedQty, 'auto');
    const nextProposedBase = roundQty(otherUsedBase + nextPricing.baseQuantity);
    if (
      !isStockSufficientWithTolerance(
        Number(target.product.stock) || 0,
        nextProposedBase,
        target.product
      )
    ) {
      setFeedback({
        kind: 'err',
        text: `Tidak bisa ubah ke satuan ${newUnitName}: butuh ${formatQty(
          nextProposedBase
        )} ${target.product.unit}, stok tersedia ${formatProductStockSummary(
          target.product.stock,
          target.product
        ).primary}.`,
      });
      return;
    }

    const batchSummary = batchSummaryByProductId.get(target.product.id);
    if (
      batchSummary &&
      batchSummary.expiredBatchStock > 0.0001 &&
      nextProposedBase > batchSummary.safeSellableStock + 0.0001 &&
      !isAdmin
    ) {
      setFeedback({
        kind: 'err',
        text: `Tidak bisa ubah ke ${newUnitName}: stok aman "${target.product.name}" hanya ${formatQty(
          batchSummary.safeSellableStock
        )} ${target.product.unit} (sisanya EXPIRED dan butuh persetujuan Admin).`,
      });
      return;
    }

    setCart((prev) => {
      if (existingSameUnit) {
        return prev
          .filter((i) => i.lineKey !== lineKey)
          .map((i) =>
            i.lineKey === newLineKey
              ? { ...i, quantity: combinedQty, tierPreference: 'auto' }
              : i
          );
      }
      return prev.map((i) =>
        i.lineKey === lineKey
          ? { ...i, lineKey: newLineKey, unitName: newUnitName, tierPreference: 'auto' }
          : i
      );
    });
  };

  const changeCartLineTier = (lineKey: string, tier: 'retail' | 'wholesale') => {
    setCart((prev) =>
      prev.map((item) => (item.lineKey === lineKey ? { ...item, tierPreference: tier } : item))
    );
  };

  const handleBarcodeScan = (code: string) => {
    setShowScanner(false);
    const clean = code.trim().toLowerCase();
    const matched = activeProducts.find(
      (p) => (p.barcode || '').toLowerCase() === clean || p.sku.toLowerCase() === clean
    );
    if (matched) {
      addToCart(matched);
      setFeedback({ kind: 'ok', text: `"${matched.name}" ditambahkan ke keranjang.` });
    } else {
      setSearchQuery(code);
      setFeedback({
        kind: 'err',
        text: `Produk dengan barcode/kode "${code}" belum terdaftar di Produk & Stok.`,
      });
    }
  };

  const handleQuickCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !quickCustName.trim()) return;
    setCreatingCust(true);
    setFeedback(null);
    try {
      const created = await createCustomer(
        {
          name: quickCustName,
          phone: quickCustPhone,
        },
        {
          uid: user.uid,
          displayName: profile?.displayName || user.displayName || 'Kasir',
        }
      );
      setSelectedCustomerId(created.id);
      setCustomerName(created.name);
      setNewCustomerPhone('');
      setQuickCustName('');
      setQuickCustPhone('');
      setShowQuickCustomer(false);
      setFeedback({
        kind: 'ok',
        text: `Pelanggan "${created.name}" ditambahkan dan siap dipilih.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: getReadableFirestoreError(error),
      });
    } finally {
      setCreatingCust(false);
    }
  };

  const handleCopyText = async (type: 'receipt' | 'whatsapp', text: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', 'true');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopiedType(type);
      window.setTimeout(() => {
        setCopiedType((curr) => (curr === type ? null : curr));
      }, 2200);
    } catch {
      setFeedback({
        kind: 'err',
        text: 'Gagal menyalin teks struk secara otomatis. Silakan salin manual dari pratinjau.',
      });
    }
  };

  const handlePrintThermalReceipt = async () => {
    if (!receipt || printingReceipt) return;
    setPrintingReceipt(true);
    setPrintNotice(null);
    try {
      const outcome = await printThermalReceiptText(receiptText, {
        title: `Struk ${receipt.transactionNumber}`,
        paperWidthMm: receiptPaperWidth,
      });
      if (outcome.status !== 'printed') {
        setPrintNotice(
          outcome.message ||
            'Dialog cetak langsung diblokir di mode pratinjau/browser ini. Gunakan Unduh PDF Struk atau Printer Bluetooth (RawBT).'
        );
      }
    } finally {
      setPrintingReceipt(false);
    }
  };

  const handleDownloadReceiptPdf = () => {
    if (!receipt) return;
    setPrintNotice(null);
    downloadThermalReceiptPdf(
      receiptText,
      `Struk_${receipt.transactionNumber}`,
      receiptPaperWidth
    );
  };

  const handleShareReceiptText = async () => {
    if (!receipt) return;
    const res = await shareReceiptTextNative(
      receiptText,
      `Struk ${receipt.transactionNumber}`
    );
    if (res === 'unsupported') {
      await handleCopyText('receipt', receiptText);
    }
  };

  const handleOpenRecentSaleReceipt = async (sale: Sale) => {
    if (!user || loadingReceiptId) return;
    setLoadingReceiptId(sale.id);
    setFeedback(null);
    try {
      const loadedReceipt = await fetchSaleReceiptFromSale(sale, isAdmin, user.uid, customers);
      setReceipt(loadedReceipt);
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: getReadableFirestoreError(error),
      });
    } finally {
      setLoadingReceiptId(null);
    }
  };

  const inspectExpiredCartConflicts = (targetCart: RetailCartItem[]): ExpiredCartConflict[] => {
    const demandByProduct = new Map<string, { product: Product; totalBase: number }>();
    targetCart.forEach((line) => {
      const res = resolveUnitPricing(line.product, line.unitName, line.quantity, line.tierPreference);
      const curr = demandByProduct.get(line.product.id);
      if (curr) {
        curr.totalBase = roundQty(curr.totalBase + res.baseQuantity);
      } else {
        demandByProduct.set(line.product.id, {
          product: line.product,
          totalBase: res.baseQuantity,
        });
      }
    });

    const conflicts: ExpiredCartConflict[] = [];
    for (const [productId, { product, totalBase }] of demandByProduct.entries()) {
      const summary = batchSummaryByProductId.get(productId);
      if (!summary) continue;
      if (summary.expiredBatchStock > 0.0001 && totalBase > summary.safeSellableStock + 0.0001) {
        conflicts.push({
          product,
          demandedBase: totalBase,
          safeSellableStock: summary.safeSellableStock,
          expiredQtyNeeded: roundQty(Math.max(0, totalBase - summary.safeSellableStock)),
          expiredBatches: summary.activeExpiredBatches,
        });
      }
    }
    return conflicts;
  };

  const executeCheckoutSale = async (
    allowExpiredOverride: boolean,
    overrideReason?: string
  ) => {
    if (!user || syncedCart.length === 0 || checkoutLockRef.current) return;

    checkoutLockRef.current = true;
    setProcessing(true);
    setFeedback(null);

    const chosenCashAccount = activeAccounts.find((a) => a.id === selectedAccountId) || null;
    const chosenQrisAccount =
      activeAccounts.find((a) => a.id === selectedQrisAccountId) || chosenCashAccount;

    try {
      const result = await recordRetailSale(
        {
          items: syncedCart,
          discount: numDiscount,
          paidAmount: numPaid,
          paymentMethod,
          cashPart: isMixedPayment ? numCashPart : undefined,
          qrisPart: isMixedPayment ? numQrisPart : undefined,
          qrisFeePercent,
          account: isQrisPayment ? chosenQrisAccount : chosenCashAccount,
          qrisAccount: chosenQrisAccount,
          customer: selectedCustomer,
          customerName: customerMatch.cleanName,
          autoCreateCustomer: isAutoNewCustomer,
          newCustomerPhone: isAutoNewCustomer ? newCustomerPhone : undefined,
          receivablePayAmount: numReceivablePay,
          batches: stockBatches,
          allowExpiredOverride,
          expiredOverrideReason: overrideReason,
        },
        {
          uid: user.uid,
          displayName: activeCashierName.trim() || profile?.displayName || user.displayName || 'Kasir 1',
        }
      );

      setCart([]);
      setDiscount('0');
      setPaidAmount('');
      setCashPart('');
      setQrisPart('');
      setCustomerName('');
      setNewCustomerPhone('');
      setReceivablePayAmount('');
      setSelectedCustomerId('');
      setShowCustomerDropdown(false);
      setPaymentMethod('cash');
      setShowExpiredOverrideModal(false);
      setExpiredConflicts([]);
      setExpiredOverrideReason('');
      setReceipt(result);

      const newCustNote =
        isAutoNewCustomer && result.customerName
          ? ` Pelanggan baru "${result.customerName}" otomatis disimpan.`
          : '';
      const recPayNote =
        (result.receivablePaidAmount || 0) > 0
          ? ` Bayar piutang ${formatRupiah(result.receivablePaidAmount || 0)} (sisa ${formatRupiah(
              result.customerDebtAfter ?? 0
            )}).`
          : '';

      setFeedback({
        kind: 'ok',
        text: isOnline
          ? result.debtAmount > 0
            ? `Kasbon ${result.transactionNumber} untuk ${result.customerName} dicatat (${formatRupiah(
                result.debtAmount
              )} masuk piutang).${newCustNote}`
            : result.qrisFeeAmount > 0
              ? `Transaksi ${result.transactionNumber} selesai. Omzet ${formatRupiah(
                  result.totalAmount
                )}, potongan QRIS ${formatRupiah(result.qrisFeeAmount)}, bersih ${formatRupiah(
                  result.netReceivedAmount
                )}.${recPayNote}${newCustNote}`
              : isAdmin
                ? `Transaksi ${result.transactionNumber} selesai. Stok terpotong otomatis, laba tercatat ${formatRupiah(
                    result.totalProfit
                  )}.${recPayNote}${newCustNote}`
                : `Transaksi ${result.transactionNumber} selesai. Stok terpotong otomatis.${recPayNote}${newCustNote}`
          : `Transaksi ${result.transactionNumber} disimpan lokal (offline) & stok langsung diperbarui.${recPayNote}${newCustNote}`,
      });
    } catch (error) {
      setFeedback({
        kind: 'err',
        text: getReadableFirestoreError(error),
      });
    } finally {
      setProcessing(false);
      checkoutLockRef.current = false;
    }
  };

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || syncedCart.length === 0 || checkoutLockRef.current) return;

    if (isDebtPayment) {
      if (!selectedCustomer && !isAutoNewCustomer) {
        setFeedback({
          kind: 'err',
          text: 'Pilih atau ketik nama pelanggan terlebih dahulu untuk mencatat transaksi Kasbon / Piutang.',
        });
        return;
      }
      if (numPaid >= totalAmount && totalAmount > 0) {
        setFeedback({
          kind: 'err',
          text: 'DP sama dengan atau melebihi total tagihan. Pilih Tunai/Transfer/QRIS jika dibayar lunas.',
        });
        return;
      }
    } else {
      if (rawReceivablePayInput > customerPrevDebt + 0.001) {
        setFeedback({
          kind: 'err',
          text: `Nominal bayar piutang (${formatRupiah(
            rawReceivablePayInput
          )}) melebihi sisa piutang pelanggan (${formatRupiah(customerPrevDebt)}).`,
        });
        return;
      }
      if (isMixedPayment) {
        if (numQrisPart <= 0 || numCashPart <= 0) {
          setFeedback({
            kind: 'err',
            text: 'Pada pembayaran gabungan, nominal Tunai dan QRIS masing-masing harus lebih dari Rp0.',
          });
          return;
        }
        if (numQrisPart > grandTotalDue) {
          setFeedback({
            kind: 'err',
            text: 'Nominal bagian QRIS tidak boleh melebihi total tagihan.',
          });
          return;
        }
        if (numPaid < grandTotalDue) {
          setFeedback({
            kind: 'err',
            text: 'Total gabungan Tunai + QRIS kurang dari total tagihan.',
          });
          return;
        }
      } else if (numPaid < grandTotalDue) {
        setFeedback({
          kind: 'err',
          text:
            numReceivablePay > 0
              ? 'Nominal uang dibayar kurang dari total belanja + bayar piutang.'
              : 'Nominal uang dibayar kurang dari total belanja.',
        });
        return;
      }
    }

    const conflicts = inspectExpiredCartConflicts(syncedCart);
    if (conflicts.length > 0) {
      if (!isAdmin) {
        const names = conflicts.map((c) => formatProductFullName(c.product)).join(', ');
        setFeedback({
          kind: 'err',
          text: `Transaksi ditolak: ${names} memiliki stok KEDALUWARSA (EXPIRED) yang tidak boleh dijual tanpa persetujuan Admin.`,
        });
        return;
      }
      setExpiredConflicts(conflicts);
      setExpiredOverrideReason('');
      setShowExpiredOverrideModal(true);
      return;
    }

    await executeCheckoutSale(false);
  };

  const handleConfirmExpiredOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (expiredOverrideReason.trim().length < 3) {
      setFeedback({
        kind: 'err',
        text: 'Masukkan alasan persetujuan Admin minimal 3 karakter sebelum menjual barang kedaluwarsa.',
      });
      return;
    }
    await executeCheckoutSale(true, expiredOverrideReason.trim());
  };

  const filteredProducts = activeProducts.filter((p) => {
    if (selectedCat !== 'all' && p.categoryId !== selectedCat) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        (p.brand || '').toLowerCase().includes(q) ||
        (p.variant || '').toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-5 -mx-2 sm:mx-0">
      {feedback && (
        <div
          className={`p-3 sm:p-4 rounded-xl border text-xs sm:text-sm ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Pengalih Panel Mobile Portrait (<640px) agar form & katalog tidak sempit */}
      <div className="sm:hidden grid grid-cols-2 gap-1.5 bg-white border border-slate-200 rounded-xl p-1">
        <button
          type="button"
          onClick={() => setMobilePane('products')}
          className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
            mobilePane === 'products'
              ? 'bg-emerald-700 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-50'
          }`}
        >
          Produk ({filteredProducts.length})
        </button>
        <button
          type="button"
          onClick={() => setMobilePane('cart')}
          className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer truncate ${
            mobilePane === 'cart'
              ? 'bg-emerald-700 text-white shadow-sm'
              : 'text-slate-700 bg-emerald-50/60 hover:bg-emerald-50'
          }`}
        >
          Keranjang ({formatQty(totalCartQty)} · {formatRupiah(grandTotalDue)})
        </button>
      </div>

      {/* Dua Kolom Berdampingan pada Landscape / Tablet / Desktop dengan Scroll Terpisah */}
      <div className="grid grid-cols-12 gap-2 sm:gap-4 items-stretch h-[calc(100dvh-12rem)] min-h-[360px] sm:h-[calc(100dvh-8.75rem)] sm:min-h-[280px] [@media(orientation:landscape)_and_(max-height:500px)]:h-[calc(100dvh-5.75rem)] lg:h-[calc(100dvh-7.75rem)] lg:min-h-[480px]">
        {/* Kiri: Daftar Produk Kasir (Scroll Terpisah) */}
        <section
          aria-label="Daftar Produk Kasir"
          className={`${
            mobilePane === 'products' ? 'flex' : 'hidden sm:flex'
          } col-span-12 sm:col-span-6 lg:col-span-7 flex-col min-h-0 bg-white border border-slate-200 rounded-xl overflow-hidden`}
        >
          <div className="shrink-0 p-2 sm:p-3 border-b border-slate-200 bg-white space-y-2">
            <div className="flex flex-col sm:flex-row gap-1.5 sm:gap-2">
              <div className="flex-1 flex gap-1.5">
                <div className="relative flex-1 min-w-0">
                  <Search className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 absolute left-2.5 sm:left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Cari / barcode..."
                    aria-label="Cari produk atau barcode"
                    className="w-full min-h-[40px] sm:min-h-[44px] pl-8 sm:pl-9 pr-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowScanner(true)}
                  aria-label="Scan Barcode"
                  className="min-h-[40px] sm:min-h-[44px] px-2.5 sm:px-3.5 py-1.5 rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 inline-flex items-center justify-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <ScanBarcode className="w-4 h-4" />
                  <span className="hidden sm:inline">Scan Barcode</span>
                </button>
              </div>

              <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs shrink-0">
                <span className="font-semibold text-slate-600 whitespace-nowrap">Kasir:</span>
                <select
                  value={activeCashierName}
                  onChange={(e) => setActiveCashierName(e.target.value)}
                  aria-label="Pilih Kasir / Operator"
                  className="bg-transparent font-semibold text-emerald-800 focus:outline-none cursor-pointer"
                >
                  <option value="Kasir 1">Kasir 1</option>
                  <option value="Kasir 2">Kasir 2</option>
                  <option value="Kasir Shift Pagi">Shift Pagi</option>
                  <option value="Kasir Shift Sore">Shift Sore</option>
                  {profile?.displayName && <option value={profile.displayName}>{profile.displayName}</option>}
                </select>
              </div>

              <select
                value={selectedCat}
                onChange={(e) => setSelectedCat(e.target.value)}
                aria-label="Filter Kategori Kasir"
                className="min-h-[38px] sm:min-h-[44px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 sm:max-w-[170px]"
              >
                <option value="all">Semua Kategori</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setShowQuickProductModal(true)}
                aria-label="Tambah Produk Baru"
                className="min-h-[38px] sm:min-h-[44px] px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 inline-flex items-center justify-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer shadow-sm"
              >
                <Plus className="w-4 h-4" />
                <span>+ Produk Baru</span>
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 sm:p-3">
            {filteredProducts.length === 0 ? (
              <div className="py-10 text-center text-xs sm:text-sm text-slate-500 space-y-2">
                <Package className="w-8 h-8 text-slate-400 mx-auto" />
                <div>
                  {activeProducts.length === 0
                    ? 'Belum ada produk aktif. Tambahkan produk di menu Produk & Stok terlebih dahulu.'
                    : 'Produk tidak ditemukan.'}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-2 sm:gap-2.5">
                {filteredProducts.map((p) => {
                  const usedInCart = getTotalBaseUsedForProduct(syncedCart, p.id);
                  const remaining = Math.max(0, snapStockToProductPrecision(p.stock - usedInCart, p));
                  const out = p.stock <= 1e-6;
                  const sellOpts = getPosSellOptions(p);
                  const defaultOpt = sellOpts[0];
                  const stockSummary = formatProductStockSummary(p.stock, p);
                  const remainingSummary = formatProductStockSummary(remaining, p);
                  const batchSummary = batchSummaryByProductId.get(p.id);
                  const allExpiredLockedForKasir =
                    !isAdmin &&
                    Boolean(batchSummary) &&
                    batchSummary!.hasExpiredStock &&
                    batchSummary!.safeSellableStock <= 0.0001;
                  const cardDisabled = out || allExpiredLockedForKasir;
                  return (
                    <div
                      key={p.id}
                      className={`text-left border rounded-xl p-2 sm:p-3 flex flex-col justify-between gap-1.5 sm:gap-2 transition-colors ${
                        cardDisabled
                          ? 'bg-slate-50 border-slate-200 opacity-65'
                          : batchSummary?.hasExpiredStock
                            ? 'bg-red-50/30 border-red-200 hover:border-red-400'
                            : batchSummary?.hasNearExpiry
                              ? 'bg-amber-50/30 border-amber-200 hover:border-amber-400'
                              : 'bg-white border-slate-200 hover:border-emerald-500 active:bg-emerald-50/40'
                      }`}
                    >
                      <button
                        type="button"
                        disabled={cardDisabled}
                        onClick={() => addToCart(p)}
                        className={`text-left space-y-1.5 w-full ${
                          cardDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
                        }`}
                      >
                        {p.photoDataUrl ? (
                          <img
                            src={p.photoDataUrl}
                            alt={p.name}
                            referrerPolicy="no-referrer"
                            className="w-full h-16 sm:h-auto sm:aspect-[4/3] rounded-lg object-cover border border-slate-100"
                          />
                        ) : (
                          <div className="w-full h-12 sm:h-auto sm:aspect-[4/3] rounded-lg bg-slate-100 flex items-center justify-center text-slate-400">
                            <Package className="w-5 h-5 sm:w-6 sm:h-6" />
                          </div>
                        )}
                        <div>
                          <div className="text-xs sm:text-sm font-medium text-slate-900 line-clamp-2 leading-snug">
                            {p.name}
                          </div>
                          {(p.brand || p.variant) && (
                            <div className="text-[10px] text-slate-500 truncate">
                              {[p.brand, p.variant].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </div>
                        <div className="space-y-0.5 pt-0.5">
                          <div className="font-mono-num text-xs sm:text-sm font-bold text-emerald-700 truncate">
                            {formatRupiah(defaultOpt.sellPrice)}/{defaultOpt.unitName}
                          </div>
                          {defaultOpt.wholesalePrice !== undefined && defaultOpt.wholesalePrice > 0 && (
                            <div className="text-[10px] sm:text-[11px] font-mono-num text-slate-500 truncate">
                              Grosir {formatRupiah(defaultOpt.wholesalePrice)}
                              {defaultOpt.wholesaleMinQty
                                ? ` (≥${formatQty(defaultOpt.wholesaleMinQty)})`
                                : ''}
                            </div>
                          )}
                          <div
                            className={`text-[10px] sm:text-[11px] font-mono-num ${
                              out
                                ? 'text-red-700 font-semibold'
                                : remaining <= p.minStock
                                  ? 'text-amber-700'
                                  : 'text-slate-500'
                            }`}
                          >
                            {out ? (
                              'Stok Habis'
                            ) : usedInCart > 0 ? (
                              <>
                                <div className="truncate">Sisa: {remainingSummary.primary}</div>
                                <div className="text-[10px] text-slate-400 truncate">
                                  Keranjang: {formatQty(usedInCart)} {p.unit}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="truncate">Stok: {stockSummary.primary}</div>
                                {stockSummary.secondary && (
                                  <div className="text-[10px] text-slate-400 truncate">
                                    ({stockSummary.secondary})
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                          {!out && batchSummary && batchSummary.hasExpiredStock && (
                            <div className="text-[10px] font-semibold text-red-700 leading-tight">
                              {allExpiredLockedForKasir
                                ? 'EXPIRED · Butuh Admin'
                                : `EXPIRED: ${formatQty(batchSummary.expiredBatchStock)} ${p.unit} (Aman ${formatQty(batchSummary.safeSellableStock)})`}
                            </div>
                          )}
                          {!out && batchSummary && !batchSummary.hasExpiredStock && batchSummary.hasNearExpiry && batchSummary.nearestNonExpired && (
                            <div className="text-[10px] font-semibold text-amber-700 leading-tight truncate">
                              ED {formatShortIdDate(batchSummary.nearestNonExpired.effectiveExpiryDate)} ({batchSummary.nearestNonExpired.daysRemaining} hr)
                            </div>
                          )}
                        </div>
                      </button>

                      {sellOpts.length > 1 && (
                        <div className="pt-1 border-t border-slate-100 flex flex-wrap gap-1">
                          {sellOpts.map((opt) => {
                            const hasSmallerSellUnit = sellOpts.some(
                              (o) => o.conversion < opt.conversion
                            );
                            const canAddUnit =
                              isStockSufficientWithTolerance(remaining, opt.conversion, p) ||
                              (opt.isBase && !hasSmallerSellUnit && remaining > 1e-6);
                            return (
                              <button
                                key={opt.unitName}
                                type="button"
                                disabled={cardDisabled || !canAddUnit}
                                onClick={() => addToCart(p, opt.unitName)}
                                title={`Tambah 1 ${opt.unitName} (${formatRupiah(opt.sellPrice)})`}
                                className="px-1.5 sm:px-2 py-1 rounded border border-slate-200 bg-slate-50 text-[10px] font-mono-num font-medium text-slate-700 hover:border-emerald-600 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                              >
                                +{opt.unitName}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Kanan: Keranjang Kasir & Pembayaran (Scroll Terpisah + Footer Checkout Tetap Terlihat) */}
        <form
          onSubmit={handleCheckout}
          aria-label="Keranjang Kasir"
          className={`${
            mobilePane === 'cart' ? 'flex' : 'hidden sm:flex'
          } col-span-12 sm:col-span-6 lg:col-span-5 flex-col min-h-0 bg-white border border-slate-200 rounded-xl overflow-hidden`}
        >
          <div className="shrink-0 px-2.5 py-2 sm:px-4 sm:py-3 border-b border-slate-200 flex items-center justify-between gap-1 bg-white">
            <div className="flex items-center gap-1.5 min-w-0">
              <ShoppingCart className="w-4 h-4 text-emerald-700 shrink-0" />
              <h3 className="font-display font-semibold text-xs sm:text-base text-slate-900 truncate">
                Keranjang
              </h3>
              <span className="font-mono-num text-[11px] sm:text-xs text-slate-500 shrink-0">
                · {formatQty(totalCartQty)}
              </span>
            </div>
            {cart.length > 0 && (
              <button
                type="button"
                onClick={() => setCart([])}
                className="text-[11px] sm:text-xs text-red-700 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                Kosongkan
              </button>
            )}
          </div>

          {/* Area Scroll Mandiri: Item Keranjang + Detail Pembayaran */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 sm:p-3.5 space-y-3">
            {resolvedCart.length === 0 ? (
              <div className="py-6 sm:py-8 text-center text-[11px] sm:text-sm text-slate-500">
                Ketuk produk di sebelah kiri atau scan barcode untuk menambahkan ke keranjang.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 space-y-2.5">
                {resolvedCart.map(({ item, pricing }) => {
                  const sellOpts = getPosSellOptions(item.product);
                  return (
                    <div key={item.lineKey} className="pt-2.5 first:pt-0 space-y-1.5">
                      <div className="flex items-start justify-between gap-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs sm:text-sm font-semibold text-slate-900 truncate">
                            {formatProductFullName(item.product)}
                          </div>
                          <div className="text-[10px] sm:text-xs font-mono-num text-slate-500 truncate">
                            {formatRupiah(pricing.unitPrice)} / {pricing.option.unitName}
                            {pricing.option.conversion !== 1
                              ? ` (${formatUnitConversionLabel(pricing.option, item.product.unit)})`
                              : ''}
                          </div>
                          {(() => {
                            const bSum = batchSummaryByProductId.get(item.product.id);
                            if (!bSum) return null;
                            const usedBase = getTotalBaseUsedForProduct(syncedCart, item.product.id);
                            if (bSum.expiredBatchStock > 0.0001 && usedBase > bSum.safeSellableStock + 0.0001) {
                              return (
                                <div className="text-[10px] font-semibold text-red-700 flex items-center gap-1 mt-0.5">
                                  <AlertTriangle className="w-3 h-3 shrink-0" />
                                  <span>Menyentuh batch EXPIRED (Wajib Persetujuan Admin)</span>
                                </div>
                              );
                            }
                            if (bSum.hasNearExpiry && bSum.nearestNonExpired) {
                              return (
                                <div className="text-[10px] font-medium text-amber-700 mt-0.5">
                                  ED terdekat: {formatShortIdDate(bSum.nearestNonExpired.effectiveExpiryDate)} ({bSum.nearestNonExpired.daysRemaining} hr)
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                        <button
                          type="button"
                          onClick={() => setCartLineQty(item.lineKey, 0)}
                          className="w-7 h-7 rounded-md text-slate-400 hover:text-red-700 flex items-center justify-center shrink-0 cursor-pointer"
                          aria-label={`Hapus ${item.product.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Pilih Satuan, Ecer/Grosir, & Qty */}
                      <div className="flex flex-wrap items-center justify-between gap-1.5 min-w-0 max-w-full">
                        <div className="flex flex-wrap items-center gap-1 min-w-0 max-w-full">
                          {sellOpts.length > 1 ? (
                            <select
                              value={pricing.option.unitName}
                              onChange={(e) => changeCartLineUnit(item.lineKey, e.target.value)}
                              aria-label={`Pilih satuan ${item.product.name}`}
                              className="min-h-[32px] w-full max-w-[130px] sm:w-auto sm:max-w-none px-1.5 py-1 rounded-md border border-slate-300 text-[11px] sm:text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                            >
                              {sellOpts.map((opt) => (
                                <option key={opt.unitName} value={opt.unitName}>
                                  {opt.unitName} ({formatUnitConversionLabel(opt, item.product.unit)})
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-[11px] font-medium text-slate-600">
                              {pricing.option.unitName}
                            </span>
                          )}

                          {pricing.hasWholesale && (
                            <div className="inline-flex rounded-md border border-slate-200 p-0.5 bg-slate-50 text-[10px] sm:text-[11px]">
                              <button
                                type="button"
                                onClick={() => changeCartLineTier(item.lineKey, 'retail')}
                                className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                                  pricing.priceTier === 'retail'
                                    ? 'bg-white text-slate-900 font-semibold shadow-sm'
                                    : 'text-slate-500 hover:text-slate-900'
                                }`}
                              >
                                Ecer
                              </button>
                              <button
                                type="button"
                                onClick={() => changeCartLineTier(item.lineKey, 'wholesale')}
                                className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                                  pricing.priceTier === 'wholesale'
                                    ? 'bg-emerald-700 text-white font-semibold'
                                    : 'text-slate-500 hover:text-slate-900'
                                }`}
                              >
                                Grosir
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setCartLineQty(item.lineKey, roundQty(item.quantity - 1))}
                            className="w-7 h-8 sm:w-8 rounded-md border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
                            aria-label="Kurangi"
                          >
                            <Minus className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                          </button>
                          <CartQtyInput
                            value={item.quantity}
                            onCommit={(nextVal) => setCartLineQty(item.lineKey, nextVal)}
                          />
                          <button
                            type="button"
                            onClick={() => setCartLineQty(item.lineKey, roundQty(item.quantity + 1))}
                            className="w-7 h-8 sm:w-8 rounded-md border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
                            aria-label="Tambah"
                          >
                            <Plus className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Rincian Stok Terpotong, Subtotal, & Laba Baris (Khusus Admin) */}
                      <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] sm:text-[11px] font-mono-num text-slate-500">
                        <span>
                          -{formatQty(pricing.baseQuantity)} {item.product.unit}
                        </span>
                        <span className="text-right">
                          <strong className="text-slate-900">{formatRupiah(pricing.lineRevenue)}</strong>
                          {isAdmin && (
                            <>
                              {' · '}
                              <span
                                className={
                                  pricing.lineProfit >= 0 ? 'text-emerald-700 font-semibold' : 'text-red-700'
                                }
                              >
                                +{formatRupiah(pricing.lineProfit)}
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Form Pembayaran */}
            <div className="border-t border-slate-200 pt-3 space-y-2.5 text-xs sm:text-sm">
              <div className="space-y-1 text-[11px] sm:text-xs">
                <div className="flex justify-between text-slate-600">
                  <span>Jumlah Barang</span>
                  <span className="font-mono-num font-medium text-slate-900">
                    {formatQty(totalCartQty)} ({resolvedCart.length} baris)
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal (Omzet)</span>
                  <span className="font-mono-num font-semibold text-slate-900">
                    {formatRupiah(subtotal)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label htmlFor="pos-disc" className="block text-[11px] sm:text-xs font-medium text-slate-700">
                    Diskon (Rp)
                  </label>
                  <input
                    id="pos-disc"
                    type="number"
                    min="0"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                    className="w-full min-h-[38px] sm:min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="pos-method" className="block text-[11px] sm:text-xs font-medium text-slate-700">
                    Metode Bayar
                  </label>
                  <select
                    id="pos-method"
                    value={paymentMethod}
                    onChange={(e) => {
                      const next = e.target.value as RetailPaymentMethod;
                      setPaymentMethod(next);
                      if (next === 'debt') {
                        setPaidAmount('');
                        setReceivablePayAmount('');
                      } else if (next === 'mixed') {
                        const baseDue = roundMoney(totalAmount + numReceivablePay);
                        const half = Math.round(baseDue / 2);
                        setQrisPart(String(half));
                        setCashPart(String(roundMoney(Math.max(0, baseDue - half))));
                      }
                    }}
                    className="w-full min-h-[38px] sm:min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    <option value="cash">Tunai (0% Biaya)</option>
                    <option value="qris">QRIS ({formatQty(qrisFeePercent)}%)</option>
                    <option value="mixed">Gabungan (Tunai + QRIS)</option>
                    <option value="transfer">Transfer Bank (0% Biaya)</option>
                    <option value="debt">Kasbon / Piutang</option>
                  </select>
                </div>
              </div>

              {/* Pelanggan / Pembeli Unified Combobox (Otomatis Daftarkan Nama Baru & Tampilkan Piutang Aktif) */}
              <div
                ref={customerComboRef}
                className={`p-2.5 rounded-lg border space-y-2 ${
                  isDebtPayment
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <label
                    htmlFor="pos-customer-input"
                    className={`block text-[11px] sm:text-xs font-semibold ${
                      isDebtPayment ? 'text-amber-900' : 'text-slate-700'
                    }`}
                  >
                    {isDebtPayment ? 'Pelanggan Kasbon *' : 'Pelanggan / Pembeli'}
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowQuickCustomer(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 underline cursor-pointer"
                  >
                    <UserPlus className="w-3 h-3" />
                    <span>+ Form Lengkap</span>
                  </button>
                </div>

                <div className="relative">
                  <input
                    id="pos-customer-input"
                    type="text"
                    maxLength={100}
                    autoComplete="off"
                    value={customerName}
                    onFocus={() => setShowCustomerDropdown(true)}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomerName(val);
                      setSelectedCustomerId('');
                      setShowCustomerDropdown(true);
                    }}
                    placeholder={
                      isDebtPayment
                        ? 'Ketik / pilih nama pelanggan...'
                        : 'Ketik / pilih nama (kosong = Umum)'
                    }
                    className={`w-full min-h-[38px] pl-2.5 pr-14 py-1.5 rounded-lg border text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 ${
                      isDebtPayment ? 'border-amber-300' : 'border-slate-300'
                    }`}
                  />
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                    {(customerName || selectedCustomerId) && (
                      <button
                        type="button"
                        onClick={() => {
                          setCustomerName('');
                          setSelectedCustomerId('');
                          setNewCustomerPhone('');
                          setReceivablePayAmount('');
                          setShowCustomerDropdown(false);
                        }}
                        aria-label="Hapus pilihan pelanggan"
                        className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowCustomerDropdown((prev) => !prev)}
                      aria-label="Buka daftar pelanggan"
                      className="w-6 h-6 rounded flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {showCustomerDropdown && (
                    <div className="absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg divide-y divide-slate-100 text-xs">
                      {isAutoNewCustomer && (
                        <button
                          type="button"
                          onClick={() => setShowCustomerDropdown(false)}
                          className="w-full text-left px-2.5 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 font-medium flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <span className="truncate">
                            + Otomatis daftarkan: <strong>"{customerMatch.cleanName}"</strong>
                          </span>
                          <span className="text-[10px] font-semibold text-emerald-700 shrink-0">
                            Baru
                          </span>
                        </button>
                      )}
                      {filteredCustomerOptions.length === 0 ? (
                        <div className="px-2.5 py-2 text-[11px] text-slate-500">
                          {isAutoNewCustomer
                            ? 'Nama baru akan langsung tersimpan sebagai pelanggan saat checkout.'
                            : 'Belum ada pelanggan terdaftar.'}
                        </div>
                      ) : (
                        filteredCustomerOptions.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setSelectedCustomerId(c.id);
                              setCustomerName(c.name);
                              setNewCustomerPhone('');
                              setShowCustomerDropdown(false);
                            }}
                            className={`w-full text-left px-2.5 py-2 hover:bg-slate-50 flex items-center justify-between gap-2 cursor-pointer ${
                              selectedCustomer?.id === c.id ? 'bg-emerald-50/70' : ''
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-slate-900 truncate">{c.name}</div>
                              {c.phone && (
                                <div className="text-[10px] font-mono-num text-slate-500 truncate">
                                  WA {formatWhatsAppDisplayPhone(c.phone)}
                                </div>
                              )}
                            </div>
                            {c.totalDebt > 0 && (
                              <span className="text-[10px] font-mono-num font-semibold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded shrink-0">
                                Piutang {formatRupiah(c.totalDebt)}
                              </span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Info Pelanggan Baru Otomatis + Input No WA Opsional */}
                {isAutoNewCustomer && (
                  <div className="p-2 rounded-md bg-emerald-50 border border-emerald-200 space-y-1.5">
                    <div className="text-[11px] font-medium text-emerald-900 leading-snug">
                      Pelanggan baru <strong>"{customerMatch.cleanName}"</strong> akan otomatis
                      disimpan ke daftar Pelanggan saat transaksi selesai.
                    </div>
                    <input
                      type="text"
                      maxLength={24}
                      value={newCustomerPhone}
                      onChange={(e) => setNewCustomerPhone(e.target.value)}
                      placeholder="No. HP / WhatsApp (opsional)"
                      aria-label="No HP pelanggan baru opsional"
                      className="w-full min-h-[34px] px-2.5 py-1 rounded-md border border-emerald-300 bg-white text-[11px] font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                )}

                {/* Info Pelanggan Terdaftar & Piutang Aktif (Muncul Otomatis) */}
                {selectedCustomer && (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] sm:text-[11px] text-slate-600">
                      <span className="font-medium text-emerald-800 truncate">
                        Terdaftar: {selectedCustomer.name}
                      </span>
                      <span className="font-mono-num">
                        {selectedCustomer.phone
                          ? `WA ${formatWhatsAppDisplayPhone(selectedCustomer.phone)}`
                          : 'Belum ada WA'}
                      </span>
                    </div>

                    {customerPrevDebt > 0 && (
                      <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-300 space-y-2">
                        <div className="flex items-center justify-between gap-2 text-[11px] sm:text-xs">
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-900">
                            <Wallet className="w-3.5 h-3.5 shrink-0" />
                            <span>Piutang Pelanggan</span>
                          </span>
                          <span className="font-mono-num font-bold text-amber-900">
                            {formatRupiah(customerPrevDebt)}
                          </span>
                        </div>

                        {isDebtPayment ? (
                          <div className="text-[10px] sm:text-[11px] font-mono-num text-amber-800">
                            Total piutang setelah kasbon ini:{' '}
                            <strong>{formatRupiah(customerPrevDebt + debtAddition)}</strong>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <label
                              htmlFor="pos-rec-pay"
                              className="block text-[11px] font-medium text-amber-900"
                            >
                              Bayar Piutang Sekaligus (Rp)
                            </label>
                            <input
                              id="pos-rec-pay"
                              type="number"
                              min="0"
                              max={customerPrevDebt}
                              value={receivablePayAmount}
                              onChange={(e) => setReceivablePayAmount(e.target.value)}
                              placeholder="0 (kosongkan jika tidak bayar piutang)"
                              className="w-full min-h-[36px] px-2.5 py-1 rounded-md border border-amber-300 bg-white text-xs font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                            />
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setReceivablePayAmount('');
                                  if (isMixedPayment) {
                                    setCashPart(String(roundMoney(Math.max(0, totalAmount - numQrisPart))));
                                  }
                                }}
                                className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${
                                  numReceivablePay === 0
                                    ? 'bg-slate-800 text-white border-slate-800'
                                    : 'bg-white text-slate-700 border-amber-300 hover:bg-amber-100'
                                }`}
                              >
                                Tidak Bayar
                              </button>
                              {customerPrevDebt >= 2000 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const halfDebt = Math.round(customerPrevDebt / 2);
                                    setReceivablePayAmount(String(halfDebt));
                                    if (isMixedPayment) {
                                      setCashPart(
                                        String(roundMoney(Math.max(0, totalAmount + halfDebt - numQrisPart)))
                                      );
                                    }
                                  }}
                                  className="px-2 py-1 rounded text-[10px] font-semibold border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 cursor-pointer"
                                >
                                  50% ({formatRupiah(Math.round(customerPrevDebt / 2))})
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setReceivablePayAmount(String(customerPrevDebt));
                                  if (isMixedPayment) {
                                    setCashPart(
                                      String(
                                        roundMoney(Math.max(0, totalAmount + customerPrevDebt - numQrisPart))
                                      )
                                    );
                                  }
                                }}
                                className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${
                                  numReceivablePay === customerPrevDebt
                                    ? 'bg-emerald-700 text-white border-emerald-700'
                                    : 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                                }`}
                              >
                                Lunasi ({formatRupiah(customerPrevDebt)})
                              </button>
                            </div>
                            {numReceivablePay > 0 && (
                              <div className="flex items-center justify-between text-[10px] sm:text-[11px] font-mono-num text-emerald-800 pt-0.5">
                                <span>Sisa piutang nanti:</span>
                                <strong>
                                  {previewCombined.customerDebtAfter <= 0
                                    ? 'LUNAS (Rp0)'
                                    : formatRupiah(previewCombined.customerDebtAfter)}
                                </strong>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Akun Penerima Tunai / Transfer / DP */}
              {((!isDebtPayment && !isQrisPayment) || (isDebtPayment && numPaid > 0)) && (
                <div className="space-y-1">
                  <label htmlFor="pos-account" className="block text-[11px] sm:text-xs font-medium text-slate-700">
                    {isDebtPayment
                      ? 'Akun Kas DP'
                      : isMixedPayment
                        ? 'Akun Kas Tunai'
                        : 'Akun Pembayaran'}
                  </label>
                  <select
                    id="pos-account"
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="w-full min-h-[38px] sm:min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {activeAccounts.length === 0 ? (
                      <option value="">(Belum ada akun aktif)</option>
                    ) : (
                      activeAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} ({formatRupiah(acc.balance)})
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}

              {/* Akun Penerima QRIS */}
              {(isQrisPayment || isMixedPayment) && (
                <div className="space-y-1">
                  <label htmlFor="pos-qris-account" className="block text-[11px] sm:text-xs font-medium text-slate-700">
                    Rekening QRIS (Neto)
                  </label>
                  <select
                    id="pos-qris-account"
                    value={selectedQrisAccountId}
                    onChange={(e) => setSelectedQrisAccountId(e.target.value)}
                    className="w-full min-h-[38px] sm:min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {activeAccounts.length === 0 ? (
                      <option value="">(Belum ada rekening aktif)</option>
                    ) : (
                      activeAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} ({formatRupiah(acc.balance)})
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}

              {isMixedPayment ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label htmlFor="pos-qris-part" className="block text-[11px] sm:text-xs font-medium text-slate-700">
                      Bagian QRIS (Rp)
                    </label>
                    <input
                      id="pos-qris-part"
                      type="number"
                      min="1"
                      max={grandTotalDue > 0 ? grandTotalDue : undefined}
                      value={qrisPart}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setQrisPart(raw);
                        const parsed = roundMoney(Math.max(0, Number(raw) || 0));
                        if (parsed <= grandTotalDue) {
                          setCashPart(String(roundMoney(grandTotalDue - parsed)));
                        }
                      }}
                      placeholder="0"
                      className="w-full min-h-[38px] sm:min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="pos-cash-part" className="block text-[11px] sm:text-xs font-medium text-slate-700">
                      Bagian Tunai (Rp)
                    </label>
                    <input
                      id="pos-cash-part"
                      type="number"
                      min="1"
                      value={cashPart}
                      onChange={(e) => setCashPart(e.target.value)}
                      placeholder="0"
                      className="w-full min-h-[38px] sm:min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <label htmlFor="pos-paid" className="block text-[11px] sm:text-xs font-medium text-slate-700">
                    {isDebtPayment
                      ? 'Uang Muka / DP (Rp)'
                      : numReceivablePay > 0
                        ? 'Total Uang Dibayar (Belanja + Piutang)'
                        : 'Uang Dibayar (Rp)'}
                  </label>
                  <input
                    id="pos-paid"
                    type="number"
                    min="0"
                    value={paidAmount}
                    onChange={(e) => setPaidAmount(e.target.value)}
                    placeholder={isDebtPayment ? '0 (Kasbon Penuh)' : String(grandTotalDue)}
                    className="w-full min-h-[38px] sm:min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              )}

              {(isAdmin || isQrisPayment || isMixedPayment) && (
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1 text-[11px] sm:text-xs">
                  {isAdmin && (
                    <>
                      <div className="flex justify-between items-center text-slate-500">
                        <span>Total HPP</span>
                        <span className="font-mono-num">{formatRupiah(totalCost)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-600">Estimasi Laba</span>
                        <span
                          className={`font-mono-num font-semibold ${
                            estimatedProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {formatRupiah(estimatedProfit)}
                        </span>
                      </div>
                    </>
                  )}
                  {(isQrisPayment || isMixedPayment) && (
                    <>
                      <div className="flex justify-between items-center text-amber-700">
                        <span>Pot. QRIS ({formatQty(qrisFeePercent)}%)</span>
                        <span className="font-mono-num font-semibold">
                          -{formatRupiah(previewSettlement.qrisFeeAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-emerald-700">
                        <span>Masuk Saldo Bersih (Belanja)</span>
                        <span className="font-mono-num font-bold">
                          {formatRupiah(previewSettlement.netReceivedAmount)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer Tetap Bawah: Total Tagihan & Tombol Proses */}
          <div className="shrink-0 border-t border-slate-200 bg-slate-50 p-2.5 sm:p-3.5 space-y-2">
            <div className="space-y-0.5">
              {numReceivablePay > 0 && !isDebtPayment && (
                <>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 font-mono-num">
                    <span>Total Belanja</span>
                    <span>{formatRupiah(totalAmount)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-amber-800 font-mono-num">
                    <span>Bayar Piutang Lama</span>
                    <span>+{formatRupiah(numReceivablePay)}</span>
                  </div>
                </>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] sm:text-xs font-medium text-slate-700">
                  {numReceivablePay > 0 && !isDebtPayment ? 'Total Harus Dibayar' : 'Total Tagihan'}
                </span>
                <span className="font-mono-num text-sm sm:text-lg font-bold text-slate-900">
                  {formatRupiah(grandTotalDue)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] font-mono-num">
                {isDebtPayment ? (
                  <>
                    <span className="text-amber-800">Masuk Kasbon</span>
                    <span className="font-semibold text-amber-800">{formatRupiah(debtAddition)}</span>
                  </>
                ) : (
                  <>
                    <span className="text-slate-500">Kembalian</span>
                    <span className="font-semibold text-emerald-700">{formatRupiah(changeAmount)}</span>
                  </>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={syncedCart.length === 0 || processing}
              className="w-full min-h-[44px] sm:min-h-[46px] inline-flex items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-4 py-2 rounded-lg bg-emerald-700 text-white text-[11px] sm:text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
            >
              <Check className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {processing
                  ? 'Menyimpan...'
                  : isDebtPayment
                    ? 'Simpan Kasbon & Potong Stok'
                    : 'Proses & Potong Stok'}
              </span>
            </button>
          </div>
        </form>
      </div>

      {/* Riwayat Transaksi Kasir Terbaru */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Receipt className="w-4 h-4 text-slate-500" />
            <h3 className="font-display font-semibold text-base text-slate-900">
              Riwayat Penjualan Retail Terbaru
            </h3>
          </div>
          <span className="text-xs text-slate-500">
            Tersinkronisasi real-time (Admin &amp; Kasir)
          </span>
        </div>
        {recentSales.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Belum ada transaksi penjualan retail yang tercatat.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                  <th className="py-3 px-4 whitespace-nowrap">No. Transaksi</th>
                  <th className="py-3 px-4 whitespace-nowrap">Petugas</th>
                  <th className="py-3 px-4 whitespace-nowrap">Metode</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Item</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Omzet</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Pot. QRIS</th>
                  {isAdmin && <th className="py-3 px-4 text-right whitespace-nowrap">Laba</th>}
                  <th className="py-3 px-4 text-right whitespace-nowrap">Struk / WA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {recentSales.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-mono-num text-xs text-slate-600 whitespace-nowrap">
                      {s.transactionDate} · {s.transactionTime}
                    </td>
                    <td className="py-3 px-4 font-mono-num text-xs font-semibold text-slate-900 whitespace-nowrap">
                      {s.transactionNumber}
                      {s.customerName && (
                        <div className="text-[11px] font-sans font-normal text-slate-500">
                          {s.customerName}
                        </div>
                      )}
                      {s.receivablePaidAmount && s.receivablePaidAmount > 0 ? (
                        <div className="text-[10px] font-sans font-semibold text-amber-700">
                          +Bayar Piutang {formatRupiah(s.receivablePaidAmount)}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                      {s.recordedByName}
                    </td>
                    <td className="py-3 px-4 text-xs uppercase text-slate-600 whitespace-nowrap">
                      {s.paymentMethod === 'debt'
                        ? `KASBON${s.customerName ? ` · ${s.customerName}` : ''}`
                        : s.paymentMethod === 'mixed'
                          ? 'TUNAI + QRIS'
                          : s.paymentMethod}
                    </td>
                    <td className="py-3 px-4 text-right font-mono-num text-slate-700 whitespace-nowrap">
                      {formatQty(s.totalItems)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                      {formatRupiah(s.totalAmount)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono-num text-xs text-amber-700 whitespace-nowrap">
                      {s.qrisFeeAmount && s.qrisFeeAmount > 0 ? formatRupiah(s.qrisFeeAmount) : '-'}
                    </td>
                    {isAdmin && (
                      <td className="py-3 px-4 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                        {s.totalProfit !== undefined ? formatRupiah(s.totalProfit) : '-'}
                      </td>
                    )}
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        disabled={loadingReceiptId === s.id}
                        onClick={() => handleOpenRecentSaleReceipt(s)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:border-emerald-600 hover:text-emerald-800 disabled:opacity-50 cursor-pointer"
                      >
                        <Receipt className="w-3.5 h-3.5" />
                        <span>{loadingReceiptId === s.id ? 'Memuat...' : 'Struk / WA'}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Modal Tambah Pelanggan Cepat dari Kasir */}
      {showQuickCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4">
          <form
            onSubmit={handleQuickCreateCustomer}
            className="bg-white border border-slate-200 rounded-xl max-w-sm w-full max-h-[90dvh] overflow-y-auto p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-display font-semibold text-base text-slate-900">
                Tambah Pelanggan Baru
              </h3>
              <button
                type="button"
                onClick={() => setShowQuickCustomer(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="quick-cust-name" className="block text-xs font-medium text-slate-700">
                  Nama Pelanggan
                </label>
                <input
                  id="quick-cust-name"
                  type="text"
                  required
                  maxLength={100}
                  value={quickCustName}
                  onChange={(e) => setQuickCustName(e.target.value)}
                  placeholder="Contoh: Ibu Rina"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="quick-cust-phone" className="block text-xs font-medium text-slate-700">
                  No. HP / WhatsApp (Opsional)
                </label>
                <input
                  id="quick-cust-phone"
                  type="text"
                  maxLength={24}
                  value={quickCustPhone}
                  onChange={(e) => setQuickCustPhone(e.target.value)}
                  placeholder="08xxxxxxxxxx"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowQuickCustomer(false)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={creatingCust}
                className="min-h-[44px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {creatingCust ? 'Menyimpan...' : 'Simpan & Pilih'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Simulasi Cetak Struk Sederhana & Kirim WhatsApp */}
      {receipt && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <div className="font-display font-bold text-base text-slate-900">
                  Struk Transaksi Berhasil
                </div>
                <div className="text-xs text-slate-500 font-mono-num">
                  {receipt.transactionNumber} · {receipt.transactionDate} {receipt.transactionTime}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReceipt(null)}
                aria-label="Tutup Struk"
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Toggle Simulasi Teks Kasir vs Ringkasan Detail */}
            <div className="grid grid-cols-2 rounded-lg border border-slate-200 p-1 bg-slate-50 text-xs">
              <button
                type="button"
                onClick={() => setReceiptViewMode('thermal')}
                className={`min-h-[36px] rounded-md font-semibold transition-colors cursor-pointer ${
                  receiptViewMode === 'thermal'
                    ? 'bg-white text-emerald-800 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Simulasi Struk (Teks)
              </button>
              <button
                type="button"
                onClick={() => setReceiptViewMode('detail')}
                className={`min-h-[36px] rounded-md font-semibold transition-colors cursor-pointer ${
                  receiptViewMode === 'detail'
                    ? 'bg-white text-emerald-800 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Ringkasan Detail
              </button>
            </div>

            {receiptViewMode === 'thermal' ? (
              <div className="space-y-2.5">
                <div className="rounded-lg border border-dashed border-slate-300 bg-stone-50 p-3.5 overflow-x-auto">
                  <pre className="font-mono-num text-[11px] leading-[1.45] text-slate-900 whitespace-pre mx-auto w-fit select-all">
                    {receiptText}
                  </pre>
                </div>
                {(isAdmin || receipt.qrisFeeAmount > 0) && (
                  <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 space-y-1 text-[11px]">
                    {receipt.qrisFeeAmount > 0 && (
                      <div className="flex justify-between text-amber-800">
                        <span>Potongan QRIS ({formatQty(receipt.qrisFeeRate)}%)</span>
                        <span className="font-mono-num font-semibold">
                          -{formatRupiah(receipt.qrisFeeAmount)} (Bersih{' '}
                          {formatRupiah(receipt.netReceivedAmount)})
                        </span>
                      </div>
                    )}
                    {isAdmin && (
                      <div className="flex justify-between text-slate-600">
                        <span>Laba Penjualan (Catatan Internal)</span>
                        <span className="font-mono-num font-semibold text-emerald-700">
                          {formatRupiah(receipt.totalProfit)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-slate-600 space-y-0.5 font-mono-num">
                  <div>Kasir: {receipt.recordedByName}</div>
                  {receipt.customerName && <div>Pelanggan: {receipt.customerName}</div>}
                </div>

                <div className="border-y border-dashed border-slate-300 py-3 space-y-2 text-xs">
                  {receipt.items.length === 0 ? (
                    <div className="text-slate-500 text-center py-2">
                      Rincian item belum tersedia untuk transaksi ini.
                    </div>
                  ) : (
                    receipt.items.map((it, idx) => (
                      <div key={idx} className="flex justify-between gap-2">
                        <div>
                          <div className="font-medium text-slate-900">
                            {it.name} ({it.priceTier === 'wholesale' ? 'Grosir' : 'Ecer'})
                          </div>
                          <div className="font-mono-num text-slate-500">
                            {formatQty(it.quantity)} {it.unitName} x {formatRupiah(it.unitPrice)}
                            {it.conversion !== 1
                              ? ` · -${formatQty(it.baseQuantity)} ${it.baseUnit}`
                              : ''}
                          </div>
                        </div>
                        <div className="font-mono-num font-semibold text-slate-900">
                          {formatRupiah(it.subtotal)}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span className="font-mono-num">{formatRupiah(receipt.subtotal)}</span>
                  </div>
                  {receipt.discount > 0 && (
                    <div className="flex justify-between text-red-700">
                      <span>Diskon</span>
                      <span className="font-mono-num">-{formatRupiah(receipt.discount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-bold text-slate-900 pt-1">
                    <span>Total Belanja</span>
                    <span className="font-mono-num">{formatRupiah(receipt.totalAmount)}</span>
                  </div>
                  {(receipt.receivablePaidAmount || 0) > 0 && (
                    <>
                      <div className="flex justify-between text-amber-800">
                        <span>Bayar Piutang Sebelumnya</span>
                        <span className="font-mono-num">
                          +{formatRupiah(receipt.receivablePaidAmount || 0)}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm font-bold text-slate-900 border-t border-slate-200 pt-1">
                        <span>Total Harus Dibayar</span>
                        <span className="font-mono-num">
                          {formatRupiah(
                            receipt.totalAmount + (receipt.receivablePaidAmount || 0)
                          )}
                        </span>
                      </div>
                    </>
                  )}
                  {receipt.debtAmount > 0 ? (
                    <>
                      <div className="flex justify-between">
                        <span>Dibayar (DP)</span>
                        <span className="font-mono-num">{formatRupiah(receipt.paidAmount)}</span>
                      </div>
                      <div className="flex justify-between font-semibold text-amber-700">
                        <span>Masuk Piutang (Kasbon Baru)</span>
                        <span className="font-mono-num">{formatRupiah(receipt.debtAmount)}</span>
                      </div>
                      {receipt.customerDebtAfter !== undefined && (
                        <div className="flex justify-between font-semibold text-amber-900">
                          <span>Total Piutang Sekarang</span>
                          <span className="font-mono-num">
                            {formatRupiah(receipt.customerDebtAfter)}
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between">
                        <span>
                          Dibayar (
                          {receipt.paymentMethod === 'mixed'
                            ? 'TUNAI + QRIS'
                            : receipt.paymentMethod.toUpperCase()}
                          )
                        </span>
                        <span className="font-mono-num">{formatRupiah(receipt.paidAmount)}</span>
                      </div>
                      {receipt.paymentMethod === 'mixed' && (
                        <div className="flex justify-between text-[11px] text-slate-500">
                          <span>Rincian Belanja (Tunai / QRIS)</span>
                          <span className="font-mono-num">
                            {formatRupiah(receipt.cashPaidPart)} / {formatRupiah(receipt.qrisAmount)}
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between font-semibold text-emerald-700">
                        <span>Kembalian</span>
                        <span className="font-mono-num">{formatRupiah(receipt.changeAmount)}</span>
                      </div>
                      {receipt.customerDebtAfter !== undefined &&
                        ((receipt.receivablePaidAmount || 0) > 0 ||
                          (receipt.customerDebtBefore || 0) > 0) && (
                          <div className="flex justify-between font-semibold text-amber-900">
                            <span>Sisa Piutang Pelanggan</span>
                            <span className="font-mono-num">
                              {receipt.customerDebtAfter <= 0
                                ? 'LUNAS (Rp0)'
                                : formatRupiah(receipt.customerDebtAfter)}
                            </span>
                          </div>
                        )}
                    </>
                  )}
                  {receipt.qrisFeeAmount > 0 && (
                    <div className="pt-1 border-t border-slate-100 space-y-0.5 text-[11px]">
                      <div className="flex justify-between text-amber-700">
                        <span>Potongan QRIS ({formatQty(receipt.qrisFeeRate)}%)</span>
                        <span className="font-mono-num">-{formatRupiah(receipt.qrisFeeAmount)}</span>
                      </div>
                      <div className="flex justify-between text-emerald-700 font-semibold">
                        <span>Penerimaan Bersih Masuk Saldo</span>
                        <span className="font-mono-num">{formatRupiah(receipt.netReceivedAmount)}</span>
                      </div>
                    </div>
                  )}
                  {isAdmin && (
                    <div className="flex justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-100">
                      <span>Laba Penjualan (Internal)</span>
                      <span className="font-mono-num font-semibold text-emerald-700">
                        {formatRupiah(receipt.totalProfit)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Pilihan Kertas & Tombol Cetak / Unduh PDF / Salin / Printer Bluetooth */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
                <span>Ukuran Kertas Thermal:</span>
                <div className="inline-flex rounded-md border border-slate-200 p-0.5 bg-slate-50">
                  <button
                    type="button"
                    onClick={() => setReceiptPaperWidth(58)}
                    className={`px-2 py-0.5 rounded font-mono-num font-semibold cursor-pointer ${
                      receiptPaperWidth === 58
                        ? 'bg-white text-emerald-800 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    58mm
                  </button>
                  <button
                    type="button"
                    onClick={() => setReceiptPaperWidth(80)}
                    className={`px-2 py-0.5 rounded font-mono-num font-semibold cursor-pointer ${
                      receiptPaperWidth === 80
                        ? 'bg-white text-emerald-800 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    80mm
                  </button>
                </div>
              </div>

              {printNotice && (
                <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                  {printNotice}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={printingReceipt}
                  onClick={handlePrintThermalReceipt}
                  className="min-h-[42px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 disabled:opacity-60 cursor-pointer"
                >
                  <Printer className="w-4 h-4 shrink-0" />
                  <span>{printingReceipt ? 'Menyiapkan...' : 'Cetak Struk'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadReceiptPdf}
                  className="min-h-[42px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
                >
                  <Download className="w-4 h-4 shrink-0" />
                  <span>Unduh PDF ({receiptPaperWidth}mm)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleCopyText('receipt', receiptText)}
                  className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
                >
                  {copiedType === 'receipt' ? (
                    <Check className="w-4 h-4 text-emerald-700 shrink-0" />
                  ) : (
                    <Copy className="w-4 h-4 shrink-0" />
                  )}
                  <span>{copiedType === 'receipt' ? 'Tersalin!' : 'Salin Teks Struk'}</span>
                </button>
                <a
                  href={buildRawBtThermalUrl(receiptText)}
                  onClick={(e) => {
                    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && !/android/i.test(navigator.userAgent)) {
                      e.preventDefault();
                      handleShareReceiptText();
                    }
                  }}
                  className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50"
                  title="Kirim langsung ke aplikasi printer thermal Bluetooth RawBT di Android"
                >
                  <Share2 className="w-4 h-4 shrink-0" />
                  <span>Printer BT / Bagikan</span>
                </a>
              </div>
            </div>

            {/* Kirim Ringkasan Struk via WhatsApp */}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-900">
                <MessageCircle className="w-4 h-4 text-emerald-700 shrink-0" />
                <span>Kirim Ringkasan Struk via WhatsApp</span>
              </div>

              {customers.length > 0 && (
                <div className="space-y-1">
                  <label
                    htmlFor="receipt-wa-cust"
                    className="block text-[11px] font-medium text-emerald-900"
                  >
                    Ambil Nomor dari Database Pelanggan
                  </label>
                  <select
                    id="receipt-wa-cust"
                    value={receiptSelectedCustomerId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setReceiptSelectedCustomerId(nextId);
                      const found = customers.find((c) => c.id === nextId);
                      if (found) {
                        setReceiptWaPhone(found.phone || '');
                      }
                    }}
                    className="w-full min-h-[38px] px-2.5 py-1.5 rounded-lg border border-emerald-300 bg-white text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    <option value="">-- Pilih Pelanggan Database --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.phone ? ` (${c.phone})` : ' (Belum ada No. WA)'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1">
                <label
                  htmlFor="receipt-wa-phone"
                  className="block text-[11px] font-medium text-emerald-900"
                >
                  Nomor WhatsApp Tujuan
                </label>
                <input
                  id="receipt-wa-phone"
                  type="tel"
                  maxLength={24}
                  value={receiptWaPhone}
                  onChange={(e) => setReceiptWaPhone(e.target.value)}
                  placeholder="08xxxxxxxxxx / 628xxxxxxxxxx"
                  className="w-full min-h-[38px] px-3 py-1.5 rounded-lg border border-emerald-300 bg-white text-xs font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                {receiptWaPhone.trim() ? (
                  normalizedWaPhone ? (
                    <div className="text-[11px] text-emerald-800 font-mono-num">
                      Nomor terdeteksi: +{normalizedWaPhone}
                    </div>
                  ) : (
                    <div className="text-[11px] text-amber-800">
                      Masukkan minimal 9 digit nomor HP/WhatsApp yang valid.
                    </div>
                  )
                ) : (
                  <div className="text-[11px] text-emerald-800/80">
                    Pilih pelanggan dengan nomor tersimpan atau ketik nomor WA pembeli.
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
                {waShareUrl ? (
                  <a
                    href={waShareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>Kirim WhatsApp</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700/40 text-white text-xs font-semibold cursor-not-allowed"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>Kirim WhatsApp</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleCopyText('whatsapp', whatsappMessage)}
                  className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-300 bg-white text-emerald-900 text-xs font-semibold hover:bg-emerald-100/60 cursor-pointer"
                >
                  {copiedType === 'whatsapp' ? (
                    <Check className="w-4 h-4 text-emerald-700" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  <span>{copiedType === 'whatsapp' ? 'Pesan Tersalin!' : 'Salin Ringkasan WA'}</span>
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setReceipt(null)}
              className="w-full min-h-[44px] rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 cursor-pointer"
            >
              Selesai
            </button>
          </div>
        </div>
      )}

      {/* Modal Persetujuan Admin untuk Penjualan Stok Kedaluwarsa */}
      {showExpiredOverrideModal && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-3 sm:p-4">
          <form
            onSubmit={handleConfirmExpiredOverride}
            className="bg-white border border-red-300 rounded-xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-5 space-y-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-2 border-b border-red-100 pb-3">
              <div className="flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-base text-red-900">
                    Persetujuan Admin: Barang Kedaluwarsa
                  </h3>
                  <p className="text-xs text-red-700">
                    Produk berikut menyentuh batch berstatus EXPIRED dan tidak boleh dijual tanpa persetujuan eksplisit Admin.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowExpiredOverrideModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto">
              {expiredConflicts.map((c) => (
                <div
                  key={c.product.id}
                  className="rounded-lg border border-red-200 bg-red-50/70 p-2.5 text-xs space-y-1"
                >
                  <div className="font-semibold text-red-950">
                    {formatProductFullName(c.product)}
                  </div>
                  <div className="font-mono-num text-[11px] text-red-800">
                    Dibeli {formatQty(c.demandedBase)} {c.product.unit} · Stok aman{' '}
                    {formatQty(c.safeSellableStock)} {c.product.unit} ·{' '}
                    <strong>Dari batch EXPIRED: {formatQty(c.expiredQtyNeeded)} {c.product.unit}</strong>
                  </div>
                  <div className="space-y-0.5 pt-0.5 text-[11px] text-red-700 font-mono-num">
                    {c.expiredBatches.map((b) => (
                      <div key={b.id}>
                        • {b.batchNumber} · ED {formatShortIdDate(b.effectiveExpiryDate)} ({b.remainingLabel}) · Sisa {formatQty(b.remainingBaseQty)} {b.baseUnit}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <label
                htmlFor="pos-expired-override-reason"
                className="block text-xs font-semibold text-slate-800"
              >
                Alasan Persetujuan Admin *
              </label>
              <input
                id="pos-expired-override-reason"
                type="text"
                required
                minLength={3}
                maxLength={200}
                value={expiredOverrideReason}
                onChange={(e) => setExpiredOverrideReason(e.target.value)}
                placeholder="Contoh: Kemasan masih baik / obral cuci gudang disetujui pemilik"
                className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowExpiredOverrideModal(false)}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batalkan Transaksi
              </button>
              <button
                type="submit"
                disabled={processing || expiredOverrideReason.trim().length < 3}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-red-700 text-white text-xs font-semibold hover:bg-red-800 disabled:opacity-50 cursor-pointer"
              >
                {processing ? 'Memproses...' : 'Setujui & Lanjutkan Penjualan'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showQuickProductModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <form
            onSubmit={handleQuickCreateProduct}
            className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-4 sm:p-6 space-y-4 my-auto border border-slate-100"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center">
                  <Package className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm sm:text-base text-slate-900">
                    Tambah Produk Baru di Kasir
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Produk langsung tersimpan dan dimasukkan ke keranjang kasir
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowQuickProductModal(false)}
                className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-800 mb-1">
                  Nama Produk *
                </label>
                <input
                  type="text"
                  required
                  value={newProdName}
                  onChange={(e) => setNewProdName(e.target.value.toUpperCase())}
                  placeholder="Contoh: Minyak Goreng Bimoli 1L"
                  className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Merek / Pabrikan
                  </label>
                  <input
                    type="text"
                    value={newProdBrand}
                    onChange={(e) => setNewProdBrand(e.target.value.toUpperCase())}
                    placeholder="Contoh: Bimoli"
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Varian / Ukuran
                  </label>
                  <input
                    type="text"
                    value={newProdVariant}
                    onChange={(e) => setNewProdVariant(e.target.value.toUpperCase())}
                    placeholder="Contoh: Refill 1L"
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Kategori *
                  </label>
                  <select
                    value={newProdCategory}
                    onChange={(e) => setNewProdCategory(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Satuan Dasar *
                  </label>
                  <input
                    type="text"
                    required
                    value={newProdUnit}
                    onChange={(e) => setNewProdUnit(e.target.value.toUpperCase())}
                    placeholder="Pcs / Bks / Botol"
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600 font-mono-num"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Stok Awal
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={newProdStock}
                    onChange={(e) => setNewProdStock(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600 font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Harga Beli (HPP)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={newProdCost}
                    onChange={(e) => setNewProdCost(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600 font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Harga Jual *
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    value={newProdSell}
                    onChange={(e) => setNewProdSell(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600 font-mono-num"
                  />
                </div>
              </div>

              <p className="text-[11px] text-slate-500 italic">
                * Masa kedaluwarsa otomatis diset 6 bulan dari hari ini, dengan pemberitahuan 1 bulan sebelum expired.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowQuickProductModal(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={creatingProduct || !newProdName.trim()}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {creatingProduct ? 'Menyimpan...' : 'Simpan & Tambah ke Keranjang'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showScanner && (
        <BarcodeScannerModal
          title="Scan Barcode ke Keranjang"
          onDetected={handleBarcodeScan}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}
