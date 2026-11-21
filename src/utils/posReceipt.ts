import type { MiniAtmTransaction, PpobTransaction, StoreSetting } from '../types/database';
import type { RecordedSaleReceipt } from '../services/inventoryService';
import { formatQty, formatRupiah } from './formatters';
import type { RetailPaymentMethod } from './qrisFee';

const RECEIPT_WIDTH = 34;

export function getPaymentMethodLabel(method: RetailPaymentMethod): string {
  switch (method) {
    case 'cash':
      return 'Tunai';
    case 'qris':
      return 'QRIS';
    case 'mixed':
      return 'Tunai + QRIS';
    case 'transfer':
      return 'Transfer Bank';
    case 'debt':
      return 'Kasbon / Piutang';
    default:
      return String(method).toUpperCase();
  }
}

function formatPlainRp(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const formatted = new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(safe);
  return `Rp${formatted}`;
}

function wrapText(text: string, width: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function centerLines(text: string, width: number): string[] {
  return wrapText(text, width).map((line) => {
    const padLeft = Math.max(0, Math.floor((width - line.length) / 2));
    return `${' '.repeat(padLeft)}${line}`;
  });
}

function formatRow(left: string, right: string, width = RECEIPT_WIDTH): string[] {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();
  if (cleanLeft.length + 1 + cleanRight.length <= width) {
    const spaces = width - cleanLeft.length - cleanRight.length;
    return [`${cleanLeft}${' '.repeat(spaces)}${cleanRight}`];
  }
  const wrappedLeft = wrapText(cleanLeft, width);
  const lastIdx = wrappedLeft.length - 1;
  if (lastIdx >= 0 && wrappedLeft[lastIdx].length + 1 + cleanRight.length <= width) {
    const spaces = width - wrappedLeft[lastIdx].length - cleanRight.length;
    wrappedLeft[lastIdx] = `${wrappedLeft[lastIdx]}${' '.repeat(spaces)}${cleanRight}`;
    return wrappedLeft;
  }
  const rightPad = Math.max(0, width - cleanRight.length);
  return [...wrappedLeft, `${' '.repeat(rightPad)}${cleanRight}`];
}

export function formatPosReceiptText(
  receipt: RecordedSaleReceipt,
  storeSetting?: Partial<StoreSetting> | null
): string {
  const eqDivider = '='.repeat(RECEIPT_WIDTH);
  const dashDivider = '-'.repeat(RECEIPT_WIDTH);

  const storeName = (storeSetting?.storeName || 'KEDAI KHANXA').trim().toUpperCase();
  const receiptHeader = (storeSetting?.receiptHeader || '').trim();
  const storeAddress = (storeSetting?.address || '').trim();
  const storePhone = (storeSetting?.phone || '').trim();
  const thankYou = (
    storeSetting?.receiptThankYou ||
    storeSetting?.receiptFooter ||
    'Terima kasih telah berbelanja!'
  ).trim();
  const footerNote = (storeSetting?.receiptFooter || '').trim();

  const lines: string[] = [];
  lines.push(...centerLines(storeName, RECEIPT_WIDTH));
  if (receiptHeader) lines.push(...centerLines(receiptHeader, RECEIPT_WIDTH));
  if (storeAddress) lines.push(...centerLines(storeAddress, RECEIPT_WIDTH));
  if (storePhone) lines.push(...centerLines(`Telp/WA: ${storePhone}`, RECEIPT_WIDTH));
  lines.push(eqDivider);

  lines.push(`No     : ${receipt.transactionNumber}`);
  lines.push(`Tgl    : ${receipt.transactionDate} ${receipt.transactionTime}`);
  lines.push(`Kasir  : ${receipt.recordedByName}`);
  if (receipt.customerName) {
    lines.push(`Plg    : ${receipt.customerName}`);
  }
  lines.push(dashDivider);

  receipt.items.forEach((item) => {
    const tierTag = item.priceTier === 'wholesale' ? ' [Grosir]' : '';
    lines.push(...wrapText(`${item.name}${tierTag}`, RECEIPT_WIDTH));
    const qtyExpr = `  ${formatQty(item.quantity)} ${item.unitName} x ${formatPlainRp(
      item.unitPrice
    )}`;
    lines.push(...formatRow(qtyExpr, formatPlainRp(item.subtotal), RECEIPT_WIDTH));
  });

  lines.push(dashDivider);
  lines.push(...formatRow('Subtotal', formatPlainRp(receipt.subtotal), RECEIPT_WIDTH));
  if (receipt.discount > 0) {
    lines.push(...formatRow('Diskon', `-${formatPlainRp(receipt.discount)}`, RECEIPT_WIDTH));
  }
  const recPaid = Number(receipt.receivablePaidAmount) || 0;
  const grandDue = receipt.totalAmount + recPaid;

  lines.push(...formatRow('TOTAL BELANJA', formatPlainRp(receipt.totalAmount), RECEIPT_WIDTH));
  if (recPaid > 0) {
    lines.push(...formatRow('Bayar Piutang', formatPlainRp(recPaid), RECEIPT_WIDTH));
    lines.push(...formatRow('TOTAL BAYAR', formatPlainRp(grandDue), RECEIPT_WIDTH));
  }
  lines.push(dashDivider);

  const methodLabel = getPaymentMethodLabel(receipt.paymentMethod);
  if (receipt.debtAmount > 0) {
    lines.push(...formatRow('Metode', methodLabel, RECEIPT_WIDTH));
    lines.push(...formatRow('Dibayar (DP)', formatPlainRp(receipt.paidAmount), RECEIPT_WIDTH));
    lines.push(...formatRow('Kasbon Baru', formatPlainRp(receipt.debtAmount), RECEIPT_WIDTH));
    if (receipt.customerDebtAfter !== undefined) {
      lines.push(...formatRow('Total Piutang', formatPlainRp(receipt.customerDebtAfter), RECEIPT_WIDTH));
    }
  } else {
    lines.push(...formatRow(`Bayar (${methodLabel})`, formatPlainRp(receipt.paidAmount), RECEIPT_WIDTH));
    if (receipt.paymentMethod === 'mixed') {
      lines.push(
        ...formatRow(
          recPaid > 0 ? '  - Tunai Belanja' : '  - Tunai',
          formatPlainRp(receipt.cashPaidPart),
          RECEIPT_WIDTH
        )
      );
      lines.push(
        ...formatRow(
          recPaid > 0 ? '  - QRIS Belanja' : '  - QRIS',
          formatPlainRp(receipt.qrisAmount),
          RECEIPT_WIDTH
        )
      );
    }
    lines.push(...formatRow('Kembali', formatPlainRp(receipt.changeAmount), RECEIPT_WIDTH));
    if (receipt.customerDebtAfter !== undefined && (recPaid > 0 || (receipt.customerDebtBefore || 0) > 0)) {
      lines.push(
        ...formatRow(
          'Sisa Piutang',
          receipt.customerDebtAfter <= 0 ? 'LUNAS (Rp0)' : formatPlainRp(receipt.customerDebtAfter),
          RECEIPT_WIDTH
        )
      );
    }
  }

  lines.push(eqDivider);
  lines.push(...centerLines(thankYou, RECEIPT_WIDTH));
  if (footerNote && footerNote !== thankYou) {
    lines.push(...centerLines(footerNote, RECEIPT_WIDTH));
  }

  return lines.join('\n');
}

export function normalizeWhatsAppPhone(rawPhone?: string | null): string | null {
  if (!rawPhone) return null;
  let digits = rawPhone.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.startsWith('620')) {
    digits = `62${digits.slice(3)}`;
  } else if (digits.startsWith('0')) {
    digits = `62${digits.slice(1)}`;
  } else if (digits.startsWith('8')) {
    digits = `62${digits}`;
  }

  if (digits.length < 9 || digits.length > 15) {
    return null;
  }
  return digits;
}

