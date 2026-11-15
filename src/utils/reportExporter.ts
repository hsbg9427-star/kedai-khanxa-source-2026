import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  BalanceMovementReport,
  ProfitLossReport,
  ResolvedReportPeriod,
  SalesTrendReport,
} from './fullReports';
import { formatQty, formatRupiah } from './formatters';
import { getMiniAtmServiceLabel, getPpobCategoryLabel } from './serviceTransactions';

export interface ExportFullReportInput {
  storeName: string;
  period: ResolvedReportPeriod;
  balanceReport: BalanceMovementReport;
  profitReport: ProfitLossReport;
  trendReport: SalesTrendReport;
}

function safeFileSlug(text: string): string {
  return text.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 40) || 'KEDAI_KHANXA';
}

export function exportFullReportExcel(input: ExportFullReportInput): void {
  const { storeName, period, balanceReport, profitReport, trendReport } = input;
  const wb = XLSX.utils.book_new();

  // 1. Ringkasan Laba & HPP
  const pnlRows = [
    { Komponen: 'Toko', Nilai: storeName },
    { Komponen: 'Periode Laporan', Nilai: period.label },
    { Komponen: 'Metode HPP Aktif', Nilai: profitReport.hppMethodLabel },
    { Komponen: 'Omzet Penjualan Retail (Kotor)', Nilai: profitReport.salesRevenue },
    { Komponen: `HPP Barang Terjual (${profitReport.hppMethod.toUpperCase()})`, Nilai: profitReport.salesCogsActive },
    { Komponen: 'Laba Kotor Retail', Nilai: profitReport.salesGrossProfit },
    { Komponen: 'Referensi HPP Moving Average', Nilai: profitReport.salesCogsMovingAverage },
    { Komponen: 'Referensi HPP FIFO', Nilai: profitReport.salesCogsFifo },
    { Komponen: 'Komisi / Laba Jasa Mini ATM', Nilai: profitReport.miniAtmProfit },
    { Komponen: 'Komisi / Laba Jasa PPOB', Nilai: profitReport.ppobProfit },
    { Komponen: 'Total Pendapatan Jasa (Mini ATM + PPOB)', Nilai: profitReport.serviceProfitTotal },
    { Komponen: 'Biaya Transaksi QRIS', Nilai: profitReport.qrisFeeTotal },
    { Komponen: 'Biaya Operasional', Nilai: profitReport.expensesTotal },
    { Komponen: 'Laba Bersih Operasional', Nilai: profitReport.netOperatingProfit },
    { Komponen: '--- POS NON-LABA (TIDAK DIHITUNG LABA) ---', Nilai: '' },
    { Komponen: 'Pinjaman Pelanggan Diberikan (Pokok)', Nilai: profitReport.nonProfitFlows.loansDisbursedAmount },
    { Komponen: 'Cicilan Pinjaman Pelanggan Masuk (Pokok)', Nilai: profitReport.nonProfitFlows.loanPaymentsAmount },
    { Komponen: 'Pelunasan Kasbon Belanja Masuk', Nilai: profitReport.nonProfitFlows.kasbonPaymentsAmount },
    { Komponen: 'Setoran Modal Masuk', Nilai: profitReport.nonProfitFlows.capitalInAmount },
    { Komponen: 'Penarikan Modal / Prive', Nilai: profitReport.nonProfitFlows.capitalOutAmount },
    { Komponen: 'Mutasi Pindah Saldo Antar Rekening', Nilai: profitReport.nonProfitFlows.transferVolumeAmount },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pnlRows), 'Ringkasan_Laba');

  // 2. Pergerakan Saldo per Kategori & Rekening
  const balBucketRows = balanceReport.bucketSummaries.map((b) => ({
    Kelompok: b.label,
    Jumlah_Akun: b.accountCount,
    Saldo_Awal: b.openingBalance,
    Uang_Masuk: b.totalIn,
    Uang_Keluar: b.totalOut,
    Mutasi_Masuk: b.transferIn,
    Mutasi_Keluar: b.transferOut,
    Saldo_Akhir: b.closingBalance,
  }));
  const balAccRows = balanceReport.accountRows.map((a) => ({
    Kelompok: a.bucketLabel,
    Nama_Akun: a.accountName,
    Saldo_Awal: a.openingBalance,
    Uang_Masuk: a.totalIn,
    Uang_Keluar: a.totalOut,
    Mutasi_Masuk: a.transferIn,
    Mutasi_Keluar: a.transferOut,
    Saldo_Akhir: a.closingBalance,
    Transaksi_Periode: a.transactionCount,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(balBucketRows), 'Saldo_Per_Kategori');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(balAccRows), 'Saldo_Per_Rekening');

  // 3. Mutasi Antar Rekening & Riwayat Mutasi Kas
  const transferRows = balanceReport.transferEvents.map((t) => ({
    Tanggal: t.transactionDate,
    Jam: t.transactionTime,
    Referensi: t.referenceNumber,
    Dari_Akun: t.fromAccountName,
    Ke_Akun: t.toAccountName,
    Nominal: t.amount,
    Keterangan: t.description,
    Petugas: t.recordedByName,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(transferRows), 'Mutasi_Antar_Rekening');

  const ledgerRows = balanceReport.periodLedgerRows.map((l) => ({
    Tanggal: l.transactionDate,
    Jam: l.transactionTime,
    No_Transaksi: l.transactionNumber,
    Kategori_Saldo: l.bucketLabel,
    Akun: l.accountName,
    Jenis_Transaksi: l.categoryLabel,
    Arah: l.direction === 'in' ? 'Uang Masuk' : 'Uang Keluar',
    Nominal: l.amount,
    Saldo_Sebelum: l.balanceBefore,
    Saldo_Sesudah: l.balanceAfter,
    Keterangan: l.description,
    Petugas: l.recordedByName,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledgerRows), 'Riwayat_Mutasi_Kas');

  // 4. Tren Penjualan & Produk Terlaris / Laba Tertinggi
  const trendRows = trendReport.trendPoints.map((pt) => ({
    Periode: pt.label,
    Omzet: pt.revenue,
    Laba_Kotor: pt.profit,
    Jumlah_Transaksi: pt.transactionCount,
    Rata_Rata_Trx: pt.transactionCount > 0 ? Math.round(pt.revenue / pt.transactionCount) : 0,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trendRows), 'Tren_Penjualan');

  const topSellRows = trendReport.topSellingProducts.map((p, idx) => ({
    Peringkat: idx + 1,
    Produk: p.productName,
    Kategori: p.categoryName,
    Qty_Terjual: p.baseQtySold,
    Satuan_Dasar: p.baseUnit,
    Jumlah_Struk: p.transactionCount,
    Omzet: p.revenue,
    HPP: p.cogs,
    Laba_Kotor: p.profit,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(topSellRows), 'Produk_Terlaris');

  const topProfitRows = trendReport.topProfitProducts.map((p, idx) => ({
    Peringkat: idx + 1,
    Produk: p.productName,
    Kategori: p.categoryName,
    Laba_Kotor: p.profit,
    Omzet: p.revenue,
    HPP: p.cogs,
    Qty_Terjual: `${formatQty(p.baseQtySold)} ${p.baseUnit}`,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(topProfitRows), 'Produk_Laba_Tertinggi');

  // 5. Biaya QRIS, Penjualan, Layanan & Pengeluaran
  const qrisRows = profitReport.qrisSalesRows.map((s) => ({
    Tanggal: s.transactionDate,
    Jam: s.transactionTime,
    No_Transaksi: s.transactionNumber,
    Metode: s.paymentMethod === 'mixed' ? 'Tunai + QRIS' : 'QRIS',
    Omzet: Number(s.totalAmount || 0),
    Nominal_QRIS: Number(s.qrisAmount || 0),
    Tarif_Persen: Number(s.qrisFeeRate || 0),
    Potongan_QRIS: Number(s.qrisFeeAmount || 0),
    Penerimaan_Bersih: Number(s.netReceivedAmount ?? s.totalAmount ?? 0),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(qrisRows), 'Biaya_QRIS');

  const atmRows = profitReport.periodMiniAtms.map((t) => ({
    Tanggal: t.transactionDate,
    No_Transaksi: t.transactionNumber,
    Layanan: getMiniAtmServiceLabel(t.serviceType),
    Bank: t.bankName,
    Nominal: t.principalAmount,
    Laba_Komisi: t.netProfit,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(atmRows), 'Mini_ATM');

  const ppobRows = profitReport.periodPpobs.map((t) => ({
    Tanggal: t.transactionDate,
    No_Transaksi: t.transactionNumber,
    Kategori: getPpobCategoryLabel(t.category),
    Provider: t.providerName,
    Tagihan: t.sellPrice + t.adminFee,
    Laba_Komisi: t.netProfit,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ppobRows), 'PPOB');

  const expRows = profitReport.periodExpenses.map((e) => ({
    Tanggal: e.transactionDate,
    No_Transaksi: e.transactionNumber,
    Kategori: e.category,
    Keterangan: e.description,
    Akun: e.accountName,
    Nominal: e.amount,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expRows), 'Pengeluaran_Ops');

  const fileName = `Laporan_Lengkap_${safeFileSlug(storeName)}_${period.startDate}_${period.endDate}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

export function exportFullReportPdf(input: ExportFullReportInput): void {
  const { storeName, period, balanceReport, profitReport, trendReport } = input;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(`LAPORAN KEUANGAN LENGKAP — ${storeName}`, 14, 15);

  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Periode: ${period.label}`, 14, 21);
  doc.text(`Metode HPP Aktif: ${profitReport.hppMethodLabel}`, 14, 26);

  // Tabel 1: Laba & Rugi
  autoTable(doc, {
    startY: 31,
    head: [['Laporan Laba & Jasa', 'Nominal']],
    body: [
      ['Omzet Penjualan Retail (Kotor)', formatRupiah(profitReport.salesRevenue)],
      [`HPP Barang Terjual (${profitReport.hppMethod === 'fifo' ? 'FIFO' : 'Moving Average'})`, formatRupiah(profitReport.salesCogsActive)],
      ['Laba Kotor Retail', formatRupiah(profitReport.salesGrossProfit)],
      ['Komisi Jasa Mini ATM', formatRupiah(profitReport.miniAtmProfit)],
      ['Komisi Jasa PPOB', formatRupiah(profitReport.ppobProfit)],
      ['(-) Biaya Transaksi Pembayaran QRIS', formatRupiah(profitReport.qrisFeeTotal)],
      ['(-) Biaya Operasional', formatRupiah(profitReport.expensesTotal)],
      ['LABA BERSIH OPERASIONAL', formatRupiah(profitReport.netOperatingProfit)],
      ['--- Pos Non-Laba (Pinjaman, Modal, Antar Rekening) ---', ''],
      ['Pinjaman Pelanggan Diberikan / Cicilan Masuk', `${formatRupiah(profitReport.nonProfitFlows.loansDisbursedAmount)} / ${formatRupiah(profitReport.nonProfitFlows.loanPaymentsAmount)}`],
      ['Mutasi Pindah Saldo Antar Rekening', formatRupiah(profitReport.nonProfitFlows.transferVolumeAmount)],
    ],
    theme: 'grid',
    headStyles: { fillColor: [4, 120, 87], fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: { 1: { halign: 'right' } },
  });

  // Tabel 2: Pergerakan Saldo per Kategori
  const yAfterPnl = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 90;
  autoTable(doc, {
    startY: yAfterPnl + 6,
    head: [['Kelompok Akun', 'Saldo Awal', 'Uang Masuk', 'Uang Keluar', 'Saldo Akhir']],
    body: [
      ...balanceReport.bucketSummaries.map((b) => [
        b.label,
        formatRupiah(b.openingBalance),
        formatRupiah(b.totalIn),
        formatRupiah(b.totalOut),
        formatRupiah(b.closingBalance),
      ]),
      [
        'TOTAL KESELURUHAN',
        formatRupiah(balanceReport.totalOpeningBalance),
        formatRupiah(balanceReport.totalIn),
        formatRupiah(balanceReport.totalOut),
        formatRupiah(balanceReport.totalClosingBalance),
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: [15, 23, 42], fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
  });

  // Tabel 3: Produk Terlaris
  const yAfterBal = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 150;
  autoTable(doc, {
    startY: yAfterBal + 6,
    head: [['Produk Terlaris (Top 10)', 'Terjual', 'Omzet', 'Laba Kotor']],
    body:
      trendReport.topSellingProducts.slice(0, 10).length > 0
        ? trendReport.topSellingProducts.slice(0, 10).map((p) => [
            p.productName,
            `${formatQty(p.baseQtySold)} ${p.baseUnit}`,
            formatRupiah(p.revenue),
            formatRupiah(p.profit),
          ])
        : [['Belum ada rincian penjualan produk pada periode ini', '-', '-', '-']],
    theme: 'grid',
    headStyles: { fillColor: [4, 120, 87], fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
    },
  });

  // Tabel 4: Ringkasan Jenis Transaksi Pergerakan Saldo
  if (balanceReport.typeBreakdown.length > 0) {
    const yAfterTop = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 210;
    autoTable(doc, {
      startY: yAfterTop + 6,
      head: [['Jenis Transaksi Kas', 'Jml', 'Masuk', 'Keluar', 'Arus Bersih']],
      body: balanceReport.typeBreakdown.map((t) => [
        t.categoryLabel,
        String(t.count),
        formatRupiah(t.totalIn),
        formatRupiah(t.totalOut),
        formatRupiah(t.netFlow),
      ]),
      theme: 'grid',
      headStyles: { fillColor: [51, 65, 85], fontSize: 8.5 },
      styles: { fontSize: 8, cellPadding: 2 },
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
      },
    });
  }

  const fileName = `Laporan_Lengkap_${safeFileSlug(storeName)}_${period.startDate}_${period.endDate}.pdf`;
  doc.save(fileName);
}
