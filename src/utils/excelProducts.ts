import * as XLSX from 'xlsx';
import type { Category, Product, ProductSellUnit } from '../types/database';
import { getTodayDateString } from './formatters';

export interface ImportedProductRow {
  rowIndex: number;
  sku: string;
  barcode: string;
  name: string;
  categoryName: string;
  categoryId: string;
  unit: string;
  costPrice: number;
  sellPrice: number;
  wholesalePrice?: number;
  wholesaleMinQty?: number;
  sellUnits?: ProductSellUnit[];
  stock: number;
  minStock: number;
}

function formatSellUnitsText(units: ProductSellUnit[] | undefined): string {
  if (!units || units.length === 0) return '';
  return units
    .map((u) => {
      const base = `${u.unitName}=${u.conversion}:${u.sellPrice}`;
      if (u.wholesalePrice !== undefined) {
        return `${base}:${u.wholesalePrice}:${u.wholesaleMinQty ?? 1}`;
      }
      return base;
    })
    .join('; ');
}

function parseSellUnitsText(raw: string): ProductSellUnit[] {
  if (!raw.trim()) return [];
  const results: ProductSellUnit[] = [];
  const entries = raw.split(/[;\n]/);

  for (const entry of entries) {
    const clean = entry.trim();
    if (!clean) continue;
    // Format: SATUAN=KONVERSI:HARGA_JUAL[:HARGA_GROSIR[:MIN_QTY]]
    const eqIdx = clean.indexOf('=');
    if (eqIdx <= 0) continue;
    const unitName = clean.slice(0, eqIdx).trim().slice(0, 24);
    const parts = clean.slice(eqIdx + 1).split(':');
    const conversion = Number(parts[0]);
    const sellPrice = Number(parts[1] ?? 0);
    if (!unitName || !Number.isFinite(conversion) || conversion <= 0 || !Number.isFinite(sellPrice)) {
      continue;
    }

    const unitObj: ProductSellUnit = {
      unitName,
      conversion,
      sellPrice: Math.max(0, sellPrice),
    };

    if (parts[2] !== undefined && parts[2].trim() !== '') {
      const wp = Number(parts[2]);
      if (Number.isFinite(wp) && wp >= 0) unitObj.wholesalePrice = wp;
    }
    if (parts[3] !== undefined && parts[3].trim() !== '') {
      const mq = Number(parts[3]);
      if (Number.isFinite(mq) && mq > 0) unitObj.wholesaleMinQty = Number(mq.toFixed(4));
    }

    results.push(unitObj);
    if (results.length >= 15) break;
  }

  return results;
}

