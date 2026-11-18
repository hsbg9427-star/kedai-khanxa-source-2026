import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { MiniAtmTransaction } from '../types/database';
import { formatRupiah, getTodayDateString } from './formatters';
import { getMiniAtmServiceLabel } from './serviceTransactions';
import { roundMoney } from './unitConversion';

export type MiniAtmReportPeriodType = 'daily' | 'monthly' | 'yearly' | 'range';

export interface MiniAtmReportFilter {
  periodType: MiniAtmReportPeriodType;
  anchorDate: string; // YYYY-MM-DD
  anchorMonth: string; // YYYY-MM
  anchorYear: string; // YYYY
  startDate: string;
  endDate: string;
  cashierUid: string; // 'all' or specific uid
  serviceFilter: 'all' | 'tarik_tunai_qris' | 'tarik_tunai' | 'transfer' | 'setor_tunai';
}

export interface MiniAtmReportSummary {
  totalCount: number;
  tarikTunaiCount: number;
  transferCount: number;
  legacySetorCount: number;
  qrisTarikTunaiCount: number;
  totalNominal: number;
  tarikTunaiNominal: number;
  transferNominal: number;
  totalAdminFee: number;
  totalBankFee: number;
  totalQrisMdr: number;
  totalInternalExtraFee: number;
  totalNetProfit: number;
}

export interface MiniAtmCashierSummary {
  uid: string;
  name: string;
  count: number;
  totalNominal: number;
  totalAdminFee: number;
  totalBankFee: number;
  totalQrisMdr: number;
  totalInternalExtraFee: number;
  totalNetProfit: number;
}

export interface MiniAtmReportResult {
  periodLabel: string;
  startDate: string;
  endDate: string;
  summary: MiniAtmReportSummary;
  cashierBreakdown: MiniAtmCashierSummary[];
  rows: MiniAtmTransaction[];
}

