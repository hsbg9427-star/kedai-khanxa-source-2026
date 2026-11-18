import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Product, StockOpname, StockOpnameItem, StoreSetting } from '../types/database';
import { formatQty, formatRupiah } from './formatters';
import { formatSignedStockDifference } from './stockOpnameMath';

function safeFileSlug(text: string): string {
  return (
    text
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40) || 'KEDAI_KHANXA'
  );
}

export function getVarianceStatusLabel(status: StockOpnameItem['varianceStatus']): string {
  switch (status) {
    case 'match':
      return 'Stok Cocok';
    case 'surplus':
      return 'Selisih Lebih';
    case 'deficit':
      return 'Selisih Kurang';
    default:
      return 'Belum Dihitung';
  }
}

export function exportStockOpnamePdf(params: {
  opname: StockOpname;
  items: StockOpnameItem[];
  productsById?: Map<string, Product>;
  storeSetting?: Partial<StoreSetting> | null;
}): void {
  const { opname, items, productsById, storeSetting } = params;
  const storeName = (storeSetting?.storeName || 'KEDAI KHANXA').trim().toUpperCase();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`LAPORAN HASIL STOK OPNAME — ${storeName}`, 14, 15);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const metaLines = [
    `No. Opname: ${opname.transactionNumber}   |   Judul: ${opname.title}   |   Status: ${
      opname.status === 'finalized' ? 'FINAL (Sudah Diterapkan)' : 'DRAFT (Sementara)'
    }`,
    `Mulai Opname: ${opname.transactionDate} ${opname.transactionTime} oleh ${opname.recordedByName}${
      opname.finalizedDate
        ? `   |   Finalisasi: ${opname.finalizedDate} ${opname.finalizedTime} oleh ${
            opname.finalizedByName || opname.recordedByName
          }`
        : ''
    }`,
    `Kategori: ${opname.categoryFilterName || 'Semua Kategori'}   |   Diperiksa: ${
      opname.countedProducts
    }/${opname.totalProducts} produk   |   Cocok: ${opname.matchedCount}   |   Lebih: ${
      opname.surplusCount
    }   |   Kurang: ${opname.deficitCount}   |   Nilai Selisih: ${formatRupiah(
      opname.totalVarianceValue
    )}`,
  ];
  doc.text(metaLines, 14, 21);

  const tableRows = items.map((item, idx) => {
    const productMeta = productsById?.get(item.productId) || {
      unit: item.baseUnit,
      sellUnits: [],
    };
    const physicalLabel = item.isCounted
      ? `${formatQty(item.physicalUnitQty)} ${item.physicalUnitName}${
          item.physicalSubUnitName && Number(item.physicalSubUnitQty) > 0
            ? ` + ${formatQty(Number(item.physicalSubUnitQty || 0))} ${item.physicalSubUnitName}`
            : ''
        } (${formatQty(item.physicalStockBase ?? 0)} ${item.baseUnit})`
      : '-';
    const diffLabel = item.isCounted
      ? formatSignedStockDifference(item.varianceBase, productMeta)
      : '-';
    const finalApplied =
      opname.status === 'finalized' && item.finalStockApplied !== undefined
        ? `${formatQty(item.finalStockApplied)} ${item.baseUnit}`
        : '-';
    const movementVal = item.movementSinceStart || 0;
    const movementLabel =
      Math.abs(movementVal) > 1e-5
        ? `${movementVal > 0 ? '+' : ''}${formatQty(movementVal)} ${item.baseUnit}`
        : `0 ${item.baseUnit}`;

    return [
      String(idx + 1),
      item.sku,
      item.productName,
      item.categoryName,
      `${formatQty(item.systemStockAtCount)} ${item.baseUnit}`,
      movementLabel,
      physicalLabel,
      diffLabel,
      finalApplied,
      getVarianceStatusLabel(item.varianceStatus),
      item.reason || '-',
    ];
  });

  autoTable(doc, {
    startY: 38,
    head: [
      [
        'No',
        'Kode',
        'Nama Produk',
        'Kategori',
        'Stok Sistem',
        'Mutasi Opname',
        'Stok Fisik',
        'Selisih',
        'Stok Akhir',
        'Status',
        'Keterangan',
      ],
    ],
    body: tableRows,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      1: { cellWidth: 20 },
      2: { cellWidth: 42 },
      3: { cellWidth: 24 },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 22, halign: 'right' },
      6: { cellWidth: 36, halign: 'right' },
      7: { cellWidth: 26, halign: 'right' },
      8: { cellWidth: 22, halign: 'right' },
      9: { cellWidth: 22 },
      10: { cellWidth: 28 },
    },
    margin: { left: 14, right: 14 },
  });

  if (opname.notes) {
    const finalY =
      (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 180;
    doc.setFontSize(8);
    doc.text(`Catatan Sesi: ${opname.notes}`, 14, Math.min(198, finalY + 7));
  }

  const filename = `STOK_OPNAME_${safeFileSlug(storeName)}_${opname.transactionNumber}.pdf`;
  doc.save(filename);
}
