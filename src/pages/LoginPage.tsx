import React, { useState } from 'react';
import { ShieldCheck, UserCheck, Wifi, WifiOff, ArrowRight } from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { useAuth } from '../contexts/AuthContext';
import { useNetwork } from '../contexts/NetworkContext';

export function LoginPage() {
  const { signInWithGoogle, authBusy, authError, clearAuthError } = useAuth();
  const { isOnline } = useNetwork();
  const [selectedRoleGuide, setSelectedRoleGuide] = useState<'admin' | 'kasir'>('admin');

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl w-full mx-auto bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">
        {/* Left Informational Panel */}
        <div className="lg:col-span-6 bg-slate-900 text-white p-7 sm:p-10 flex flex-col justify-between gap-8">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-3">
              <BrandLogo size="md" />
              <span className="font-display font-bold text-xl tracking-tight">KEDAI KHANXA</span>
            </div>

            <div className="space-y-3">
              <h1 className="font-display text-2xl sm:text-3xl font-bold leading-tight text-balance">
                Kelola Mini Retail, Mini ATM, dan PPOB dalam Satu Sistem
              </h1>
              <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
                Dirancang untuk HP Android kasir dan komputer pemilik. Data tersinkronisasi
                otomatis antarperangkat melalui Cloud Firestore dan tetap bisa mencatat saat
                internet terputus.
              </p>
            </div>
          </div>

          <div className="space-y-4 pt-6 border-t border-slate-800 text-xs sm:text-sm text-slate-300">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>Hak akses terpisah antara Admin (Pemilik) dan Kasir operasional.</span>
            </div>
            <div className="flex items-start gap-3">
              <UserCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>Setiap transaksi mencatat tanggal, jam, nomor transaksi, dan nama petugas.</span>
            </div>
          </div>
        </div>

        {/* Right Sign-In Panel */}
        <div className="lg:col-span-6 p-7 sm:p-10 flex flex-col justify-center space-y-6">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-xl font-bold text-slate-900">
                KEDAI KHANXA — Masuk Aplikasi
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                  isOnline ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                <span>{isOnline ? 'Online' : 'Offline'}</span>
              </span>
            </div>
            <p className="text-sm text-slate-600">
              Pilih peran panduan Anda lalu masuk menggunakan akun Google terverifikasi.
            </p>
          </div>

          {/* Role Mode Info Switch */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => {
                setSelectedRoleGuide('admin');
                clearAuthError();
              }}
              className={`min-h-[40px] px-3 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors cursor-pointer ${
                selectedRoleGuide === 'admin'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Masuk Admin
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedRoleGuide('kasir');
                clearAuthError();
              }}
              className={`min-h-[40px] px-3 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors cursor-pointer ${
                selectedRoleGuide === 'kasir'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Masuk Kasir
            </button>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs sm:text-sm text-slate-600 leading-relaxed">
            {selectedRoleGuide === 'admin' ? (
              <span>
                <strong>Akses Admin:</strong> Mengelola produk, stok, saldo kas &amp; rekening,
                laporan keuangan, serta mengundang atau mengaktifkan akun Kasir.
              </span>
            ) : (
              <span>
                <strong>Akses Kasir:</strong> Gunakan akun Google yang sudah didaftarkan oleh Admin
                di menu <em>Pengguna &amp; Akses</em> agar langsung masuk ke mode Kasir.
              </span>
            )}
          </div>

          {authError && (
            <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700">
              {authError}
            </div>
          )}

          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={authBusy || !isOnline}
            className="w-full min-h-[48px] inline-flex items-center justify-center gap-3 px-5 py-3 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <span>{authBusy ? 'Memproses Login...' : 'Masuk dengan Google'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          {!isOnline && (
            <p className="text-xs text-amber-700 text-center">
              Login pertama kali memerlukan koneksi internet. Setelah masuk, aplikasi dapat dipakai
              secara offline.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
