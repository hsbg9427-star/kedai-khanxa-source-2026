import type {
  PriceHistory,
  Product,
  Purchase,
  PurchaseItem,
  PurchaseReturn,
  SupplierPayment,
} from '../types/database';
import { getPeriodDateRange, type ReportPeriodType } from './qrisFee';
import {
  computeBaseQuantityFromUnit,
  getProductAllUnitOptions,
  isStockSufficientWithTolerance,
  roundMoney,
  roundQty,
  snapStockToProductPrecision,
} from './unitConversion';

export type PurchasePaymentMethod = 'cash' | 'transfer' | 'credit' | 'partial';

export function roundUnitCost(value: number): number {
  const n = Number(Number(value).toFixed(4));
  return Object.is(n, -0) ? 0 : n;
}

export interface PurchaseDraftLineInput {
  product: Product;
  unitName: string;
  quantity: number;
  unitCost: number;
  lineDiscount?: number;
}

export interface ComputedPurchaseLine {
  product: Product;
  unitName: string;
  baseUnit: string;
  conversion: number;
  quantity: number;
  baseQuantity: number;
  unitCost: number;
  grossSubtotal: number;
  lineDiscount: number;
  afterLineDiscount: number;
  allocatedExtraCost: number;
  netLineTotal: number;
  effectiveBaseUnitCost: number;
  stockBefore: number;
  stockAfter: number;
  hppBefore: number;
  hppAfter: number;
}

export interface ComputedProductUpdate {
  product: Product;
  stockBefore: number;
  stockAfter: number;
  totalAddedBaseQty: number;
  hppBefore: number;
  hppAfter: number;
  hppChanged: boolean;
}

export interface ComputedPurchaseDraft {
  lines: ComputedPurchaseLine[];
  productUpdates: ComputedProductUpdate[];
  subtotal: number;
  discount: number;
  extraCost: number;
  totalAmount: number;
}

