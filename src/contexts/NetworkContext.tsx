import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { onSnapshotsInSync } from 'firebase/firestore';
import { db, offlinePersistenceEnabled, testFirestoreConnection } from '../firebase';

interface NetworkContextValue {
  isOnline: boolean;
  firestoreStatus: 'checking' | 'connected' | 'offline' | 'error';
  hasPendingSync: boolean;
  offlinePersistenceEnabled: boolean;
  lastSyncedAt: Date | null;
  markPendingWrite: (pending: boolean) => void;
  recheckConnection: () => Promise<void>;
}

export const NetworkContext = createContext<NetworkContextValue | undefined>(undefined);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [firestoreStatus, setFirestoreStatus] = useState<
    'checking' | 'connected' | 'offline' | 'error'
  >('checking');
  const [hasPendingSync, setHasPendingSync] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const recheckConnection = useCallback(async () => {
    setFirestoreStatus('checking');
    const status = await testFirestoreConnection();
    setFirestoreStatus(status);
    if (status === 'connected') {
      setLastSyncedAt(new Date());
    }
  }, []);

  useEffect(() => {
    recheckConnection();

    const handleOnline = () => {
      setIsOnline(true);
      recheckConnection();
    };
    const handleOffline = () => {
      setIsOnline(false);
      setFirestoreStatus('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const unsubscribeSync = onSnapshotsInSync(db, () => {
      setHasPendingSync(false);
      if (navigator.onLine) {
        setLastSyncedAt(new Date());
      }
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsubscribeSync();
    };
  }, [recheckConnection]);

  const markPendingWrite = useCallback((pending: boolean) => {
    setHasPendingSync(pending);
  }, []);

  return (
    <NetworkContext.Provider
      value={{
        isOnline,
        firestoreStatus,
        hasPendingSync,
        offlinePersistenceEnabled,
        lastSyncedAt,
        markPendingWrite,
        recheckConnection,
      }}
    >
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) {
    throw new Error('useNetwork harus digunakan di dalam NetworkProvider');
  }
  return ctx;
}