export function formatWhatsAppDisplayPhone(rawPhone?: string | null): string {
  const normalized = normalizeWhatsAppPhone(rawPhone);
  if (!normalized) return (rawPhone || '').trim();
  return `+${normalized}`;
}

export function formatWhatsAppReceiptMessage(
  receipt: RecordedSaleReceipt,
  storeSetting?: Partial<StoreSetting> | null
): string {
  const storeName = (storeSetting?.storeName || 'KEDAI KHANXA').trim().toUpperCase();
  const receiptHeader = (storeSetting?.receiptHeader || '').trim();
  const storeAddress = (storeSetting?.address || '').trim();
  const storePhone = (storeSetting?.phone || '').trim();
  const thankYou = (
    storeSetting?.receiptThankYou ||
    storeSetting?.receiptFooter ||
    'Terima kasih telah berbelanja!'
  ).trim();
  const footerNote = (storeSetting?.receiptFooter || '').trim();
  const methodLabel = getPaymentMethodLabel(receipt.paymentMethod);

  const lines: string[] = [];
  lines.push(`*STRUK TRANSAKSI - ${storeName}*`);
  if (receiptHeader) lines.push(`_${receiptHeader}_`);
  if (storeAddress) lines.push(storeAddress);
  if (storePhone) lines.push(`Telp/WA: ${storePhone}`);
  lines.push('--------------------------------');
  lines.push(`No. Transaksi : ${receipt.transactionNumber}`);
  lines.push(`Tanggal       : ${receipt.transactionDate} ${receipt.transactionTime}`);
  lines.push(`Kasir         : ${receipt.recordedByName}`);
  if (receipt.customerName) {
    lines.push(`Pelanggan     : ${receipt.customerName}`);
  }
  lines.push('--------------------------------');
  lines.push('*Rincian Belanja:*');

  receipt.items.forEach((item, idx) => {
    const tierNote = item.priceTier === 'wholesale' ? ' (Grosir)' : '';
    lines.push(`${idx + 1}. ${item.name}${tierNote}`);
    lines.push(
      `   ${formatQty(item.quantity)} ${item.unitName} x ${formatRupiah(
        item.unitPrice
      )} = *${formatRupiah(item.subtotal)}*`
    );
  });

  lines.push('--------------------------------');
  lines.push(`Subtotal : ${formatRupiah(receipt.subtotal)}`);
  if (receipt.discount > 0) {
    lines.push(`Diskon   : -${formatRupiah(receipt.discount)}`);
  }
  const recPaidWa = Number(receipt.receivablePaidAmount) || 0;
  const grandDueWa = receipt.totalAmount + recPaidWa;

  lines.push(`*Belanja  : ${formatRupiah(receipt.totalAmount)}*`);
  if (recPaidWa > 0) {
    lines.push(`Bayar Piutang : ${formatRupiah(recPaidWa)}`);
    lines.push(`*TOTAL BAYAR   : ${formatRupiah(grandDueWa)}*`);
  }
  lines.push(`Metode   : ${methodLabel}`);

  if (receipt.debtAmount > 0) {
    lines.push(`Dibayar (DP) : ${formatRupiah(receipt.paidAmount)}`);
    lines.push(`*Kasbon Baru  : ${formatRupiah(receipt.debtAmount)}*`);
    if (receipt.customerDebtAfter !== undefined) {
      lines.push(`*Total Piutang: ${formatRupiah(receipt.customerDebtAfter)}*`);
    }
  } else {
    lines.push(`Dibayar  : ${formatRupiah(receipt.paidAmount)}`);
    if (receipt.paymentMethod === 'mixed') {
      lines.push(
        `  (${recPaidWa > 0 ? 'Belanja: ' : ''}Tunai ${formatRupiah(
          receipt.cashPaidPart
        )} + QRIS ${formatRupiah(receipt.qrisAmount)})`
      );
    }
    lines.push(`Kembali  : ${formatRupiah(receipt.changeAmount)}`);
    if (receipt.customerDebtAfter !== undefined && (recPaidWa > 0 || (receipt.customerDebtBefore || 0) > 0)) {
      lines.push(
        `*Sisa Piutang : ${
          receipt.customerDebtAfter <= 0 ? 'LUNAS (Rp0)' : formatRupiah(receipt.customerDebtAfter)
        }*`
      );
    }
  }

  lines.push('--------------------------------');
  lines.push(`*${thankYou}*`);
  if (footerNote && footerNote !== thankYou) {
    lines.push(`_${footerNote}_`);
  }

  return lines.join('\n');
}

