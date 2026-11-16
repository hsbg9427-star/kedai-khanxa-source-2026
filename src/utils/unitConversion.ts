import type { Product, ProductSellUnit } from '../types/database';
import { formatQty } from './formatters';

export const UNIT_PRESETS = [
  'PCS',
  'GRAM',
  'KG',
  'ONS',
  'ML',
  '250 ML',
  '500 ML',
  'LITER',
  'BATANG',
  'BUNGKUS',
  'SLOP',
  'BOTOL',
  'KALENG',
  'SACHET',
  'RENTENG',
  'PAK',
  'LUSIN',
  'DUS',
  'KARTON',
  'KRAT',
  'BUTIR',
  '10 BUTIR',
  'RAK',
  'PETI',
  '250 GRAM',
  '500 GRAM',
  '5 KG',
  '10 KG',
  '25 KG',
  'KARUNG',
];

export interface UniversalUnitTemplateItem {
  unitName: string;
  conversion: number;
  conversionMode?: 'multiply' | 'divide';
  perBaseQty?: number;
  canBuy?: boolean;
  canSell?: boolean;
}

export interface UniversalUnitTemplate {
  id: string;
  label: string;
  description: string;
  baseUnit: string;
  sellUnits: UniversalUnitTemplateItem[];
}

export const UNIVERSAL_UNIT_TEMPLATES: UniversalUnitTemplate[] = [
  {
    id: 'rokok',
    label: 'Rokok (BUNGKUS)',
    description: 'Dasar BUNGKUS · Slop (10 Bungkus), Batang (1 Bungkus = 16 Batang)',
    baseUnit: 'BUNGKUS',
    sellUnits: [
      { unitName: 'SLOP', conversion: 10, conversionMode: 'multiply', canBuy: true, canSell: true },
      {
        unitName: 'BATANG',
        conversion: 1 / 16,
        conversionMode: 'divide',
        perBaseQty: 16,
        canBuy: false,
        canSell: true,
      },
    ],
  },
  {
    id: 'kiloan',
    label: 'Gula / Barang Kiloan (KG)',
    description: 'Dasar KG · Gram (1 KG = 1000 gram), 250 gram, 500 gram',
    baseUnit: 'KG',
    sellUnits: [
      { unitName: 'GRAM', conversion: 1 / 1000, conversionMode: 'divide', perBaseQty: 1000 },
      { unitName: '250 GRAM', conversion: 1 / 4, conversionMode: 'divide', perBaseQty: 4 },
      { unitName: '500 GRAM', conversion: 1 / 2, conversionMode: 'divide', perBaseQty: 2 },
    ],
  },
  {
    id: 'beras',
    label: 'Beras (KG)',
    description: 'Dasar KG · Gram (1 KG = 1000 gram), Karung (25 KG)',
    baseUnit: 'KG',
    sellUnits: [
      { unitName: 'GRAM', conversion: 1 / 1000, conversionMode: 'divide', perBaseQty: 1000 },
      { unitName: 'KARUNG', conversion: 25, conversionMode: 'multiply' },
    ],
  },
  {
    id: 'minuman_ml',
    label: 'Minyak / Cair (ML)',
    description: 'Dasar ML · 250 ML, 500 ML, LITER',
    baseUnit: 'ML',
    sellUnits: [
      { unitName: '250 ML', conversion: 250 },
      { unitName: '500 ML', conversion: 500 },
      { unitName: 'LITER', conversion: 1000 },
    ],
  },
  {
    id: 'minuman',
    label: 'Minuman (BOTOL)',
    description: 'Dasar BOTOL · Dus (24), Karton (24)',
    baseUnit: 'BOTOL',
    sellUnits: [
      { unitName: 'DUS', conversion: 24 },
      { unitName: 'KARTON', conversion: 24 },
    ],
  },
  {
    id: 'mie',
    label: 'Mi Instan (PCS)',
    description: 'Dasar PCS · Renteng (12), Dus (40)',
    baseUnit: 'PCS',
    sellUnits: [
      { unitName: 'RENTENG', conversion: 12 },
      { unitName: 'DUS', conversion: 40 },
    ],
  },
  {
    id: 'telur',
    label: 'Telur (BUTIR)',
    description: 'Dasar BUTIR · 10 Butir (10), Rak (30)',
    baseUnit: 'BUTIR',
    sellUnits: [
      { unitName: '10 BUTIR', conversion: 10 },
      { unitName: 'RAK', conversion: 30 },
    ],
  },
];