export function computePurchaseDraft(
  inputs: PurchaseDraftLineInput[],
  invoiceDiscountInput: number = 0,
  extraCostInput: number = 0
): ComputedPurchaseDraft {
  if (!inputs || inputs.length === 0) {
    throw new Error('Tambahkan minimal 1 barang ke daftar pembelian.');
  }

  const invoiceDiscount = roundMoney(Math.max(0, Number(invoiceDiscountInput) || 0));
  const extraCost = roundMoney(Math.max(0, Number(extraCostInput) || 0));

  interface PrelimLine {
    product: Product;
    unitName: string;
    baseUnit: string;
    conversion: number;
    quantity: number;
    baseQuantity: number;
    unitCost: number;
    grossSubtotal: number;
    lineDiscount: number;
    afterLineDiscount: number;
  }

  const prelim: PrelimLine[] = inputs.map((item, idx) => {
    const qty = roundQty(Number(item.quantity) || 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Jumlah beli untuk "${item.product.name}" (baris ${idx + 1}) harus lebih dari 0.`);
    }

    const unitCost = roundMoney(Number(item.unitCost));
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error(`Harga beli untuk "${item.product.name}" tidak valid.`);
    }

    const options = getProductAllUnitOptions(item.product);
    const chosenUnit = options.find(
      (o) => o.unitName.toUpperCase() === (item.unitName || item.product.unit).trim().toUpperCase()
    );
    if (!chosenUnit) {
      throw new Error(
        `Satuan "${item.unitName}" tidak terdaftar pada pengaturan produk "${item.product.name}".`
      );
    }
    if (!chosenUnit.canBuy) {
      throw new Error(
        `Satuan "${chosenUnit.unitName}" pada produk "${item.product.name}" dinonaktifkan untuk pembelian.`
      );
    }

    const grossSubtotal = roundMoney(qty * unitCost);
    const lineDiscount = roundMoney(Math.max(0, Number(item.lineDiscount) || 0));
    if (lineDiscount > grossSubtotal) {
      throw new Error(
        `Diskon item "${item.product.name}" (${lineDiscount}) tidak boleh melebihi subtotal (${grossSubtotal}).`
      );
    }

    const afterLineDiscount = roundMoney(grossSubtotal - lineDiscount);
    const baseQuantity = computeBaseQuantityFromUnit(qty, chosenUnit);
    if (baseQuantity <= 0) {
      throw new Error(`Konversi jumlah satuan dasar untuk "${item.product.name}" tidak valid.`);
    }

    return {
      product: item.product,
      unitName: chosenUnit.unitName,
      baseUnit: item.product.unit,
      conversion: chosenUnit.conversion,
      quantity: qty,
      baseQuantity,
      unitCost,
      grossSubtotal,
      lineDiscount,
      afterLineDiscount,
    };
  });

  const subtotal = roundMoney(prelim.reduce((sum, l) => sum + l.afterLineDiscount, 0));
  if (invoiceDiscount > subtotal) {
    throw new Error('Diskon faktur tidak boleh melebihi subtotal pembelian barang.');
  }

  const totalAmount = roundMoney(Math.max(0, subtotal - invoiceDiscount + extraCost));
  const netAdjustment = roundMoney(extraCost - invoiceDiscount);

  // Proporsional biaya tambahan - diskon faktur berdasarkan nilai bersih tiap baris
  let allocatedSoFar = 0;
  const allocatedAdjustments: number[] = prelim.map((l, idx) => {
    if (idx === prelim.length - 1) {
      return roundMoney(netAdjustment - allocatedSoFar);
    }
    const share =
      subtotal > 0
        ? roundMoney((netAdjustment * l.afterLineDiscount) / subtotal)
        : roundMoney(netAdjustment / prelim.length);
    allocatedSoFar = roundMoney(allocatedSoFar + share);
    return share;
  });

  const runningByProduct = new Map<
    string,
    {
      product: Product;
      initialStock: number;
      initialCost: number;
      stock: number;
      costPrice: number;
      totalAddedBaseQty: number;
    }
  >();

  const computedLines: ComputedPurchaseLine[] = prelim.map((l, idx) => {
    const allocatedExtraCost = allocatedAdjustments[idx];
    const netLineTotal = roundMoney(Math.max(0, l.afterLineDiscount + allocatedExtraCost));
    const effectiveBaseUnitCost = roundUnitCost(netLineTotal / l.baseQuantity);

    let state = runningByProduct.get(l.product.id);
    if (!state) {
      const startStock = roundQty(Math.max(0, Number(l.product.stock) || 0));
      const startCost = roundUnitCost(Math.max(0, Number(l.product.costPrice) || 0));
      state = {
        product: l.product,
        initialStock: startStock,
        initialCost: startCost,
        stock: startStock,
        costPrice: startCost,
        totalAddedBaseQty: 0,
      };
      runningByProduct.set(l.product.id, state);
    }

    const stockBefore = snapStockToProductPrecision(state.stock, l.product);
    const hppBefore = state.costPrice;
    const stockAfter = snapStockToProductPrecision(stockBefore + l.baseQuantity, l.product);

    let hppAfter: number;
    if (stockBefore <= 0) {
      hppAfter = effectiveBaseUnitCost;
    } else {
      const inventoryValBefore = stockBefore * hppBefore;
      hppAfter =
        stockAfter > 0
          ? roundUnitCost((inventoryValBefore + netLineTotal) / stockAfter)
          : effectiveBaseUnitCost;
    }

    state.stock = stockAfter;
    state.costPrice = hppAfter;
    state.totalAddedBaseQty = snapStockToProductPrecision(
      state.totalAddedBaseQty + l.baseQuantity,
      l.product
    );

    return {
      product: l.product,
      unitName: l.unitName,
      baseUnit: l.baseUnit,
      conversion: l.conversion,
      quantity: l.quantity,
      baseQuantity: l.baseQuantity,
      unitCost: l.unitCost,
      grossSubtotal: l.grossSubtotal,
      lineDiscount: l.lineDiscount,
      afterLineDiscount: l.afterLineDiscount,
      allocatedExtraCost,
      netLineTotal,
      effectiveBaseUnitCost,
      stockBefore,
      stockAfter,
      hppBefore,
      hppAfter,
    };
  });

  const productUpdates: ComputedProductUpdate[] = Array.from(runningByProduct.values()).map((st) => ({
    product: st.product,
    stockBefore: st.initialStock,
    stockAfter: st.stock,
    totalAddedBaseQty: st.totalAddedBaseQty,
    hppBefore: st.initialCost,
    hppAfter: st.costPrice,
    hppChanged: Math.abs(st.costPrice - st.initialCost) >= 0.0001,
  }));

  return {
    lines: computedLines,
    productUpdates,
    subtotal,
    discount: invoiceDiscount,
    extraCost,
    totalAmount,
  };
}

export interface PurchaseSettlementResult {
  paymentMethod: PurchasePaymentMethod;
  paidAmount: number;
  debtAmount: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid';
}

export function calculatePurchaseSettlement(params: {
  totalAmount: number;
  paymentMethod: PurchasePaymentMethod;
  paidAmount?: number;
}): PurchaseSettlementResult {
  const total = roundMoney(Math.max(0, Number(params.totalAmount) || 0));

  if (params.paymentMethod === 'credit') {
    return {
      paymentMethod: 'credit',
      paidAmount: 0,
      debtAmount: total,
      paymentStatus: total > 0 ? 'unpaid' : 'paid',
    };
  }

  if (params.paymentMethod === 'partial') {
    const paid = roundMoney(Number(params.paidAmount) || 0);
    if (total <= 0) {
      throw new Error('Total pembelian Rp0 tidak memerlukan pembayaran sebagian.');
    }
    if (paid <= 0) {
      throw new Error('Nominal pembayaran awal harus lebih dari Rp0 untuk metode Bayar Sebagian.');
    }
    if (paid >= total) {
      throw new Error(
        'Nominal pembayaran sama dengan atau melebihi total faktur. Gunakan Tunai atau Transfer untuk pelunasan langsung.'
      );
    }
    return {
      paymentMethod: 'partial',
      paidAmount: paid,
      debtAmount: roundMoney(total - paid),
      paymentStatus: 'partial',
    };
  }

  return {
    paymentMethod: params.paymentMethod,
    paidAmount: total,
    debtAmount: 0,
    paymentStatus: 'paid',
  };
}

export interface PurchaseReturnPlan {
  unitName: string;
  baseUnit: string;
  conversion: number;
  returnQty: number;
  returnBaseQty: number;
  unitRefundPrice: number;
  refundTotal: number;
  settlementType: 'reduce_debt' | 'cash_refund' | 'mixed';
  debtReducedAmount: number;
  cashRefundAmount: number;
  purchaseDebtAfter: number;
  purchasePaidAfter: number;
  purchaseReturnedAfter: number;
  purchasePaymentStatusAfter: 'paid' | 'partial' | 'unpaid';
  stockAfter: number;
}

export function computePurchaseReturnPlan(params: {
  purchase: Purchase;
  item: PurchaseItem;
  product: Product;
  priorReturnsForItem: PurchaseReturn[];
  unitName: string;
  returnQty: number;
  unitRefundPrice: number;
  settlementPreference: 'auto' | 'reduce_debt' | 'cash_refund';
}): PurchaseReturnPlan {
  if (params.purchase.status === 'void') {
    throw new Error('Transaksi pembelian ini sudah dibatalkan dan tidak dapat diretur.');
  }

  const returnQty = roundQty(Number(params.returnQty) || 0);
  if (!Number.isFinite(returnQty) || returnQty <= 0) {
    throw new Error('Jumlah barang yang diretur harus lebih dari 0.');
  }

  const unitRefundPrice = roundMoney(Number(params.unitRefundPrice));
  if (!Number.isFinite(unitRefundPrice) || unitRefundPrice < 0) {
    throw new Error('Harga retur per satuan tidak valid.');
  }

  const options = getProductAllUnitOptions(params.product);
  const chosenOption =
    options.find((o) => o.unitName.toUpperCase() === params.unitName.trim().toUpperCase()) ||
    (params.item.unitName &&
    params.item.unitName.toUpperCase() === params.unitName.trim().toUpperCase() &&
    params.item.conversion
      ? {
          unitName: params.item.unitName,
          conversion: params.item.conversion,
          conversionMode: 'multiply' as const,
        }
      : null);

  if (!chosenOption) {
    throw new Error(`Satuan "${params.unitName}" tidak valid untuk produk "${params.product.name}".`);
  }

  const returnBaseQty = computeBaseQuantityFromUnit(returnQty, chosenOption);
  const purchasedBaseQty = roundQty(
    Number(params.item.baseQuantity) ||
      Number(params.item.quantity) * (Number(params.item.conversion) || 1)
  );
  const priorReturnedBaseQty = roundQty(
    params.priorReturnsForItem.reduce((sum, r) => sum + (Number(r.returnBaseQty) || 0), 0)
  );
  const remainingReturnableBaseQty = snapStockToProductPrecision(
    Math.max(0, purchasedBaseQty - priorReturnedBaseQty),
    params.product
  );

  if (!isStockSufficientWithTolerance(remainingReturnableBaseQty, returnBaseQty, params.product)) {
    throw new Error(
      `Jumlah retur (${returnBaseQty} ${params.product.unit}) melebihi sisa barang faktur yang dapat diretur (${remainingReturnableBaseQty} ${params.product.unit}).`
    );
  }

  const currentStock = snapStockToProductPrecision(Number(params.product.stock) || 0, params.product);
  if (!isStockSufficientWithTolerance(currentStock, returnBaseQty, params.product)) {
    throw new Error(
      `Stok "${params.product.name}" saat ini (${currentStock} ${params.product.unit}) tidak mencukupi untuk retur ${returnBaseQty} ${params.product.unit}.`
    );
  }

  const refundTotal = roundMoney(returnQty * unitRefundPrice);
  const currentDebt = roundMoney(Math.max(0, Number(params.purchase.debtAmount) || 0));
  const currentPaid = roundMoney(
    params.purchase.paidAmount !== undefined
      ? Math.max(0, Number(params.purchase.paidAmount) || 0)
      : params.purchase.paymentMethod === 'credit'
        ? 0
        : Number(params.purchase.totalAmount) || 0
  );
  const currentReturned = roundMoney(Math.max(0, Number(params.purchase.returnedAmount) || 0));

  let debtReducedAmount = 0;
  let cashRefundAmount = 0;
  let settlementType: 'reduce_debt' | 'cash_refund' | 'mixed' = 'cash_refund';

  if (params.settlementPreference === 'reduce_debt') {
    if (currentDebt <= 0) {
      throw new Error('Faktur ini sudah lunas (sisa utang Rp0). Pilih pengembalian dana ke kas/rekening.');
    }
    if (refundTotal > currentDebt) {
      throw new Error(
        `Nilai retur (${refundTotal}) melebihi sisa utang faktur (${currentDebt}). Gunakan opsi Otomatis agar selisihnya masuk ke kas.`
      );
    }
    debtReducedAmount = refundTotal;
    cashRefundAmount = 0;
    settlementType = 'reduce_debt';
  } else if (params.settlementPreference === 'cash_refund') {
    if (refundTotal > currentPaid) {
      throw new Error(
        `Pengembalian dana tunai/bank (${refundTotal}) melebihi nominal yang sudah dibayarkan (${currentPaid}). Kurangi utang pemasok terlebih dahulu.`
      );
    }
    debtReducedAmount = 0;
    cashRefundAmount = refundTotal;
    settlementType = 'cash_refund';
  } else {
    // 'auto': kurangi utang faktur terlebih dahulu, sisanya pengembalian kas/bank
    if (currentDebt >= refundTotal) {
      debtReducedAmount = refundTotal;
      cashRefundAmount = 0;
      settlementType = 'reduce_debt';
    } else if (currentDebt > 0) {
      debtReducedAmount = currentDebt;
      cashRefundAmount = roundMoney(refundTotal - currentDebt);
      settlementType = 'mixed';
    } else {
      debtReducedAmount = 0;
      cashRefundAmount = refundTotal;
      settlementType = 'cash_refund';
    }
  }

  if (cashRefundAmount > currentPaid) {
    throw new Error(
      `Pengembalian dana (${cashRefundAmount}) melebihi total dana yang pernah dibayar pada faktur ini (${currentPaid}).`
    );
  }

  const purchaseDebtAfter = roundMoney(Math.max(0, currentDebt - debtReducedAmount));
  const purchasePaidAfter = roundMoney(Math.max(0, currentPaid - cashRefundAmount));
  const purchaseReturnedAfter = roundMoney(currentReturned + refundTotal);

  let purchasePaymentStatusAfter: 'paid' | 'partial' | 'unpaid';
  if (purchaseDebtAfter <= 0) {
    purchasePaymentStatusAfter = 'paid';
  } else if (purchasePaidAfter > 0) {
    purchasePaymentStatusAfter = 'partial';
  } else {
    purchasePaymentStatusAfter = 'unpaid';
  }

  return {
    unitName: chosenOption.unitName,
    baseUnit: params.product.unit,
    conversion: chosenOption.conversion,
    returnQty,
    returnBaseQty,
    unitRefundPrice,
    refundTotal,
    settlementType,
    debtReducedAmount,
    cashRefundAmount,
    purchaseDebtAfter,
    purchasePaidAfter,
    purchaseReturnedAfter,
    purchasePaymentStatusAfter,
    stockAfter: snapStockToProductPrecision(Math.max(0, currentStock - returnBaseQty), params.product),
  };
}

export function getPurchasePaymentStatus(purchase: Purchase): 'paid' | 'partial' | 'unpaid' {
  if (purchase.paymentStatus) return purchase.paymentStatus;
  if (purchase.debtAmount !== undefined) {
    if (purchase.debtAmount <= 0) return 'paid';
    if ((purchase.paidAmount || 0) > 0) return 'partial';
    return 'unpaid';
  }
  return purchase.paymentMethod === 'credit' ? 'unpaid' : 'paid';
}

export function getPurchaseDebtAmount(purchase: Purchase): number {
  if (purchase.status === 'void') return 0;
  if (purchase.debtAmount !== undefined) return roundMoney(Math.max(0, Number(purchase.debtAmount) || 0));
  return purchase.paymentMethod === 'credit'
    ? roundMoney(Math.max(0, Number(purchase.totalAmount) || 0))
    : 0;
}

export interface PurchaseReportSummary {
  periodLabel: string;
  startDate: string;
  endDate: string;
  purchaseCount: number;
  totalPurchasesAmount: number;
  cashPurchasesCount: number;
  cashPurchasesAmount: number;
  creditPurchasesCount: number;
  creditPurchasesAmount: number;
  paidAtPurchaseInPeriod: number;
  debtCreatedInPeriod: number;
  supplierPaymentsCountInPeriod: number;
  supplierPaymentsTotalInPeriod: number;
  returnsCountInPeriod: number;
  returnsTotalInPeriod: number;
  unpaidSupplierDebtAllTime: number;
  unpaidPurchasesCountAllTime: number;
  inventoryTotalValue: number;
  activeProductsCount: number;
  lowStockProductsCount: number;
  periodPurchases: Purchase[];
  periodSupplierPayments: SupplierPayment[];
  periodReturns: PurchaseReturn[];
  periodHppChanges: PriceHistory[];
}

export function buildPurchaseReportSummary(params: {
  periodType: ReportPeriodType;
  anchorDateStr: string;
  purchases: Purchase[];
  supplierPayments: SupplierPayment[];
  purchaseReturns: PurchaseReturn[];
  products: Product[];
  priceHistory: PriceHistory[];
}): PurchaseReportSummary {
  const { startDate, endDate, label } = getPeriodDateRange(params.periodType, params.anchorDateStr);
  const inRange = (d?: string) => Boolean(d && d >= startDate && d <= endDate);

  const periodPurchases = params.purchases.filter(
    (p) => p.status === 'completed' && inRange(p.transactionDate)
  );

  let totalPurchasesAmount = 0;
  let cashPurchasesCount = 0;
  let cashPurchasesAmount = 0;
  let creditPurchasesCount = 0;
  let creditPurchasesAmount = 0;
  let paidAtPurchaseInPeriod = 0;
  let debtCreatedInPeriod = 0;

  for (const p of periodPurchases) {
    const total = roundMoney(Math.max(0, Number(p.totalAmount) || 0));
    totalPurchasesAmount = roundMoney(totalPurchasesAmount + total);

    const paid =
      p.paidAmount !== undefined
        ? roundMoney(Math.max(0, Number(p.paidAmount) || 0))
        : p.paymentMethod === 'credit'
          ? 0
          : total;
    const debt = getPurchaseDebtAmount(p);

    paidAtPurchaseInPeriod = roundMoney(paidAtPurchaseInPeriod + paid);
    debtCreatedInPeriod = roundMoney(debtCreatedInPeriod + debt);

    if (p.paymentMethod === 'cash' || p.paymentMethod === 'transfer') {
      cashPurchasesCount += 1;
      cashPurchasesAmount = roundMoney(cashPurchasesAmount + total);
    } else {
      creditPurchasesCount += 1;
      creditPurchasesAmount = roundMoney(creditPurchasesAmount + total);
    }
  }

  const periodSupplierPayments = params.supplierPayments.filter((pay) =>
    inRange(pay.transactionDate)
  );
  const supplierPaymentsTotalInPeriod = roundMoney(
    periodSupplierPayments.reduce((sum, pay) => sum + (Number(pay.amount) || 0), 0)
  );

  const periodReturns = params.purchaseReturns.filter((r) => inRange(r.transactionDate));
  const returnsTotalInPeriod = roundMoney(
    periodReturns.reduce((sum, r) => sum + (Number(r.refundTotal) || 0), 0)
  );

  const activeUnpaidPurchases = params.purchases.filter(
    (p) => p.status === 'completed' && getPurchaseDebtAmount(p) > 0
  );
  const unpaidSupplierDebtAllTime = roundMoney(
    activeUnpaidPurchases.reduce((sum, p) => sum + getPurchaseDebtAmount(p), 0)
  );

  const activeProducts = params.products.filter((p) => p.isActive);
  const inventoryTotalValue = roundMoney(
    activeProducts.reduce(
      (sum, p) => sum + Math.max(0, Number(p.stock) || 0) * Math.max(0, Number(p.costPrice) || 0),
      0
    )
  );
  const lowStockProductsCount = activeProducts.filter(
    (p) => (Number(p.stock) || 0) <= (Number(p.minStock) || 0)
  ).length;

  const periodHppChanges = params.priceHistory.filter(
    (h) =>
      inRange(h.transactionDate) &&
      Math.abs((Number(h.costPriceAfter) || 0) - (Number(h.costPriceBefore) || 0)) >= 0.0001
  );

  return {
    periodLabel: label,
    startDate,
    endDate,
    purchaseCount: periodPurchases.length,
    totalPurchasesAmount,
    cashPurchasesCount,
    cashPurchasesAmount,
    creditPurchasesCount,
    creditPurchasesAmount,
    paidAtPurchaseInPeriod,
    debtCreatedInPeriod,
    supplierPaymentsCountInPeriod: periodSupplierPayments.length,
    supplierPaymentsTotalInPeriod,
    returnsCountInPeriod: periodReturns.length,
    returnsTotalInPeriod,
    unpaidSupplierDebtAllTime,
    unpaidPurchasesCountAllTime: activeUnpaidPurchases.length,
    inventoryTotalValue,
    activeProductsCount: activeProducts.length,
    lowStockProductsCount,
    periodPurchases,
    periodSupplierPayments,
    periodReturns,
    periodHppChanges,
  };
}
