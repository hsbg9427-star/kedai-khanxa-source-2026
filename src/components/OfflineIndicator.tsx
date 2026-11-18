import React from 'react';
import { WifiOff } from 'lucide-react';
import { useNetwork } from '../contexts/NetworkContext';

export const OfflineIndicator: React.FC = () => {
  const { isOnline } = useNetwork();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-20 lg:bottom-5 left-4 right-4 sm:right-auto z-40 inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-lg"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Mode Offline — Transaksi disimpan lokal &amp; otomatis sinkron saat online.</span>
    </div>
  );
};