export function roundQty(value: number): number {
  const n = Number(Number(value).toFixed(6));
  return Object.is(n, -0) ? 0 : n;
}

export function roundMoney(value: number): number {
  const n = Number(Number(value).toFixed(2));
  return Object.is(n, -0) ? 0 : n;
}

export function computeSubUnitConversion(perBaseQty: number): number {
  if (!Number.isFinite(perBaseQty) || perBaseQty <= 0) return 0;
  return roundQty(1 / perBaseQty);
}

export function getProductSubUnitInfo(
  product: Pick<Product, 'sellUnits'>
): { unitName: string; perBaseQty: number } | null {
  const extras = product.sellUnits || [];
  let best: { unitName: string; perBaseQty: number } | null = null;

  for (const u of extras) {
    if (u.conversionMode === 'divide' && Number(u.perBaseQty) > 1) {
      const divisor = Number(u.perBaseQty);
      if (!best || divisor > best.perBaseQty) {
        best = { unitName: u.unitName.trim(), perBaseQty: divisor };
      }
      continue;
    }
    const conv = Number(u.conversion);
    if (Number.isFinite(conv) && conv > 0 && conv < 1) {
      const inv = Math.round(1 / conv);
      if (inv > 1 && Math.abs(1 / inv - conv) < 0.001) {
        if (!best || inv > best.perBaseQty) {
          best = { unitName: u.unitName.trim(), perBaseQty: inv };
        }
      }
    }
  }

  return best;
}

export function snapStockToProductPrecision(
  stockValue: number,
  product: Pick<Product, 'sellUnits'>
): number {
  const clean = Number(stockValue) || 0;
  if (Math.abs(clean) < 1e-5) return 0;

  const sub = getProductSubUnitInfo(product);
  if (sub && sub.perBaseQty > 1) {
    const scaled = clean * sub.perBaseQty;
    const nearest = Math.round(scaled);
    if (Math.abs(scaled - nearest) < 1e-3) {
      const snapped = roundQty(nearest / sub.perBaseQty);
      return Math.abs(snapped) < 1e-6 ? 0 : snapped;
    }
  }

  const nearestInt = Math.round(clean);
  if (Math.abs(clean - nearestInt) < 1e-5) {
    return nearestInt;
  }
  return roundQty(clean);
}

export function sanitizeSellUnits(
  units: ProductSellUnit[] | undefined,
  baseUnit: string
): ProductSellUnit[] {
  if (!units || units.length === 0) return [];
  const baseUpper = baseUnit.trim().toUpperCase();
  const seen = new Set<string>([baseUpper]);
  const cleaned: ProductSellUnit[] = [];

  for (const item of units) {
    const unitName = item.unitName.trim().slice(0, 24);
    if (!unitName) continue;
    const key = unitName.toUpperCase();
    if (seen.has(key)) continue;

    const isDivide = item.conversionMode === 'divide';
    const perBase =
      isDivide && Number.isFinite(Number(item.perBaseQty)) && Number(item.perBaseQty) > 0
        ? roundQty(Math.min(10000000, Number(item.perBaseQty)))
        : undefined;
    const rawConv = isDivide && perBase ? computeSubUnitConversion(perBase) : Number(item.conversion);
    if (!Number.isFinite(rawConv) || rawConv <= 0) continue;

    seen.add(key);
    const sellPrice = roundMoney(Math.max(0, Number(item.sellPrice) || 0));

    const entry: ProductSellUnit = {
      unitName,
      conversion: Math.min(10000000, roundQty(rawConv)),
      sellPrice,
    };

    if (
      item.buyPrice !== undefined &&
      item.buyPrice !== null &&
      Number.isFinite(Number(item.buyPrice)) &&
      Number(item.buyPrice) >= 0
    ) {
      entry.buyPrice = roundMoney(Number(item.buyPrice));
    }

    if (
      item.wholesalePrice !== undefined &&
      item.wholesalePrice !== null &&
      Number.isFinite(Number(item.wholesalePrice)) &&
      Number(item.wholesalePrice) >= 0
    ) {
      entry.wholesalePrice = roundMoney(Number(item.wholesalePrice));
    }

    if (
      item.wholesaleMinQty !== undefined &&
      item.wholesaleMinQty !== null &&
      Number.isFinite(Number(item.wholesaleMinQty)) &&
      Number(item.wholesaleMinQty) > 0
    ) {
      entry.wholesaleMinQty = roundQty(Number(item.wholesaleMinQty));
    }

    if (item.canBuy === false) {
      entry.canBuy = false;
    }
    if (item.canSell === false) {
      entry.canSell = false;
    }
    if (isDivide && perBase) {
      entry.conversionMode = 'divide';
      entry.perBaseQty = perBase;
    }

    cleaned.push(entry);
    if (cleaned.length >= 15) break;
  }

  return cleaned;
}

