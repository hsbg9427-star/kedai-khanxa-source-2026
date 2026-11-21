import React, { useState } from 'react';
import {
  LayoutDashboard,
  Wallet,
  Users,
  Settings,
  LogOut,
  Wifi,
  WifiOff,
  RefreshCw,
  Menu,
  X,
  ShoppingCart,
  Package,
  BookUser,
  HandCoins,
  FileBarChart2,
  Landmark,
  Smartphone,
  Truck,
  ClipboardCheck,
  Calculator,
  Bell,
  AlertTriangle,
  CalendarClock,
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { PWAInstallButton } from './PWAInstallButton';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import { getRoleLabel, getTodayDateString } from '../utils/formatters';
import { canAccessNavTab, type NavTab } from '../utils/rbac';
import { formatShortIdDate, type UnifiedExpiryAlert } from '../utils/expiryUtils';
import { formatProductFullName } from '../utils/productIdentity';

export type { NavTab };

interface AppShellProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  storeName: string;
  expiryAlerts?: UnifiedExpiryAlert[];
  onOpenExpiryMonitoring?: () => void;
  children: React.ReactNode;
}

export function AppShell({
  activeTab,
  onSelectTab,
  storeName,
  expiryAlerts = [],
  onOpenExpiryMonitoring,
  children,
}: AppShellProps) {
  const { profile, user, isAdmin, signOutUser } = useAuth();
  const { isOnline, hasPendingSync, firestoreStatus, recheckConnection } = useNetwork();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const todayStr = getTodayDateString();
  const bannerDismissKey = `kk_expiry_banner_dismissed_${todayStr}`;
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(`kk_expiry_banner_dismissed_${getTodayDateString()}`) === '1';
    } catch {
      return false;
    }
  });

  const expiredAlertsCount = expiryAlerts.filter((a) => a.expiryStatus === 'EXPIRED').length;
  const nearAlertsCount = expiryAlerts.filter((a) => a.expiryStatus === 'MENDEKATI EXPIRED').length;

  const handleDismissBannerToday = () => {
    setBannerDismissed(true);
    try {
      window.localStorage.setItem(bannerDismissKey, '1');
    } catch {
      // ignore storage errors
    }
  };

  const handleJumpExpiryMonitoring = () => {
    setNotifOpen(false);
    if (onOpenExpiryMonitoring) {
      onOpenExpiryMonitoring();
    } else {
      onSelectTab('dashboard');
    }
  };

  const navItems: {
    id: NavTab;
    label: string;
    mobileLabel: string;
    icon: React.ComponentType<{ className?: string }>;
    adminOnly?: boolean;
  }[] = [
    { id: 'dashboard', label: 'Dashboard', mobileLabel: 'Dashboard', icon: LayoutDashboard },
    { id: 'pos', label: 'Kasir Retail', mobileLabel: 'Kasir', icon: ShoppingCart },
    { id: 'mini_atm', label: 'Mini ATM', mobileLabel: 'Mini ATM', icon: Landmark },
    { id: 'ppob', label: 'Transaksi PPOB', mobileLabel: 'PPOB', icon: Smartphone },
    { id: 'products', label: 'Produk & Stok', mobileLabel: 'Produk', icon: Package, adminOnly: true },
    { id: 'stock_opname', label: 'Stok Opname', mobileLabel: 'Opname', icon: ClipboardCheck, adminOnly: true },
    { id: 'purchases', label: 'Pembelian Barang', mobileLabel: 'Kulakan', icon: Truck, adminOnly: true },
    { id: 'customers', label: 'Pelanggan & Piutang', mobileLabel: 'Kasbon', icon: BookUser },
    { id: 'closing', label: 'Closing Kasir', mobileLabel: 'Closing', icon: Calculator },
    { id: 'loans', label: 'Pinjaman Uang', mobileLabel: 'Pinjaman', icon: HandCoins, adminOnly: true },
    { id: 'accounts', label: 'Kas & Rekening', mobileLabel: 'Kas', icon: Wallet, adminOnly: true },
    { id: 'reports', label: 'Laporan Keuangan', mobileLabel: 'Laporan', icon: FileBarChart2, adminOnly: true },
    { id: 'users', label: 'Pengguna & Akses', mobileLabel: 'Staf', icon: Users, adminOnly: true },
    { id: 'settings', label: 'Pengaturan', mobileLabel: 'Atur', icon: Settings, adminOnly: true },
  ];

  const visibleNavItems = navItems.filter((item) => canAccessNavTab(item.id, isAdmin));
  const mobileBottomItems = visibleNavItems.filter((item) =>
    isAdmin
      ? ['dashboard', 'pos', 'mini_atm', 'ppob', 'reports'].includes(item.id)
      : ['dashboard', 'pos', 'mini_atm', 'ppob', 'closing'].includes(item.id)
  );
  const currentTitle = visibleNavItems.find((i) => i.id === activeTab)?.label || 'Dashboard';

  const handleNavClick = (id: NavTab) => {
    onSelectTab(id);
    setMobileDrawerOpen(false);
  };

  const renderSyncStatus = () => {
    if (!isOnline || firestoreStatus === 'offline') {
      return (
        <button
          type="button"
          onClick={recheckConnection}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-800 whitespace-nowrap shrink-0 cursor-pointer"
          title="Perangkat offline — perubahan disimpan lokal dan akan disinkronkan saat online"
        >
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span>Offline (Lokal)</span>
        </button>
      );
    }
    if (hasPendingSync || firestoreStatus === 'checking') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap shrink-0">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
          <span>Menyinkronkan</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap shrink-0">
        <Wifi className="w-3.5 h-3.5 shrink-0" />
        <span>Tersinkronisasi</span>
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row">
      {/* Sidebar Desktop */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-30">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-slate-200">
          <BrandLogo size="sm" />
          <div className="min-w-0">
            <div className="font-display font-bold text-base tracking-tight text-slate-900 truncate">
              KEDAI KHANXA
            </div>
            <div className="text-xs text-slate-500 truncate">{storeName}</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1" aria-label="Menu Utama">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-emerald-50 text-emerald-800'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-emerald-700' : 'text-slate-500'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-2.5">
          <div className="text-xs text-slate-500 space-y-0.5">
            <div className="font-medium text-slate-900 truncate">
              {profile?.displayName || user?.displayName || 'Pengguna'}
            </div>
            <div className="truncate">
              {getRoleLabel(profile?.role || (isAdmin ? 'admin' : 'kasir'))}
              {profile?.shiftLabel ? ` · ${profile.shiftLabel}` : ''}
            </div>
          </div>
          <PWAInstallButton variant="full" showFallbackGuide />
          <button
            type="button"
            onClick={signOutUser}
            className="w-full min-h-[40px] flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Keluar Akun</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileDrawerOpen(false)}
          />
          <div className="relative w-72 max-w-[82vw] bg-white h-full border-r border-slate-200 flex flex-col z-10">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
              <div className="flex items-center gap-2.5 min-w-0">
                <BrandLogo size="sm" />
                <div className="font-display font-bold text-base text-slate-900 truncate">
                  KEDAI KHANXA
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                aria-label="Tutup Menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-1">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-emerald-50 text-emerald-800'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200 space-y-2.5">
              <div className="text-xs text-slate-500">
                <div className="font-medium text-slate-900 truncate">
                  {profile?.displayName || user?.displayName}
                </div>
                <div className="truncate">{profile?.email || user?.email}</div>
              </div>
              <PWAInstallButton variant="full" showFallbackGuide />
              <button
                type="button"
                onClick={signOutUser}
                className="w-full min-h-[44px] flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                <LogOut className="w-4 h-4" />
                <span>Keluar Akun</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Bar (3-zone contract, compact in short landscape) */}
        <header className="sticky top-0 z-20 h-14 [@media(orientation:landscape)_and_(max-height:500px)]:h-11 lg:h-16 bg-white border-b border-slate-200 px-3 sm:px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(true)}
              className="lg:hidden w-10 h-10 -ml-2 flex items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 shrink-0"
              aria-label="Buka Menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="font-display font-semibold text-base lg:text-lg text-slate-900 truncate">
              {currentTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3 text-xs text-slate-500 shrink-0">
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen((prev) => !prev)}
                aria-label={`Pemberitahuan Kedaluwarsa (${expiryAlerts.length})`}
                className={`relative w-9 h-9 rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${
                  expiredAlertsCount > 0
                    ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                    : nearAlertsCount > 0
                      ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Bell className="w-4 h-4" />
                {expiryAlerts.length > 0 && (
                  <span
                    className={`absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold font-mono-num text-white flex items-center justify-center ${
                      expiredAlertsCount > 0 ? 'bg-red-600' : 'bg-amber-600'
                    }`}
                  >
                    {expiryAlerts.length > 99 ? '99+' : expiryAlerts.length}
                  </span>
                )}
              </button>
            </div>
            <PWAInstallButton variant="compact" />
            <span className="hidden sm:inline truncate max-w-[180px]">{storeName}</span>
            <span className="hidden sm:inline" aria-hidden="true">·</span>
            {renderSyncStatus()}
          </div>
        </header>

        {/* Modal / Panel Pemberitahuan Kedaluwarsa (1 Bulan Sebelum Expired) */}
        {notifOpen && (
          <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-start justify-end p-3 sm:p-5 overflow-y-auto">
            <div
              className="fixed inset-0"
              onClick={() => setNotifOpen(false)}
              aria-hidden="true"
            />
            <div className="relative z-10 mt-12 sm:mt-14 w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-xl max-h-[82dvh] flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <CalendarClock className="w-4 h-4 text-emerald-700 shrink-0" />
                  <div className="min-w-0">
                    <h2 className="font-display font-semibold text-sm text-slate-900 truncate">
                      Pemberitahuan Kedaluwarsa
                    </h2>
                    <p className="text-[11px] text-slate-500 truncate">
                      Pengingat otomatis 1 bulan (30 hari) sebelum expired
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setNotifOpen(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
                  aria-label="Tutup Notifikasi"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {expiryAlerts.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500 space-y-1">
                    <div className="font-semibold text-slate-700">Semua produk &amp; stok aman</div>
                    <p>Tidak ada barang yang memasuki masa 1 bulan sebelum expired.</p>
                  </div>
                ) : (
                  expiryAlerts.map((alert) => {
                    const isExp = alert.expiryStatus === 'EXPIRED';
                    return (
                      <div
                        key={alert.id}
                        className={`p-3.5 space-y-1 ${isExp ? 'bg-red-50/40' : 'bg-amber-50/20'}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-xs font-semibold text-slate-900">
                            {formatProductFullName({
                              name: alert.productName,
                              brand: alert.productBrand,
                              variant: alert.productVariant,
                            })}
                          </div>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-mono-num shrink-0 ${
                              isExp ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'
                            }`}
                          >
                            {alert.expiryStatus}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono-num text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span>ED {formatShortIdDate(alert.effectiveExpiryDate)}</span>
                          <span>·</span>
                          <span className={isExp ? 'text-red-700 font-semibold' : 'text-amber-800 font-semibold'}>
                            {alert.remainingLabel}
                          </span>
                          {alert.batchNumber && (
                            <>
                              <span>·</span>
                              <span>{alert.batchNumber}</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="p-3 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-end gap-2">
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      setNotifOpen(false);
                      onSelectTab('products');
                    }}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    Kelola Produk
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleJumpExpiryMonitoring}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
                >
                  Lihat Monitoring Dashboard
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 p-3 sm:p-4 lg:p-8 pb-24 [@media(orientation:landscape)_and_(max-height:500px)]:pb-16 lg:pb-10 max-w-6xl w-full mx-auto">
          {expiryAlerts.length > 0 && !bannerDismissed && (
            <div
              className={`mb-4 rounded-xl border px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 text-xs ${
                expiredAlertsCount > 0
                  ? 'bg-red-50 border-red-200 text-red-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <div className="flex items-start sm:items-center gap-2 min-w-0">
                <AlertTriangle
                  className={`w-4 h-4 shrink-0 mt-0.5 sm:mt-0 ${
                    expiredAlertsCount > 0 ? 'text-red-700' : 'text-amber-700'
                  }`}
                />
                <div className="min-w-0">
                  <strong>Peringatan Masa Expired:</strong>{' '}
                  <span>
                    {expiredAlertsCount > 0 ? `${expiredAlertsCount} item sudah EXPIRED` : ''}
                    {expiredAlertsCount > 0 && nearAlertsCount > 0 ? ' · ' : ''}
                    {nearAlertsCount > 0
                      ? `${nearAlertsCount} item mendekati expired (≤ 1 bulan)`
                      : ''}
                    .
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleJumpExpiryMonitoring}
                  className={`min-h-[32px] px-2.5 py-1 rounded-lg bg-white border font-semibold cursor-pointer ${
                    expiredAlertsCount > 0
                      ? 'border-red-300 text-red-900 hover:bg-red-100'
                      : 'border-amber-300 text-amber-900 hover:bg-amber-100'
                  }`}
                >
                  Cek Daftar
                </button>
                <button
                  type="button"
                  onClick={handleDismissBannerToday}
                  className="w-7 h-7 rounded-lg flex items-center justify-center opacity-70 hover:opacity-100 cursor-pointer"
                  aria-label="Sembunyikan peringatan hari ini"
                  title="Sembunyikan hari ini"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
          {children}
        </main>

        {/* Bottom Navigation for Android Mobile (<= 64px height, compact in landscape) */}
        <nav
          className="lg:hidden fixed bottom-0 inset-x-0 h-16 [@media(orientation:landscape)_and_(max-height:500px)]:h-12 bg-white border-t border-slate-200 z-20 flex items-center justify-around px-1"
          aria-label="Navigasi Bawah"
        >
          {mobileBottomItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`flex-1 min-h-[40px] flex flex-col [@media(orientation:landscape)_and_(max-height:500px)]:flex-row items-center justify-center gap-1 [@media(orientation:landscape)_and_(max-height:500px)]:gap-1.5 px-1 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                  active ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate max-w-[78px]">{item.mobileLabel}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