export function resolveMiniAtmReportRange(filter: MiniAtmReportFilter): {
  startDate: string;
  endDate: string;
  periodLabel: string;
} {
  const today = getTodayDateString();
  if (filter.periodType === 'daily') {
    const d = filter.anchorDate || today;
    return { startDate: d, endDate: d, periodLabel: `Harian (${d})` };
  }
  if (filter.periodType === 'monthly') {
    const ym = filter.anchorMonth || today.slice(0, 7);
    const [yStr, mStr] = ym.split('-');
    const year = Number(yStr) || Number(today.slice(0, 4));
    const month = Number(mStr) || Number(today.slice(5, 7));
    const lastDay = new Date(year, month, 0).getDate();
    const startDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
      lastDay
    ).padStart(2, '0')}`;
    return { startDate, endDate, periodLabel: `Bulanan (${ym})` };
  }
  if (filter.periodType === 'yearly') {
    const y = (filter.anchorYear || today.slice(0, 4)).slice(0, 4);
    return {
      startDate: `${y}-01-01`,
      endDate: `${y}-12-31`,
      periodLabel: `Tahunan (${y})`,
    };
  }
  const s = filter.startDate || today;
  const e = filter.endDate || today;
  const startDate = s <= e ? s : e;
  const endDate = s <= e ? e : s;
  return {
    startDate,
    endDate,
    periodLabel: `Rentang (${startDate} s.d. ${endDate})`,
  };
}

export function buildMiniAtmReport(
  transactions: MiniAtmTransaction[],
  filter: MiniAtmReportFilter
): MiniAtmReportResult {
  const { startDate, endDate, periodLabel } = resolveMiniAtmReportRange(filter);

  const rows = transactions
    .filter((tx) => {
      if (tx.status !== 'completed') return false;
      if (tx.transactionDate < startDate || tx.transactionDate > endDate) return false;
      if (filter.cashierUid !== 'all' && tx.recordedByUid !== filter.cashierUid) return false;
      if (filter.serviceFilter === 'tarik_tunai_qris') {
        if (tx.serviceType !== 'tarik_tunai' || tx.paymentChannel !== 'qris') return false;
      } else if (filter.serviceFilter !== 'all' && tx.serviceType !== filter.serviceFilter) {
        return false;
      }
      return true;
    })
    .sort((a, b) =>
      `${b.transactionDate} ${b.transactionTime}`.localeCompare(
        `${a.transactionDate} ${a.transactionTime}`
      )
    );

  const summary: MiniAtmReportSummary = {
    totalCount: 0,
    tarikTunaiCount: 0,
    transferCount: 0,
    legacySetorCount: 0,
    qrisTarikTunaiCount: 0,
    totalNominal: 0,
    tarikTunaiNominal: 0,
    transferNominal: 0,
    totalAdminFee: 0,
    totalBankFee: 0,
    totalQrisMdr: 0,
    totalInternalExtraFee: 0,
    totalNetProfit: 0,
  };

  const cashierMap = new Map<string, MiniAtmCashierSummary>();

  for (const tx of rows) {
    const nominal = roundMoney(Number(tx.principalAmount) || 0);
    const adminFee = roundMoney(Number(tx.adminFee) || 0);
    const bankFee = roundMoney(Number(tx.bankFee) || 0);
    const qrisMdr = roundMoney(Number(tx.qrisMdrAmount) || 0);
    const internalExtra = roundMoney(Number(tx.internalExtraFee) || 0);
    const netProfit = roundMoney(Number(tx.netProfit) || 0);

    summary.totalCount += 1;
    summary.totalNominal = roundMoney(summary.totalNominal + nominal);
    summary.totalAdminFee = roundMoney(summary.totalAdminFee + adminFee);
    summary.totalBankFee = roundMoney(summary.totalBankFee + bankFee);
    summary.totalQrisMdr = roundMoney(summary.totalQrisMdr + qrisMdr);
    summary.totalInternalExtraFee = roundMoney(summary.totalInternalExtraFee + internalExtra);
    summary.totalNetProfit = roundMoney(summary.totalNetProfit + netProfit);

    if (tx.serviceType === 'tarik_tunai') {
      summary.tarikTunaiCount += 1;
      summary.tarikTunaiNominal = roundMoney(summary.tarikTunaiNominal + nominal);
      if (tx.paymentChannel === 'qris') {
        summary.qrisTarikTunaiCount += 1;
      }
    } else if (tx.serviceType === 'transfer') {
      summary.transferCount += 1;
      summary.transferNominal = roundMoney(summary.transferNominal + nominal);
    } else {
      summary.legacySetorCount += 1;
    }

    const existing = cashierMap.get(tx.recordedByUid) || {
      uid: tx.recordedByUid,
      name: tx.recordedByName || 'Kasir',
      count: 0,
      totalNominal: 0,
      totalAdminFee: 0,
      totalBankFee: 0,
      totalQrisMdr: 0,
      totalInternalExtraFee: 0,
      totalNetProfit: 0,
    };

    existing.count += 1;
    existing.totalNominal = roundMoney(existing.totalNominal + nominal);
    existing.totalAdminFee = roundMoney(existing.totalAdminFee + adminFee);
    existing.totalBankFee = roundMoney(existing.totalBankFee + bankFee);
    existing.totalQrisMdr = roundMoney(existing.totalQrisMdr + qrisMdr);
    existing.totalInternalExtraFee = roundMoney(existing.totalInternalExtraFee + internalExtra);
    existing.totalNetProfit = roundMoney(existing.totalNetProfit + netProfit);
    cashierMap.set(tx.recordedByUid, existing);
  }

  const cashierBreakdown = Array.from(cashierMap.values()).sort(
    (a, b) => b.totalNetProfit - a.totalNetProfit
  );

  return {
    periodLabel,
    startDate,
    endDate,
    summary,
    cashierBreakdown,
    rows,
  };
}

function safeSlug(text: string): string {
  return text.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 40) || 'KEDAI_KHANXA';
}

export function exportMiniAtmReportExcel(
  storeName: string,
  report: MiniAtmReportResult,
  cashierFilterLabel: string
): void {
  const wb = XLSX.utils.book_new();

  const summaryRows = [
    { Keterangan: 'Toko', Nilai: storeName },
    { Keterangan: 'Periode Laporan', Nilai: report.periodLabel },
    { Keterangan: 'Filter Kasir', Nilai: cashierFilterLabel },
    { Keterangan: 'Total Transaksi Selesai', Nilai: report.summary.totalCount },
    { Keterangan: 'Transaksi Tarik Tunai', Nilai: report.summary.tarikTunaiCount },
    { Keterangan: 'Transaksi Tarik Tunai QRIS', Nilai: report.summary.qrisTarikTunaiCount },
    { Keterangan: 'Transaksi Transfer Bank', Nilai: report.summary.transferCount },
    { Keterangan: 'Total Nominal Transaksi', Nilai: report.summary.totalNominal },
    { Keterangan: 'Total Biaya Jasa Warung', Nilai: report.summary.totalAdminFee },
    { Keterangan: '(+) Potongan Biaya Internal dari Saldo QRIS (>Rp500)', Nilai: report.summary.totalInternalExtraFee },
    { Keterangan: '(-) Total Biaya Bank', Nilai: report.summary.totalBankFee },
    { Keterangan: '(-) Total MDR QRIS Merchant', Nilai: report.summary.totalQrisMdr },
    { Keterangan: 'Total Keuntungan Bersih Mini ATM', Nilai: report.summary.totalNetProfit },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Ringkasan_Mini_ATM');

  const cashierRows = report.cashierBreakdown.map((c) => ({
    Nama_Kasir: c.name,
    Jumlah_Transaksi: c.count,
    Total_Nominal: c.totalNominal,
    Total_Biaya_Jasa: c.totalAdminFee,
    Total_Biaya_Bank: c.totalBankFee,
    Total_MDR_QRIS: c.totalQrisMdr,
    Total_Biaya_Internal: c.totalInternalExtraFee,
    Keuntungan_Bersih: c.totalNetProfit,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cashierRows), 'Rekap_Per_Kasir');

  const detailRows = report.rows.map((t) => ({
    No_Transaksi: t.transactionNumber,
    Tanggal: t.transactionDate,
    Jam: t.transactionTime,
    Layanan: getMiniAtmServiceLabel(t.serviceType),
    Kanal_Bayar: t.paymentChannel === 'qris' ? 'QRIS Warung' : 'Kartu / Rekening Bank',
    Bank_Tujuan: t.bankName,
    No_Rekening_Tujuan: t.targetAccountNumber || '',
    Nama_Penerima_Pelanggan: t.customerName || '',
    No_Referensi_Bank: t.externalReferenceNumber || '',
    Nominal_Pokok: Number(t.principalAmount || 0),
    Biaya_Jasa_Warung: Number(t.adminFee || 0),
    Tambahan_Biaya_Pelanggan_500: Number(t.internalExtraFee || 0),
    Biaya_Bank: Number(t.bankFee || 0),
    MDR_QRIS: Number(t.qrisMdrAmount || 0),
    Keuntungan_Bersih: Number(t.netProfit || 0),
    Tarif_Diubah_Manual: t.feeOverridden ? 'Ya' : 'Standar',
    Petugas: t.recordedByName,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), 'Rincian_Transaksi');

  XLSX.writeFile(
    wb,
    `Laporan_Mini_ATM_${safeSlug(storeName)}_${report.startDate}_${report.endDate}.xlsx`
  );
}

export function exportMiniAtmReportPdf(
  storeName: string,
  report: MiniAtmReportResult,
  cashierFilterLabel: string
): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(`LAPORAN MINI ATM — ${storeName}`, 14, 15);

  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Periode: ${report.periodLabel}`, 14, 21);
  doc.text(`Kasir: ${cashierFilterLabel}`, 14, 26);

  autoTable(doc, {
    startY: 31,
    head: [['Ringkasan Laporan Mini ATM', 'Nilai']],
    body: [
      ['Total Transaksi Selesai', `${report.summary.totalCount} transaksi`],
      [
        'Rincian Layanan',
        `Tarik Tunai: ${report.summary.tarikTunaiCount} (QRIS: ${report.summary.qrisTarikTunaiCount}) · Transfer Bank: ${report.summary.transferCount}`,
      ],
      ['Total Nominal Transaksi (Pokok)', formatRupiah(report.summary.totalNominal)],
      ['Total Biaya Jasa Warung', formatRupiah(report.summary.totalAdminFee)],
      ['(+) Potongan Internal dr Saldo QRIS (>Rp500)', formatRupiah(report.summary.totalInternalExtraFee)],
      ['(-) Total Biaya Bank', formatRupiah(report.summary.totalBankFee)],
      ['(-) Total MDR QRIS Merchant', formatRupiah(report.summary.totalQrisMdr)],
      ['TOTAL KEUNTUNGAN BERSIH', formatRupiah(report.summary.totalNetProfit)],
    ],
    theme: 'grid',
    headStyles: { fillColor: [4, 120, 87], fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: { 1: { halign: 'right' } },
  });

  const y1 = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 80;

  if (report.cashierBreakdown.length > 0) {
    autoTable(doc, {
      startY: y1 + 6,
      head: [['Kasir', 'Trx', 'Nominal', 'Jasa+Tamb', 'Biaya Bank', 'MDR QRIS', 'Laba Bersih']],
      body: report.cashierBreakdown.map((c) => [
        c.name,
        String(c.count),
        formatRupiah(c.totalNominal),
        formatRupiah(c.totalAdminFee + c.totalInternalExtraFee),
        formatRupiah(c.totalBankFee),
        formatRupiah(c.totalQrisMdr),
        formatRupiah(c.totalNetProfit),
      ]),
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], fontSize: 8 },
      styles: { fontSize: 7.5, cellPadding: 1.8 },
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        5: { halign: 'right' },
        6: { halign: 'right' },
      },
    });
  }

  const y2 = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || y1 + 20;
  autoTable(doc, {
    startY: y2 + 6,
    head: [['Tanggal', 'No. Trx', 'Layanan & Bank', 'Nominal', 'Jasa+Tamb', 'Bank+MDR', 'Laba']],
    body: report.rows.slice(0, 60).map((t) => [
      t.transactionDate,
      t.transactionNumber,
      `${getMiniAtmServiceLabel(t.serviceType)} · ${t.bankName}${
        t.paymentChannel === 'qris' ? ' (QRIS)' : ''
      }`,
      formatRupiah(t.principalAmount),
      formatRupiah((Number(t.adminFee) || 0) + (Number(t.internalExtraFee) || 0)),
      formatRupiah((Number(t.bankFee) || 0) + (Number(t.qrisMdrAmount) || 0)),
      formatRupiah(t.netProfit),
    ]),
    theme: 'grid',
    headStyles: { fillColor: [4, 120, 87], fontSize: 8 },
    styles: { fontSize: 7, cellPadding: 1.6 },
    columnStyles: {
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
    },
  });

  doc.save(`Laporan_Mini_ATM_${safeSlug(storeName)}_${report.startDate}_${report.endDate}.pdf`);
}