export function validateSellUnitsStrict(
  units: ProductSellUnit[],
  baseUnit: string,
  baseCanBuy = true,
  baseCanSell = true
): string | null {
  const baseUpper = baseUnit.trim().toUpperCase();
  if (!baseUpper) {
    return 'Satuan dasar produk wajib diisi.';
  }
  const seen = new Set<string>([baseUpper]);

  for (const u of units) {
    const uName = u.unitName.trim();
    if (!uName) {
      return 'Nama satuan tambahan tidak boleh kosong.';
    }
    const key = uName.toUpperCase();
    if (key === baseUpper) {
      return `Satuan tambahan "${uName}" tidak boleh sama dengan satuan dasar "${baseUnit.trim()}".`;
    }
    if (seen.has(key)) {
      return `Satuan tambahan "${uName}" terduplikasi.`;
    }
    seen.add(key);

    if (u.conversionMode === 'divide') {
      const perBase = Number(u.perBaseQty);
      if (!Number.isFinite(perBase) || perBase <= 0 || perBase > 10000000) {
        return `Isi per 1 ${baseUnit.trim()} untuk satuan "${uName}" harus lebih dari 0 dan maksimal 10.000.000.`;
      }
    }

    const conv = Number(u.conversion);
    if (!Number.isFinite(conv) || conv <= 0 || conv > 10000000) {
      return `Konversi satuan "${uName}" harus lebih dari 0 dan maksimal 10.000.000.`;
    }
    if (u.buyPrice !== undefined && (!Number.isFinite(Number(u.buyPrice)) || Number(u.buyPrice) < 0)) {
      return `Harga beli satuan "${uName}" tidak valid.`;
    }
    if (!Number.isFinite(Number(u.sellPrice)) || Number(u.sellPrice) < 0) {
      return `Harga jual satuan "${uName}" tidak valid.`;
    }
    if (
      u.wholesaleMinQty !== undefined &&
      (!Number.isFinite(Number(u.wholesaleMinQty)) || Number(u.wholesaleMinQty) <= 0)
    ) {
      return `Minimal beli grosir untuk "${uName}" harus lebih dari 0.`;
    }
  }

  const hasSellableUnit = baseCanSell || units.some((u) => u.canSell !== false);
  if (!hasSellableUnit) {
    return 'Minimal 1 satuan (dasar atau tambahan) harus diaktifkan untuk Penjualan / Kasir.';
  }

  const hasBuyableUnit = baseCanBuy || units.some((u) => u.canBuy !== false);
  if (!hasBuyableUnit) {
    return 'Minimal 1 satuan (dasar atau tambahan) harus diaktifkan untuk Pembelian.';
  }

  return null;
}

export interface SellUnitOption {
  unitName: string;
  conversion: number;
  buyPrice?: number;
  sellPrice: number;
  wholesalePrice?: number;
  wholesaleMinQty?: number;
  canBuy: boolean;
  canSell: boolean;
  conversionMode: 'multiply' | 'divide';
  perBaseQty?: number;
  isBase: boolean;
}

