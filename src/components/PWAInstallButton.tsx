import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'compact' | 'full';
  showFallbackGuide?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'full',
  showFallbackGuide = false,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleTrigger = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuideModal(true);
  };

  const shouldRender = isInstallable || isIOS || showFallbackGuide;
  if (!shouldRender) {
    return null;
  }

  return (
    <>
      {variant === 'compact' ? (
        <button
          type="button"
          onClick={handleTrigger}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 transition-colors cursor-pointer shrink-0"
          title="Instal KEDAI KHANXA ke Layar Utama HP"
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          <span>Instal</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleTrigger}
          className={`w-full min-h-[42px] flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-medium transition-colors cursor-pointer ${
            isInstallable
              ? 'bg-emerald-700 text-white hover:bg-emerald-800'
              : 'border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
          }`}
        >
          {isInstallable ? (
            <Download className="w-4 h-4 shrink-0" />
          ) : (
            <Smartphone className="w-4 h-4 shrink-0" />
          )}
          <span>
            {isInstallable
              ? 'Instal Aplikasi ke HP'
              : isIOS
                ? 'Instal di iPhone / iPad'
                : 'Cara Pasang di Layar HP'}
          </span>
        </button>
      )}

      {showGuideModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setShowGuideModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white border border-slate-200 p-5 shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">
                  {isIOS ? 'Pasang di iPhone / iPad' : 'Pasang Aplikasi di HP Android'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Langsung muncul di layar utama tanpa file APK
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100"
                aria-label="Tutup panduan"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="text-xs sm:text-sm text-slate-700 space-y-2 list-decimal pl-4">
                <li>
                  Pastikan aplikasi dibuka lewat browser <strong>Safari</strong>.
                </li>
                <li>
                  Ketuk ikon <strong>Bagikan (Share)</strong> di bilah bawah Safari.
                </li>
                <li>
                  Pilih <strong>Tambahkan ke Layar Utama (Add to Home Screen)</strong>, lalu ketuk{' '}
                  <strong>Tambah</strong>.
                </li>
              </ol>
            ) : (
              <ol className="text-xs sm:text-sm text-slate-700 space-y-2 list-decimal pl-4">
                <li>
                  Pastikan Anda membuka link <strong>Shared App URL</strong> di browser{' '}
                  <strong>Google Chrome</strong> (bukan di dalam pratinjau aplikasi lain).
                </li>
                <li>
                  Ketuk menu titik tiga (<strong>⋮</strong>) di pojok kanan atas Chrome.
                </li>
                <li>
                  Pilih <strong>Instal aplikasi</strong> atau{' '}
                  <strong>Tambahkan ke layar utama</strong>.
                </li>
              </ol>
            )}

            <button
              type="button"
              onClick={() => setShowGuideModal(false)}
              className="w-full min-h-[40px] rounded-lg bg-slate-900 text-white text-xs sm:text-sm font-medium hover:bg-slate-800 cursor-pointer"
            >
              Mengerti
            </button>
          </div>
        </div>
      )}
    </>
  );
};
