import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

function createFirestoreInstance(): { db: Firestore; offlinePersistenceEnabled: boolean } {
  try {
    const firestoreDb = initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
        experimentalForceLongPolling: true,
      },
      firebaseConfig.firestoreDatabaseId
    );
    return { db: firestoreDb, offlinePersistenceEnabled: true };
  } catch (error) {
    console.warn('Persistent local cache tidak tersedia, beralih ke cache memori:', error);
    try {
      const fallbackDb = initializeFirestore(
        app,
        {
          localCache: memoryLocalCache(),
          experimentalForceLongPolling: true,
        },
        firebaseConfig.firestoreDatabaseId
      );
      return { db: fallbackDb, offlinePersistenceEnabled: false };
    } catch {
      return {
        db: getFirestore(app, firebaseConfig.firestoreDatabaseId),
        offlinePersistenceEnabled: false,
      };
    }
  }
}

const { db, offlinePersistenceEnabled } = createFirestoreInstance();

export { app, db, offlinePersistenceEnabled };
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const firebaseProjectInfo = {
  projectId: firebaseConfig.projectId,
  databaseId: firebaseConfig.firestoreDatabaseId,
  authDomain: firebaseConfig.authDomain,
};

function isOfflineOrUnavailableError(error: unknown): boolean {
  const code = (error as { code?: string })?.code || '';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    code === 'unavailable' ||
    message.includes('the client is offline') ||
    message.includes('unavailable') ||
    message.includes('network')
  );
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as { code?: string })?.code || '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'permission-denied' ||
    message.includes('Missing or insufficient permissions') ||
    message.includes('permission-denied')
  );
}

export async function testFirestoreConnection(): Promise<'connected' | 'offline' | 'error'> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'offline';
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      return 'connected';
    } catch (error) {
      // Permission denied pada /test/connection menandakan server Firestore berhasil dijangkau.
      if (isPermissionDeniedError(error)) {
        return 'connected';
      }
      if (isOfflineOrUnavailableError(error)) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }
        console.warn('Koneksi Firestore sedang offline atau tidak stabil. Beroperasi dalam mode lokal.');
        return 'offline';
      }
      return 'error';
    }
  }

  return 'offline';
}