export function getProductAllUnitOptions(product: Product): SellUnitOption[] {
  const baseUnit = product.unit?.trim() || 'PCS';
  const baseOption: SellUnitOption = {
    unitName: baseUnit,
    conversion: 1,
    buyPrice: roundMoney(Math.max(0, Number(product.costPrice) || 0)),
    sellPrice: roundMoney(Math.max(0, Number(product.sellPrice) || 0)),
    ...(product.wholesalePrice !== undefined && product.wholesalePrice >= 0
      ? { wholesalePrice: roundMoney(Number(product.wholesalePrice)) }
      : {}),
    ...(product.wholesaleMinQty !== undefined && product.wholesaleMinQty > 0
      ? { wholesaleMinQty: roundQty(Number(product.wholesaleMinQty)) }
      : {}),
    canBuy: product.baseCanBuy !== false,
    canSell: product.baseCanSell !== false,
    conversionMode: 'multiply',
    isBase: true,
  };

  const extras: SellUnitOption[] = (product.sellUnits || [])
    .filter(
      (u) =>
        u.unitName.trim() &&
        u.unitName.trim().toUpperCase() !== baseUnit.toUpperCase() &&
        Number(u.conversion) > 0
    )
    .map((u) => {
      const mode: 'multiply' | 'divide' = u.conversionMode === 'divide' ? 'divide' : 'multiply';
      const perBase =
        mode === 'divide' && Number(u.perBaseQty) > 0 ? roundQty(Number(u.perBaseQty)) : undefined;
      return {
        unitName: u.unitName.trim(),
        conversion: perBase ? computeSubUnitConversion(perBase) : roundQty(Number(u.conversion)),
        ...(u.buyPrice !== undefined && Number(u.buyPrice) >= 0
          ? { buyPrice: roundMoney(Number(u.buyPrice)) }
          : {}),
        sellPrice: roundMoney(Math.max(0, Number(u.sellPrice) || 0)),
        ...(u.wholesalePrice !== undefined && u.wholesalePrice >= 0
          ? { wholesalePrice: roundMoney(Number(u.wholesalePrice)) }
          : {}),
        ...(u.wholesaleMinQty !== undefined && u.wholesaleMinQty > 0
          ? { wholesaleMinQty: roundQty(Number(u.wholesaleMinQty)) }
          : {}),
        canBuy: u.canBuy !== false,
        canSell: u.canSell !== false,
        conversionMode: mode,
        ...(perBase ? { perBaseQty: perBase } : {}),
        isBase: false,
      };
    });

  return [baseOption, ...extras];
}

export function getProductSellOptions(product: Product): SellUnitOption[] {
  return getProductAllUnitOptions(product);
}

export function getPosSellOptions(product: Product): SellUnitOption[] {
  const all = getProductAllUnitOptions(product);
  const filtered = all.filter((o) => o.canSell);
  return filtered.length > 0 ? filtered : [all[0]];
}

export function getProductBuyOptions(product: Product): SellUnitOption[] {
  const all = getProductAllUnitOptions(product);
  const filtered = all.filter((o) => o.canBuy);
  return filtered.length > 0 ? filtered : [all[0]];
}

export function computeBaseQuantityFromUnit(
  quantity: number,
  option: Pick<SellUnitOption, 'conversion' | 'conversionMode' | 'perBaseQty'>
): number {
  const cleanQty = Math.max(0, Number(quantity) || 0);
  if (option.conversionMode === 'divide' && option.perBaseQty && option.perBaseQty > 0) {
    return roundQty(cleanQty / option.perBaseQty);
  }
  return roundQty(cleanQty * option.conversion);
}

