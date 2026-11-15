import type { TransactionMetadata } from '../types/database';

export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function formatQty(qty: number): string {
  const clean = Number.isFinite(qty) ? Number(Number(qty).toFixed(4)) : 0;
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(Object.is(clean, -0) ? 0 : clean);
}

export function getTodayDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getCurrentTimeString(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function formatIndonesianDate(dateStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(dateObj);
}

export function generateSafeId(prefix: string): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'doc';
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${cleanPrefix}_${Date.now()}_${rand}`;
}

export function createTransactionMetadata(
  prefix: string,
  user: { uid: string; displayName: string }
): TransactionMetadata {
  const now = new Date();
  const dateStr = getTodayDateString(now);
  const timeStr = getCurrentTimeString(now);
  const compactDate = dateStr.replace(/-/g, '');
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return {
    transactionNumber: `${prefix}-${compactDate}-${suffix}`,
    transactionDate: dateStr,
    transactionTime: timeStr,
    recordedByUid: user.uid,
    recordedByName: user.displayName.trim().slice(0, 100) || 'Pengguna',
  };
}

export function getAccountTypeLabel(type: string): string {
  switch (type) {
    case 'cash':
      return 'Kas Tunai / Laci';
    case 'bank':
      return 'Rekening Bank';
    case 'ewallet':
      return 'Dompet Digital (E-Wallet)';
    case 'ppob_deposit':
      return 'Deposit Server PPOB';
    default:
      return type;
  }
}

export function getRoleLabel(role: string): string {
  switch (role) {
    case 'admin':
      return 'Admin / Pemilik';
    case 'kasir':
      return 'Kasir';
    case 'pending':
      return 'Menunggu Aktivasi';
    default:
      return role;
  }
}
