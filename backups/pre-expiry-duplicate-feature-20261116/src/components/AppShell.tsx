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
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';
import { getRoleLabel } from '../utils/formatters';

export type NavTab =
  | 'dashboard'
  | 'pos'
  | 'mini_atm'
  | 'ppob'
  | 'products'
  | 'stock_opname'
  | 'purchases'
  | 'customers'
  | 'loans'
  | 'accounts'
  | 'reports'
  | 'users'
  | 'settings';

interface AppShellProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  storeName: string;
  children: React.ReactNode;
}

export function AppShell({ activeTab, onSelectTab, storeName, children }: AppShellProps) {
  const { profile, user, isAdmin, signOutUser } = useAuth();
  const { isOnline, hasPendingSync, firestoreStatus, recheckConnection } = useNetwork();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

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
    { id: 'products', label: 'Produk & Stok', mobileLabel: 'Produk', icon: Package },
    { id: 'stock_opname', label: 'Stok Opname', mobileLabel: 'Opname', icon: ClipboardCheck },
    { id: 'purchases', label: 'Pembelian Barang', mobileLabel: 'Kulakan', icon: Truck, adminOnly: true },
    { id: 'customers', label: 'Pelanggan & Piutang', mobileLabel: 'Kasbon', icon: BookUser },
    { id: 'loans', label: 'Pinjaman Uang', mobileLabel: 'Pinjaman', icon: HandCoins, adminOnly: true },
    { id: 'accounts', label: 'Kas & Rekening', mobileLabel: 'Kas', icon: Wallet, adminOnly: true },
    { id: 'reports', label: 'Laporan Keuangan', mobileLabel: 'Laporan', icon: FileBarChart2, adminOnly: true },
    { id: 'users', label: 'Pengguna & Akses', mobileLabel: 'Staf', icon: Users, adminOnly: true },
    { id: 'settings', label: 'Pengaturan', mobileLabel: 'Atur', icon: Settings },
  ];

  const visibleNavItems = navItems.filter((item) => !item.adminOnly || isAdmin);
  const mobileBottomItems = visibleNavItems.filter((item) =>
    isAdmin
      ? ['dashboard', 'pos', 'mini_atm', 'ppob', 'reports'].includes(item.id)
      : ['dashboard', 'pos', 'mini_atm', 'ppob', 'products'].includes(item.id)
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

        <nav className="flex-1 p-3 space-y-1" aria-label="Menu Utama">
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

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="text-xs text-slate-500 space-y-0.5">
            <div className="font-medium text-slate-900 truncate">
              {profile?.displayName || user?.displayName || 'Pengguna'}
            </div>
            <div className="truncate">
              {getRoleLabel(profile?.role || (isAdmin ? 'admin' : 'kasir'))}
              {profile?.shiftLabel ? ` · ${profile.shiftLabel}` : ''}
            </div>
          </div>
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
            <nav className="flex-1 p-3 space-y-1">
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
            <div className="p-4 border-t border-slate-200 space-y-3">
              <div className="text-xs text-slate-500">
                <div className="font-medium text-slate-900 truncate">
                  {profile?.displayName || user?.displayName}
                </div>
                <div className="truncate">{profile?.email || user?.email}</div>
              </div>
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
        {/* Top Bar (3-zone contract, <=56px on mobile) */}
        <header className="sticky top-0 z-20 h-14 lg:h-16 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-4">
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

          <div className="flex items-center gap-4 text-xs text-slate-500 shrink-0">
            <span className="hidden sm:inline truncate max-w-[180px]">{storeName}</span>
            <span className="hidden sm:inline" aria-hidden="true">·</span>
            {renderSyncStatus()}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-4 lg:p-8 pb-24 lg:pb-10 max-w-6xl w-full mx-auto">
          {children}
        </main>

        {/* Bottom Navigation for Android Mobile (<= 64px height) */}
        <nav
          className="lg:hidden fixed bottom-0 inset-x-0 h-16 bg-white border-t border-slate-200 z-20 flex items-center justify-around px-1"
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
                className={`flex-1 min-h-[44px] flex flex-col items-center justify-center gap-1 px-1 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
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