export function exportProductsToExcel(products: Product[], storeName: string): void {
  const rows = products.map((p, idx) => ({
    No: idx + 1,
    'Kode Barang': p.sku,
    Barcode: p.barcode || '',
    'Nama Barang': p.name,
    Kategori: p.categoryName,
    'Satuan Dasar': p.unit,
    'Harga Beli (HPP)': p.costPrice,
    'Harga Ecer': p.sellPrice,
    'Harga Grosir': p.wholesalePrice ?? '',
    'Min Beli Grosir': p.wholesaleMinQty ?? '',
    'Satuan Tambahan': formatSellUnitsText(p.sellUnits),
    Stok: p.stock,
    'Stok Minimum': p.minStock,
    Status:
      p.stock <= 0
        ? 'Habis'
        : p.stock <= p.minStock
          ? 'Stok Menipis'
          : p.isActive
            ? 'Aktif'
            : 'Nonaktif',
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 5 },
    { wch: 14 },
    { wch: 18 },
    { wch: 28 },
    { wch: 24 },
    { wch: 14 },
    { wch: 16 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 30 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Produk & Stok');
  const safeStore = storeName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24) || 'KEDAI-KHANXA';
  const dateCompact = getTodayDateString().replace(/-/g, '');
  XLSX.writeFile(workbook, `${safeStore}-Produk-${dateCompact}.xlsx`);
}

export function downloadProductImportTemplate(categories: Category[]): void {
  const sampleCategory = categories[0]?.name || 'Sembako';
  const templateRows = [
    {
      'Kode Barang': 'KK-0001',
      Barcode: '8991002101014',
      'Nama Barang': 'Contoh Produk (Hapus Baris Ini)',
      Kategori: sampleCategory,
      'Satuan Dasar': 'PCS',
      'Harga Beli (HPP)': 2500,
      'Harga Ecer': 3000,
      'Harga Grosir': 2800,
      'Min Beli Grosir': 10,
      'Satuan Tambahan': 'DUS=40:112000',
      Stok: 80,
      'Stok Minimum': 20,
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(templateRows);
  worksheet['!cols'] = [
    { wch: 14 },
    { wch: 18 },
    { wch: 30 },
    { wch: 24 },
    { wch: 14 },
    { wch: 18 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 28 },
    { wch: 10 },
    { wch: 14 },
  ];

  const categorySheet = XLSX.utils.json_to_sheet(
    categories.map((c) => ({ 'Kategori Tersedia': c.name }))
  );

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Template Produk');
  XLSX.utils.book_append_sheet(workbook, categorySheet, 'Daftar Kategori');
  XLSX.writeFile(workbook, 'Template-Import-Produk-KEDAI-KHANXA.xlsx');
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickField(row: Record<string, unknown>, candidates: string[]): unknown {
  const keys = Object.keys(row);
  for (const key of keys) {
    const norm = normalizeHeader(key);
    if (candidates.includes(norm)) {
      return row[key];
    }
  }
  return undefined;
}

function parseNumeric(val: unknown, fallback = 0): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : fallback;
  const cleaned = String(val ?? '')
    .replace(/[^0-9.-]/g, '')
    .trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalNumeric(val: unknown): number | undefined {
  if (val === undefined || val === null || String(val).trim() === '') return undefined;
  const parsed = parseNumeric(val, NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function parseProductsExcelFile(
  file: File,
  categories: Category[],
  existingSkuCount: number
): Promise<{ validRows: ImportedProductRow[]; errors: string[] }> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return { validRows: [], errors: ['File Excel tidak memiliki sheet data.'] };
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  if (rawRows.length === 0) {
    return { validRows: [], errors: ['File Excel kosong.'] };
  }

  const fallbackCat =
    categories.find((c) => c.name.toLowerCase() === 'produk lainnya') || categories[0];
  if (!fallbackCat) {
    return { validRows: [], errors: ['Kategori belum tersedia di database.'] };
  }

  const validRows: ImportedProductRow[] = [];
  const errors: string[] = [];

  rawRows.forEach((row, index) => {
    const rowNum = index + 2;
    const rawName = String(
      pickField(row, ['namabarang', 'nama', 'namaproduk', 'productname', 'name']) ?? ''
    ).trim();

    if (!rawName || rawName.toLowerCase().includes('contoh produk')) {
      if (rawName.toLowerCase().includes('contoh produk')) return;
      errors.push(`Baris ${rowNum}: Nama barang kosong.`);
      return;
    }

    const rawSku = String(
      pickField(row, ['kodebarang', 'kode', 'sku', 'kodeproduk']) ?? ''
    ).trim();
    const sku =
      rawSku || `KK-${String(existingSkuCount + validRows.length + 1).padStart(4, '0')}`;

    const barcode = String(
      pickField(row, ['barcode', 'kodebarcode', 'ean']) ?? ''
    )
      .trim()
      .slice(0, 64);

    const rawCat = String(
      pickField(row, ['kategori', 'category', 'kategoriproduk']) ?? ''
    )
      .trim()
      .toLowerCase();

    const matchedCat =
      categories.find((c) => c.name.toLowerCase() === rawCat) || fallbackCat;

    const unit =
      String(pickField(row, ['satuandasar', 'satuan', 'unit']) ?? 'PCS')
        .trim()
        .slice(0, 24) || 'PCS';

    const costPrice = Math.max(
      0,
      parseNumeric(pickField(row, ['hargabelihpp', 'hargabeli', 'hpp', 'modal', 'costprice']), 0)
    );
    const sellPrice = Math.max(
      0,
      parseNumeric(pickField(row, ['hargaecer', 'hargajual', 'harga', 'jual', 'sellprice']), 0)
    );
    const wholesaleRaw = parseOptionalNumeric(
      pickField(row, ['hargagrosir', 'grosir', 'wholesaleprice'])
    );
    const wholesalePrice = wholesaleRaw !== undefined ? Math.max(0, wholesaleRaw) : undefined;
    const wholesaleMinRaw = parseOptionalNumeric(
      pickField(row, ['minbeligrosir', 'mingrosir', 'wholesaleminqty'])
    );
    const wholesaleMinQty =
      wholesaleMinRaw !== undefined && wholesaleMinRaw > 0
        ? Number(wholesaleMinRaw.toFixed(4))
        : undefined;

    const sellUnitsRaw = String(
      pickField(row, ['satuantambahan', 'multisatuan', 'sellunits']) ?? ''
    );
    const sellUnits = parseSellUnitsText(sellUnitsRaw);

    const stock = Math.max(0, parseNumeric(pickField(row, ['stok', 'jumlahstok', 'stock', 'qty']), 0));
    const minStock = Math.max(
      0,
      parseNumeric(pickField(row, ['stokminimum', 'minstok', 'minstock']), 5)
    );

    validRows.push({
      rowIndex: rowNum,
      sku: sku.slice(0, 40),
      barcode,
      name: rawName.slice(0, 120),
      categoryId: matchedCat.id,
      categoryName: matchedCat.name.trim().slice(0, 60) || 'Produk lainnya',
      unit,
      costPrice,
      sellPrice,
      ...(wholesalePrice !== undefined ? { wholesalePrice } : {}),
      ...(wholesaleMinQty !== undefined ? { wholesaleMinQty } : {}),
      ...(sellUnits.length > 0 ? { sellUnits } : {}),
      stock,
      minStock,
    });
  });

  return { validRows, errors };
}