export function formatUnitConversionLabel(
  option: Pick<SellUnitOption, 'unitName' | 'conversion' | 'conversionMode' | 'perBaseQty' | 'isBase'>,
  baseUnit: string
): string {
  if (option.isBase) return 'Dasar';
  if (option.conversionMode === 'divide' && option.perBaseQty && option.perBaseQty > 0) {
    return `1 ${baseUnit} = ${formatQty(option.perBaseQty)} ${option.unitName}`;
  }
  if (option.conversion > 0 && option.conversion < 1) {
    const inv = Math.round(1 / option.conversion);
    if (inv > 1 && Math.abs(1 / inv - option.conversion) < 0.001) {
      return `1 ${baseUnit} = ${formatQty(inv)} ${option.unitName}`;
    }
  }
  return `${formatQty(option.conversion)} ${baseUnit}`;
}

export function formatProductStockSummary(
  stockInBase: number,
  product: Pick<Product, 'unit' | 'sellUnits'>
): { primary: string; secondary: string | null } {
  const baseUnit = product.unit?.trim() || 'PCS';
  const cleanStock = Math.max(0, snapStockToProductPrecision(Number(stockInBase) || 0, product));
  const sub = getProductSubUnitInfo(product);

  const largerPacks = (product.sellUnits || [])
    .filter((u) => u.unitName.trim() && Number(u.conversion) > 1)
    .slice()
    .sort((a, b) => Number(b.conversion) - Number(a.conversion));

  const formatPackEquivalent = (qtyBase: number): string | null => {
    for (const pack of largerPacks) {
      const conv = Number(pack.conversion);
      if (qtyBase + 1e-6 >= conv) {
        const wholePacks = Math.floor((qtyBase + 1e-6) / conv);
        const remBase = roundQty(Math.max(0, qtyBase - wholePacks * conv));
        if (remBase <= 1e-5) {
          return `${formatQty(wholePacks)} ${pack.unitName.trim()}`;
        }
        return `${formatQty(wholePacks)} ${pack.unitName.trim()} ${formatQty(remBase)} ${baseUnit}`;
      }
    }
    return null;
  };

  if (sub && sub.perBaseQty > 1) {
    const totalSubUnits = Math.round(cleanStock * sub.perBaseQty);
    const wholeBase = Math.floor(totalSubUnits / sub.perBaseQty);
    const remSub = totalSubUnits % sub.perBaseQty;

    if (remSub > 0) {
      const primary =
        wholeBase > 0
          ? `${formatQty(wholeBase)} ${baseUnit} ${formatQty(remSub)} ${sub.unitName}`
          : `${formatQty(remSub)} ${sub.unitName}`;
      const packInfo = wholeBase > 0 ? formatPackEquivalent(wholeBase) : null;
      const secondary = packInfo
        ? `${formatQty(cleanStock)} ${baseUnit} (${packInfo})`
        : `${formatQty(cleanStock)} ${baseUnit}`;
      return { primary, secondary };
    }

    const wholeStock = wholeBase;
    return {
      primary: `${formatQty(wholeStock)} ${baseUnit}`,
      secondary: formatPackEquivalent(wholeStock),
    };
  }

  return {
    primary: `${formatQty(cleanStock)} ${baseUnit}`,
    secondary: cleanStock > 0 ? formatPackEquivalent(cleanStock) : null,
  };
}

export interface ResolvedUnitPricing {
  option: SellUnitOption;
  priceTier: 'retail' | 'wholesale';
  hasWholesale: boolean;
  unitPrice: number;
  unitCost: number;
  baseQuantity: number;
  lineRevenue: number;
  lineCost: number;
  lineProfit: number;
  autoWholesaleTriggered: boolean;
}