export function buildWhatsAppShareUrl(phone: string | null | undefined, message: string): string | null {
  const normalized = normalizeWhatsAppPhone(phone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

function getMiniAtmTypeLabel(serviceType: MiniAtmTransaction['serviceType']): string {
  switch (serviceType) {
    case 'tarik_tunai':
      return 'Tarik Tunai';
    case 'transfer':
      return 'Transfer Bank';
    case 'setor_tunai':
      return 'Setor Tunai';
    default:
      return String(serviceType);
  }
}

function getPpobCatLabel(cat: PpobTransaction['category']): string {
  switch (cat) {
    case 'pulsa':
      return 'Pulsa';
    case 'paket_data':
      return 'Paket Data';
    case 'pln':
      return 'Token / PLN';
    case 'pdam':
      return 'PDAM';
    case 'bpjs':
      return 'BPJS';
    case 'ewallet':
      return 'Top Up E-Wallet';
    default:
      return 'Tagihan PPOB';
  }
}

export function formatMiniAtmReceiptText(
  tx: MiniAtmTransaction,
  storeSetting?: Partial<StoreSetting> | null
): string {
  const eqDivider = '='.repeat(RECEIPT_WIDTH);
  const dashDivider = '-'.repeat(RECEIPT_WIDTH);

  const storeName = (storeSetting?.storeName || 'KEDAI KHANXA').trim().toUpperCase();
  const receiptHeader = (storeSetting?.receiptHeader || '').trim();
  const storeAddress = (storeSetting?.address || '').trim();
  const storePhone = (storeSetting?.phone || '').trim();
  const thankYou = (
    storeSetting?.receiptThankYou ||
    storeSetting?.receiptFooter ||
    'Terima kasih telah bertransaksi!'
  ).trim();
  const footerNote = (storeSetting?.receiptFooter || '').trim();

  const lines: string[] = [];
  lines.push(...centerLines(storeName, RECEIPT_WIDTH));
  if (receiptHeader) lines.push(...centerLines(receiptHeader, RECEIPT_WIDTH));
  if (storeAddress) lines.push(...centerLines(storeAddress, RECEIPT_WIDTH));
  if (storePhone) lines.push(...centerLines(`Telp/WA: ${storePhone}`, RECEIPT_WIDTH));
  lines.push(...centerLines('BUKTI TRANSAKSI MINI ATM', RECEIPT_WIDTH));
  lines.push(eqDivider);

  lines.push(`No     : ${tx.transactionNumber}`);
  lines.push(`Tgl    : ${tx.transactionDate} ${tx.transactionTime}`);
  lines.push(`Kasir  : ${tx.recordedByName}`);
  if (tx.customerName) {
    lines.push(`Plg    : ${tx.customerName}`);
  }
  lines.push(dashDivider);

  lines.push(
    ...formatRow(
      'Layanan',
      `${getMiniAtmTypeLabel(tx.serviceType)}${tx.paymentChannel === 'qris' ? ' (QRIS)' : ''}`,
      RECEIPT_WIDTH
    )
  );
  lines.push(...formatRow('Bank', tx.bankName, RECEIPT_WIDTH));
  if (tx.targetAccountNumber) {
    lines.push(...formatRow('Tujuan', tx.targetAccountNumber, RECEIPT_WIDTH));
  }
  if (tx.externalReferenceNumber) {
    lines.push(...formatRow('Ref Bank', tx.externalReferenceNumber, RECEIPT_WIDTH));
  }
  lines.push(dashDivider);

  const nominalLabel =
    tx.serviceType === 'tarik_tunai' && tx.paymentChannel === 'qris' ? 'Nominal QRIS' : 'Nominal';
  lines.push(...formatRow(nominalLabel, formatPlainRp(tx.principalAmount), RECEIPT_WIDTH));
  if ((tx.internalExtraFee || 0) > 0) {
    lines.push(...formatRow('Pot. Internal', `-${formatPlainRp(tx.internalExtraFee || 0)}`, RECEIPT_WIDTH));
  }
  lines.push(...formatRow('Biaya Jasa', formatPlainRp(tx.adminFee), RECEIPT_WIDTH));

  const totalFinal =
    tx.serviceType === 'tarik_tunai'
      ? tx.paymentStatus === 'debt'
        ? tx.principalAmount + tx.adminFee
        : Math.max(0, tx.principalAmount - (tx.internalExtraFee || 0))
      : tx.principalAmount + tx.adminFee;
  const totalLabel =
    tx.serviceType === 'tarik_tunai'
      ? tx.paymentStatus === 'debt'
        ? 'TOTAL TAGIHAN'
        : 'TUNAI DITERIMA'
      : 'TOTAL BAYAR';
  lines.push(...formatRow(totalLabel, formatPlainRp(totalFinal), RECEIPT_WIDTH));

  const isDebt = tx.paymentStatus === 'debt' || (Number(tx.debtAmount) || 0) > 0;
  lines.push(...formatRow('Status Bayar', isDebt ? 'HUTANG (BON)' : 'LUNAS', RECEIPT_WIDTH));
  if (isDebt) {
    lines.push(...formatRow('Dibayar (DP)', formatPlainRp(Number(tx.paidAmount) || 0), RECEIPT_WIDTH));
    lines.push(
      ...formatRow(
        'Masuk Bon',
        formatPlainRp(Number(tx.debtAmount) || Math.max(0, totalFinal - (Number(tx.paidAmount) || 0))),
        RECEIPT_WIDTH
      )
    );
  }

  if (tx.notes) {
    lines.push(dashDivider);
    lines.push(...wrapText(`Ket: ${tx.notes}`, RECEIPT_WIDTH));
  }

  lines.push(eqDivider);
  lines.push(...centerLines(thankYou, RECEIPT_WIDTH));
  if (footerNote && footerNote !== thankYou) {
    lines.push(...centerLines(footerNote, RECEIPT_WIDTH));
  }
  return lines.join('\n');
}

export function formatPpobReceiptText(
  tx: PpobTransaction,
  storeSetting?: Partial<StoreSetting> | null
): string {
  const eqDivider = '='.repeat(RECEIPT_WIDTH);
  const dashDivider = '-'.repeat(RECEIPT_WIDTH);

  const storeName = (storeSetting?.storeName || 'KEDAI KHANXA').trim().toUpperCase();
  const receiptHeader = (storeSetting?.receiptHeader || '').trim();
  const storeAddress = (storeSetting?.address || '').trim();
  const storePhone = (storeSetting?.phone || '').trim();
  const thankYou = (
    storeSetting?.receiptThankYou ||
    storeSetting?.receiptFooter ||
    'Terima kasih telah bertransaksi!'
  ).trim();
  const footerNote = (storeSetting?.receiptFooter || '').trim();

  const lines: string[] = [];
  lines.push(...centerLines(storeName, RECEIPT_WIDTH));
  if (receiptHeader) lines.push(...centerLines(receiptHeader, RECEIPT_WIDTH));
  if (storeAddress) lines.push(...centerLines(storeAddress, RECEIPT_WIDTH));
  if (storePhone) lines.push(...centerLines(`Telp/WA: ${storePhone}`, RECEIPT_WIDTH));
  lines.push(...centerLines('BUKTI PEMBAYARAN PPOB', RECEIPT_WIDTH));
  lines.push(eqDivider);

  lines.push(`No     : ${tx.transactionNumber}`);
  lines.push(`Tgl    : ${tx.transactionDate} ${tx.transactionTime}`);
  lines.push(`Kasir  : ${tx.recordedByName}`);
  if (tx.customerName) {
    lines.push(`Plg    : ${tx.customerName}`);
  }
  lines.push(dashDivider);

  lines.push(...formatRow('Kategori', getPpobCatLabel(tx.category), RECEIPT_WIDTH));
  lines.push(...formatRow('Produk', tx.providerName, RECEIPT_WIDTH));
  lines.push(...formatRow('ID/Tujuan', tx.targetNumber, RECEIPT_WIDTH));
  lines.push(
    ...formatRow(
      'Status Trx',
      tx.status === 'completed' ? 'SUKSES' : tx.status === 'pending' ? 'PENDING' : 'GAGAL',
      RECEIPT_WIDTH
    )
  );
  if (tx.serialNumber) {
    lines.push(dashDivider);
    lines.push('SN / TOKEN:');
    lines.push(...wrapText(tx.serialNumber, RECEIPT_WIDTH));
  }
  lines.push(dashDivider);
  lines.push(...formatRow('Harga', formatPlainRp(tx.sellPrice), RECEIPT_WIDTH));
  lines.push(...formatRow('Biaya Admin', formatPlainRp(tx.adminFee), RECEIPT_WIDTH));
  const totalPpob = Number(tx.sellPrice) + Number(tx.adminFee);
  lines.push(...formatRow('TOTAL TAGIHAN', formatPlainRp(totalPpob), RECEIPT_WIDTH));

  const isDebt = tx.paymentStatus === 'debt' || (Number(tx.debtAmount) || 0) > 0;
  lines.push(...formatRow('Status Bayar', isDebt ? 'HUTANG (BON)' : 'LUNAS', RECEIPT_WIDTH));
  if (isDebt) {
    lines.push(...formatRow('Dibayar (DP)', formatPlainRp(Number(tx.paidAmount) || 0), RECEIPT_WIDTH));
    lines.push(
      ...formatRow(
        'Masuk Bon',
        formatPlainRp(Number(tx.debtAmount) || Math.max(0, totalPpob - (Number(tx.paidAmount) || 0))),
        RECEIPT_WIDTH
      )
    );
  }

  lines.push(eqDivider);
  lines.push(...centerLines(thankYou, RECEIPT_WIDTH));
  if (footerNote && footerNote !== thankYou) {
    lines.push(...centerLines(footerNote, RECEIPT_WIDTH));
  }
  return lines.join('\n');
}
