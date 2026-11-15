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
      },
      firebaseConfig.firestoreDatabaseId
    );
    return { db: firestoreDb, offlinePersistenceEnabled: true };
  } catch (error) {
    console.warn('Persistent local cache tidak tersedia, beralih ke cache memori:', error);
    try {
      const fallbackDb = initializeFirestore(
        app,
        { localCache: memoryLocalCache() },
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

export async function testFirestoreConnection(): Promise<'connected' | 'offline' | 'error'> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return 'connected';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('the client is offline')) {
      console.error('Koneksi Firestore offline. Periksa konfigurasi Firebase.');
      return 'offline';
    }
    // Permission denied pada /test/connection menandakan server Firestore berhasil dijangkau.
    if (message.includes('Missing or insufficient permissions') || message.includes('permission-denied')) {
      return 'connected';
    }
    return 'error';
  }
}
