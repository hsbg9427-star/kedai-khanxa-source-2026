import React from 'react';
import { Clock, ShieldAlert, ShieldCheck, LogOut, ArrowRight } from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { useAuth } from '../contexts/AuthContext';

export function PendingAccessPage() {
  const {
    profile,
    user,
    canBootstrapPrimaryAdmin,
    claimPrimaryAdmin,
    claimBusy,
    claimError,
    signOutUser,
  } = useAuth();
  const isInactive = profile?.status === 'inactive';

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-lg w-full bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
        <div className="flex items-center gap-3">
          <BrandLogo size="md" />
          <div>
            <div className="font-display font-bold text-base text-slate-900">KEDAI KHANXA</div>
            <div className="text-xs text-slate-500">
              {canBootstrapPrimaryAdmin
                ? 'Aktivasi Admin Utama Pertama'
                : 'Verifikasi Hak Akses Pengguna'}
            </div>
          </div>
        </div>

        {canBootstrapPrimaryAdmin ? (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
                <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
                <span>Belum Ada Admin Utama Terdaftar</span>
              </div>
              <p className="text-sm text-emerald-900/80 leading-relaxed">
                Sebagai akun Google pertama yang masuk ke KEDAI KHANXA, Anda dapat menetapkan akun
                ini sebagai <strong>Admin Utama</strong> dengan akses penuh untuk mengelola usaha
                serta mengaktifkan akun kasir.
              </p>
            </div>

            {claimError && (
              <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700">
                {claimError}
              </div>
            )}

            <button
              type="button"
              onClick={claimPrimaryAdmin}
              disabled={claimBusy}
              className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <span>
                {claimBusy
                  ? 'Mengaktifkan Admin Utama...'
                  : 'Aktifkan sebagai Admin Utama & Buka Dashboard'}
              </span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              {isInactive ? (
                <ShieldAlert className="w-4 h-4 text-red-600 shrink-0" />
              ) : (
                <Clock className="w-4 h-4 text-amber-600 shrink-0" />
              )}
              <span>
                {isInactive ? 'Akun Anda Sedang Dinonaktifkan' : 'Akun Menunggu Aktivasi Admin'}
              </span>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              {isInactive
                ? 'Admin Utama KEDAI KHANXA menonaktifkan akses akun ini. Hubungi pemilik apabila Anda memerlukan akses kembali.'
                : 'Akun Google Anda berhasil terdaftar dengan email di bawah ini. Minta Admin Utama KEDAI KHANXA untuk mengaktifkan peran Anda sebagai Kasir atau Admin di menu Pengguna & Akses. Halaman ini akan terbuka otomatis setelah diaktifkan.'}
            </p>
          </div>
        )}

        <div className="text-xs text-slate-500 space-y-1 border-t border-slate-100 pt-4">
          <div>
            Nama:{' '}
            <span className="font-medium text-slate-800">
              {profile?.displayName || user?.displayName}
            </span>
          </div>
          <div>
            Email Terdaftar:{' '}
            <span className="font-medium text-slate-800">{profile?.email || user?.email}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={signOutUser}
          disabled={claimBusy}
          className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Keluar &amp; Ganti Akun</span>
        </button>
      </div>
    </div>
  );
}
