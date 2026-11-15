import type {
  Product,
  StockOpnameItem,
  StockOpnameVarianceStatus,
} from '../types/database';
import { formatQty } from './formatters';
import {
  computeBaseQuantityFromUnit,
  formatProductStockSummary,
  getProductAllUnitOptions,
  roundMoney,
  roundQty,
  snapStockToProductPrecision,
} from './unitConversion';

export function computePhysicalStockBase(
  product: Pick<Product, 'unit' | 'costPrice' | 'sellPrice' | 'sellUnits' | 'baseCanBuy' | 'baseCanSell' | 'wholesalePrice' | 'wholesaleMinQty'>,
  primaryUnitName: string,
  primaryQty: number,
  subUnitName?: string,
  subQty?: number
): number {
  const options = getProductAllUnitOptions(product as Product);
  const primaryOpt =
    options.find((o) => o.unitName.toUpperCase() === primaryUnitName.trim().toUpperCase()) ||
    options[0];

  const cleanPrimaryQty = Math.max(0, Number(primaryQty) || 0);
  const primaryBase = computeBaseQuantityFromUnit(cleanPrimaryQty, primaryOpt);

  let subBase = 0;
  if (subUnitName && subUnitName.trim() && Number(subQty) > 0) {
    const subOpt = options.find(
      (o) => o.unitName.toUpperCase() === subUnitName.trim().toUpperCase()
    );
    if (subOpt && subOpt.unitName.toUpperCase() !== primaryOpt.unitName.toUpperCase()) {
      subBase = computeBaseQuantityFromUnit(Math.max(0, Number(subQty) || 0), subOpt);
    }
  }

  return snapStockToProductPrecision(Math.max(0, primaryBase + subBase), product);
}

export function computeItemVariance(
  physicalStockBase: number | null | undefined,
  systemStockBaseline: number,
  product: Pick<Product, 'unit' | 'sellUnits'>
): {
  varianceBase: number;
  varianceStatus: StockOpnameVarianceStatus;
} {
  if (physicalStockBase === null || physicalStockBase === undefined || !Number.isFinite(physicalStockBase)) {
    return {
      varianceBase: 0,
      varianceStatus: 'uncounted',
    };
  }

  const cleanPhysical = snapStockToProductPrecision(Math.max(0, physicalStockBase), product);
  const cleanSystem = snapStockToProductPrecision(Math.max(0, systemStockBaseline), product);
  const rawDiff = cleanPhysical - cleanSystem;

  // Toleransi presisi sub-satuan agar 0.000001 tidak dianggap selisih
  const snappedAbs = snapStockToProductPrecision(Math.abs(rawDiff), product);
  if (snappedAbs <= 1e-5) {
    return {
      varianceBase: 0,
      varianceStatus: 'match',
    };
  }

  const signedDiff = rawDiff > 0 ? snappedAbs : -snappedAbs;
  return {
    varianceBase: roundQty(signedDiff),
    varianceStatus: signedDiff > 0 ? 'surplus' : 'deficit',
  };
}

export function computeMovementAdjustedFinalStock(
  currentLiveStock: number,
  varianceBase: number,
  product: Pick<Product, 'name' | 'unit' | 'sellUnits'>
): {
  currentSnapped: number;
  finalStock: number;
  netAdjustmentFromLive: number;
} {
  const currentSnapped = snapStockToProductPrecision(Math.max(0, Number(currentLiveStock) || 0), product);
  const rawFinal = currentSnapped + Number(varianceBase || 0);
  const finalStock = snapStockToProductPrecision(rawFinal, product);

  if (finalStock < -1e-5) {
    throw new Error(
      `Stok akhir untuk "${product.name}" akan menjadi negatif (${formatQty(
        finalStock
      )} ${product.unit}) karena ada transaksi keluar selama opname berlangsung. Harap hitung ulang produk ini sebelum finalisasi.`
    );
  }

  const safeFinal = Math.max(0, finalStock);
  const netAdjustmentFromLive = roundQty(safeFinal - currentSnapped);

  return {
    currentSnapped,
    finalStock: safeFinal,
    netAdjustmentFromLive,
  };
}

export function formatSignedStockDifference(
  varianceBase: number,
  product: Pick<Product, 'unit' | 'sellUnits'>
): string {
  if (Math.abs(varianceBase) <= 1e-5) {
    return `0 ${product.unit} (Cocok)`;
  }
  const sign = varianceBase > 0 ? '+' : '-';
  const absSummary = formatProductStockSummary(Math.abs(varianceBase), product);
  return `${sign}${absSummary.primary}`;
}

export function summarizeOpnameItems(
  items: Pick<
    StockOpnameItem,
    'isCounted' | 'varianceStatus' | 'varianceBase' | 'costPrice'
  >[]
): {
  totalProducts: number;
  countedProducts: number;
  matchedCount: number;
  surplusCount: number;
  deficitCount: number;
  totalVarianceValue: number;
} {
  let countedProducts = 0;
  let matchedCount = 0;
  let surplusCount = 0;
  let deficitCount = 0;
  let totalVarianceValue = 0;

  for (const item of items) {
    if (!item.isCounted) continue;
    countedProducts++;
    if (item.varianceStatus === 'match') {
      matchedCount++;
    } else if (item.varianceStatus === 'surplus') {
      surplusCount++;
      totalVarianceValue += item.varianceBase * (Number(item.costPrice) || 0);
    } else if (item.varianceStatus === 'deficit') {
      deficitCount++;
      totalVarianceValue += item.varianceBase * (Number(item.costPrice) || 0);
    }
  }

  return {
    totalProducts: items.length,
    countedProducts,
    matchedCount,
    surplusCount,
    deficitCount,
    totalVarianceValue: roundMoney(totalVarianceValue),
  };
}
