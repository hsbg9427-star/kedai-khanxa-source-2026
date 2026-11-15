import React, { useEffect, useId, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { X, ScanBarcode, AlertCircle } from 'lucide-react';

interface BarcodeScannerModalProps {
  title?: string;
  onDetected: (code: string) => void;
  onClose: () => void;
}

export function BarcodeScannerModal({
  title = 'Scan Barcode Produk',
  onDetected,
  onClose,
}: BarcodeScannerModalProps) {
  const reactId = useId().replace(/:/g, '');
  const readerElementId = `barcode-reader-${reactId}`;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const detectedOnceRef = useRef(false);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [manualCode, setManualCode] = useState('');

  useEffect(() => {
    let active = true;
    const scanner = new Html5Qrcode(readerElementId, {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.QR_CODE,
      ],
      verbose: false,
    });
    scannerRef.current = scanner;

    const startCamera = async () => {
      try {
        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 260, height: 150 },
            aspectRatio: 1.333,
          },
          (decodedText) => {
            if (!active || detectedOnceRef.current) return;
            detectedOnceRef.current = true;
            const cleaned = decodedText.trim();
            scanner
              .stop()
              .then(() => scanner.clear())
              .catch(() => {})
              .finally(() => {
                onDetected(cleaned);
              });
          },
          () => {
            // Abaikan error per-frame saat mencari barcode
          }
        );
        if (active) setStarting(false);
      } catch (err) {
        if (!active) return;
        setStarting(false);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('notallowed')) {
          setCameraError(
            'Izin kamera ditolak. Izinkan akses kamera di browser HP/komputer atau masukkan kode barcode secara manual di bawah.'
          );
        } else {
          setCameraError(
            'Kamera tidak ditemukan atau sedang dipakai aplikasi lain. Anda tetap dapat memasukkan kode barcode secara manual.'
          );
        }
      }
    };

    startCamera();

    return () => {
      active = false;
      const current = scannerRef.current;
      if (current) {
        if (current.isScanning) {
          current
            .stop()
            .then(() => current.clear())
            .catch(() => {});
        } else {
          try {
            current.clear();
          } catch {
            // noop
          }
        }
      }
    };
  }, [readerElementId, onDetected]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    onDetected(manualCode.trim());
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ScanBarcode className="w-5 h-5 text-emerald-700" />
            <h3 className="font-display font-semibold text-base text-slate-900">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 cursor-pointer"
            aria-label="Tutup Pemindai"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {cameraError ? (
            <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-800 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{cameraError}</span>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative rounded-lg overflow-hidden bg-slate-950 min-h-[220px] flex items-center justify-center">
                <div id={readerElementId} className="w-full" />
                {starting && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-300 bg-slate-950">
                    Menyalakan kamera belakang...
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500 text-center">
                Arahkan barcode kemasan barang ke dalam kotak pemindai.
              </p>
            </div>
          )}

          <form onSubmit={handleManualSubmit} className="pt-2 border-t border-slate-100 space-y-2">
            <label htmlFor="manual-barcode" className="block text-xs font-medium text-slate-700">
              Atau Ketik / Tempel Kode Barcode Manual
            </label>
            <div className="flex gap-2">
              <input
                id="manual-barcode"
                type="text"
                maxLength={64}
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="Contoh: 8991002101014"
                className="flex-1 min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
              <button
                type="submit"
                className="min-h-[44px] px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Gunakan
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