export function resolveUnitPricing(
  product: Product,
  unitName: string,
  quantity: number,
  tierPreference: 'auto' | 'retail' | 'wholesale' = 'auto'
): ResolvedUnitPricing {
  const options = getProductAllUnitOptions(product);
  const option =
    options.find((o) => o.unitName.toUpperCase() === unitName.trim().toUpperCase()) || options[0];

  const hasWholesale =
    option.wholesalePrice !== undefined &&
    Number.isFinite(option.wholesalePrice) &&
    option.wholesalePrice >= 0 &&
    !(option.sellPrice > 0 && option.wholesalePrice === 0);

  const minQty = option.wholesaleMinQty ?? 1;
  const meetsMinQty = hasWholesale && option.wholesaleMinQty !== undefined && quantity >= minQty;

  let priceTier: 'retail' | 'wholesale' = 'retail';
  if (tierPreference === 'wholesale' && hasWholesale) {
    priceTier = 'wholesale';
  } else if (tierPreference === 'retail') {
    priceTier = 'retail';
  } else if (meetsMinQty) {
    priceTier = 'wholesale';
  }

  const unitPrice =
    priceTier === 'wholesale' && option.wholesalePrice !== undefined
      ? option.wholesalePrice
      : option.sellPrice;

  const cleanQty = Math.max(0, Number(quantity) || 0);
  const baseQuantity = computeBaseQuantityFromUnit(cleanQty, option);
  const baseCostPrice = Math.max(0, Number(product.costPrice) || 0);
  const unitCost = roundMoney(baseCostPrice * option.conversion);
  const lineRevenue = roundMoney(unitPrice * cleanQty);
  const lineCost = roundMoney(baseCostPrice * baseQuantity);
  const lineProfit = roundMoney(lineRevenue - lineCost);

  return {
    option,
    priceTier,
    hasWholesale,
    unitPrice,
    unitCost,
    baseQuantity,
    lineRevenue,
    lineCost,
    lineProfit,
    autoWholesaleTriggered: tierPreference === 'auto' && meetsMinQty,
  };
}

export interface UniversalCartLineInput {
  product: Product;
  unitName: string;
  quantity: number;
  tierPreference: 'auto' | 'retail' | 'wholesale';
}

export interface ComputedSaleSummary<T extends UniversalCartLineInput = UniversalCartLineInput> {
  resolvedLines: { item: T; resolved: ResolvedUnitPricing }[];
  baseDemandByProduct: Map<string, { product: Product; totalBaseQty: number }>;
  finalStockByProduct: Map<string, number>;
  subtotal: number;
  totalCost: number;
  discount: number;
  totalAmount: number;
  totalProfit: number;
  totalItems: number;
}

export function isStockSufficientWithTolerance(
  availableStock: number,
  requiredBaseQty: number,
  product: Pick<Product, 'sellUnits'>
): boolean {
  const sub = getProductSubUnitInfo(product);
  const tolerance = sub && sub.perBaseQty > 1 ? Math.min(1e-3, 0.45 / sub.perBaseQty) : 1e-5;
  return availableStock - requiredBaseQty >= -tolerance;
}

export function computeCartDemandsAndTotals<T extends UniversalCartLineInput>(
  items: T[],
  discountInput = 0
): ComputedSaleSummary<T> {
  if (items.length === 0) {
    throw new Error('Keranjang belanja masih kosong.');
  }

  const resolvedLines = items.map((item) => {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new Error(`Jumlah untuk ${item.product.name} tidak valid.`);
    }
    const resolved = resolveUnitPricing(
      item.product,
      item.unitName,
      item.quantity,
      item.tierPreference
    );
    if (!resolved.option.canSell) {
      throw new Error(
        `Satuan "${resolved.option.unitName}" pada produk "${item.product.name}" dinonaktifkan untuk penjualan kasir.`
      );
    }
    if (!Number.isFinite(resolved.option.conversion) || resolved.option.conversion <= 0) {
      throw new Error(`Konversi satuan ${item.unitName} untuk ${item.product.name} tidak valid.`);
    }
    if (resolved.baseQuantity <= 0) {
      throw new Error(`Hasil konversi jumlah untuk ${item.product.name} tidak valid.`);
    }
    return { item, resolved };
  });

  const baseDemandByProduct = new Map<string, { product: Product; totalBaseQty: number }>();
  for (const { item, resolved } of resolvedLines) {
    const existing = baseDemandByProduct.get(item.product.id);
    if (existing) {
      existing.totalBaseQty = snapStockToProductPrecision(
        existing.totalBaseQty + resolved.baseQuantity,
        item.product
      );
    } else {
      baseDemandByProduct.set(item.product.id, {
        product: item.product,
        totalBaseQty: resolved.baseQuantity,
      });
    }
  }

  const finalStockByProduct = new Map<string, number>();
  for (const { product, totalBaseQty } of baseDemandByProduct.values()) {
    const currentStock = snapStockToProductPrecision(Number(product.stock) || 0, product);
    if (!isStockSufficientWithTolerance(currentStock, totalBaseQty, product)) {
      throw new Error(
        `Stok "${product.name}" tidak mencukupi (butuh ${formatQty(totalBaseQty)} ${product.unit}, tersedia ${formatQty(currentStock)} ${product.unit}). Transaksi dibatalkan agar stok tidak negatif.`
      );
    }
    const remaining = snapStockToProductPrecision(Math.max(0, currentStock - totalBaseQty), product);
    finalStockByProduct.set(product.id, Math.max(0, remaining));
  }

  const subtotal = roundMoney(resolvedLines.reduce((sum, l) => sum + l.resolved.lineRevenue, 0));
  const totalCost = roundMoney(resolvedLines.reduce((sum, l) => sum + l.resolved.lineCost, 0));
  const discount = roundMoney(Math.max(0, Math.min(subtotal, Number(discountInput) || 0)));
  const totalAmount = roundMoney(Math.max(0, subtotal - discount));
  const totalProfit = roundMoney(totalAmount - totalCost);
  const totalItems = roundQty(items.reduce((sum, item) => sum + item.quantity, 0));

  return {
    resolvedLines,
    baseDemandByProduct,
    finalStockByProduct,
    subtotal,
    totalCost,
    discount,
    totalAmount,
    totalProfit,
    totalItems,
  };
}

export function computeStockAdjustment(
  currentStock: number,
  mode: 'in' | 'out' | 'adjustment',
  inputQty: number,
  conversion: number,
  baseUnitName: string,
  productOrOption?: {
    product?: Pick<Product, 'sellUnits'>;
    option?: Pick<SellUnitOption, 'conversion' | 'conversionMode' | 'perBaseQty'>;
  }
): {
  convertedBaseQty: number;
  stockBefore: number;
  stockAfter: number;
  loggedBaseQuantity: number;
} {
  const cleanQty = Number(inputQty);
  if (!Number.isFinite(cleanQty) || cleanQty < 0) {
    throw new Error('Jumlah stok tidak valid.');
  }
  if (!Number.isFinite(conversion) || conversion <= 0) {
    throw new Error('Konversi satuan tidak valid.');
  }

  const convertedBaseQty = productOrOption?.option
    ? computeBaseQuantityFromUnit(cleanQty, productOrOption.option)
    : roundQty(cleanQty * conversion);
  const prodMeta = productOrOption?.product || {};
  const stockBefore = snapStockToProductPrecision(Number(currentStock) || 0, prodMeta);
  let stockAfter = stockBefore;
  let loggedBaseQuantity = convertedBaseQty;

  if (mode === 'in') {
    stockAfter = snapStockToProductPrecision(stockBefore + convertedBaseQty, prodMeta);
  } else if (mode === 'out') {
    if (!isStockSufficientWithTolerance(stockBefore, convertedBaseQty, prodMeta)) {
      throw new Error(
        `Penyesuaian ditolak agar stok tidak negatif. Butuh ${formatQty(convertedBaseQty)} ${baseUnitName}, stok tersedia hanya ${formatQty(stockBefore)} ${baseUnitName}.`
      );
    }
    stockAfter = snapStockToProductPrecision(Math.max(0, stockBefore - convertedBaseQty), prodMeta);
  } else {
    stockAfter = snapStockToProductPrecision(convertedBaseQty, prodMeta);
    loggedBaseQuantity = roundQty(Math.abs(stockAfter - stockBefore));
  }

  if (stockAfter < 0) {
    throw new Error(
      `Penyesuaian ditolak agar stok tidak negatif. Butuh ${formatQty(convertedBaseQty)} ${baseUnitName}, stok tersedia hanya ${formatQty(stockBefore)} ${baseUnitName}.`
    );
  }

  return {
    convertedBaseQty,
    stockBefore,
    stockAfter,
    loggedBaseQuantity,
  };
}

