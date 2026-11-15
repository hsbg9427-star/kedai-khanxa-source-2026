import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, googleProvider } from '../firebase';
import type { SystemBootstrapConfig, UserProfile } from '../types/database';
import {
  getReadableFirestoreError,
  handleFirestoreError,
  OperationType,
} from '../utils/firestoreError';

const BOOTSTRAP_ADMIN_EMAIL = 'hsbg9427@gmail.com';

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  authBusy: boolean;
  authError: string | null;
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  isKasir: boolean;
  isActiveStaff: boolean;
  primaryAdminUid: string | null;
  canBootstrapPrimaryAdmin: boolean;
  claimBusy: boolean;
  claimError: string | null;
  claimPrimaryAdmin: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  clearAuthError: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function fetchBootstrapDoc() {
  const bootstrapRef = doc(db, 'system_config', 'bootstrap');
  try {
    return await getDocFromServer(bootstrapRef);
  } catch {
    return await getDoc(bootstrapRef);
  }
}

async function ensureUserProfile(firebaseUser: User): Promise<void> {
  const userRef = doc(db, 'users', firebaseUser.uid);
  const bootstrapRef = doc(db, 'system_config', 'bootstrap');
  const email = (firebaseUser.email || '').trim().toLowerCase();
  const displayName = (firebaseUser.displayName || email.split('@')[0] || 'Pengguna').slice(0, 100);

  let snap;
  try {
    snap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
  }

  let bootstrapSnap;
  try {
    bootstrapSnap = await fetchBootstrapDoc();
  } catch {
    bootstrapSnap = null;
  }
  const bootstrapAlreadyExists = Boolean(bootstrapSnap && bootstrapSnap.exists());

  // Jika profil sudah terdaftar: pertahankan email asli dan cek apakah perlu mengunci bootstrap admin pertama
  if (snap.exists()) {
    const existingData = snap.data() as UserProfile;
    if (
      !bootstrapAlreadyExists &&
      existingData.role === 'admin' &&
      existingData.status === 'active'
    ) {
      try {
        const batch = writeBatch(db);
        batch.set(bootstrapRef, {
          primaryAdminUid: firebaseUser.uid,
          claimedAt: serverTimestamp(),
        });
        batch.update(userRef, {
          isPrimaryAdmin: true,
          shiftLabel: existingData.shiftLabel || 'Admin Utama',
          updatedAt: serverTimestamp(),
        });
        await batch.commit();
      } catch (error) {
        console.warn('Gagal menyegel kunci bootstrap admin:', error);
      }
    }
    return;
  }

  // Jika belum ada dokumen profil dan belum ada Admin Utama, akun pemilik utama otomatis ditetapkan
  if (
    !bootstrapAlreadyExists &&
    email === BOOTSTRAP_ADMIN_EMAIL &&
    firebaseUser.emailVerified
  ) {
    try {
      const batch = writeBatch(db);
      batch.set(userRef, {
        uid: firebaseUser.uid,
        email,
        displayName,
        ...(firebaseUser.photoURL ? { photoURL: firebaseUser.photoURL.slice(0, 500) } : {}),
        role: 'admin',
        status: 'active',
        isPrimaryAdmin: true,
        shiftLabel: 'Admin Utama',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(bootstrapRef, {
        primaryAdminUid: firebaseUser.uid,
        claimedAt: serverTimestamp(),
      });
      await batch.commit();
      return;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${firebaseUser.uid}`);
    }
  }

  // Cek undangan staf (staff_invites) yang cocok dengan email terdaftar
  try {
    const inviteQuery = query(
      collection(db, 'staff_invites'),
      where('email', '==', email),
      where('status', '==', 'pending')
    );
    const inviteSnap = await getDocs(inviteQuery);

    if (!inviteSnap.empty) {
      const inviteDoc = inviteSnap.docs[0];
      const inviteData = inviteDoc.data();
      const batch = writeBatch(db);
      batch.set(userRef, {
        uid: firebaseUser.uid,
        email,
        displayName: (inviteData.displayName || displayName).slice(0, 100),
        ...(firebaseUser.photoURL ? { photoURL: firebaseUser.photoURL.slice(0, 500) } : {}),
        role: inviteData.role === 'admin' ? 'admin' : 'kasir',
        status: 'active',
        ...(inviteData.shiftLabel ? { shiftLabel: String(inviteData.shiftLabel).slice(0, 40) } : {}),
        claimedInviteId: inviteDoc.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'staff_invites', inviteDoc.id), {
        status: 'claimed',
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      return;
    }
  } catch (error) {
    console.warn('Gagal memeriksa undangan staf, membuat profil pending:', error);
  }

  // Pengguna baru standar selalu berstatus pending (bukan otomatis admin)
  try {
    await setDoc(userRef, {
      uid: firebaseUser.uid,
      email,
      displayName,
      ...(firebaseUser.photoURL ? { photoURL: firebaseUser.photoURL.slice(0, 500) } : {}),
      role: 'pending',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `users/${firebaseUser.uid}`);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [bootstrapConfig, setBootstrapConfig] = useState<SystemBootstrapConfig | null>(null);
  const [bootstrapChecked, setBootstrapChecked] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState<boolean>(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;
    let unsubscribeBootstrap: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }
      if (unsubscribeBootstrap) {
        unsubscribeBootstrap();
        unsubscribeBootstrap = null;
      }

      if (!firebaseUser) {
        setUser(null);
        setProfile(null);
        setBootstrapConfig(null);
        setBootstrapChecked(false);
        setClaimError(null);
        setLoading(false);
        return;
      }

      setUser(firebaseUser);
      setLoading(true);
      setBootstrapChecked(false);
      setClaimError(null);

      try {
        await ensureUserProfile(firebaseUser);

        const bootstrapRef = doc(db, 'system_config', 'bootstrap');
        unsubscribeBootstrap = onSnapshot(
          bootstrapRef,
          (snap) => {
            setBootstrapConfig(snap.exists() ? (snap.data() as SystemBootstrapConfig) : null);
            setBootstrapChecked(true);
          },
          () => {
            setBootstrapChecked(true);
          }
        );

        const userRef = doc(db, 'users', firebaseUser.uid);
        unsubscribeProfile = onSnapshot(
          userRef,
          (snapshot) => {
            if (snapshot.exists()) {
              setProfile(snapshot.data() as UserProfile);
            } else {
              setProfile(null);
            }
            setLoading(false);
          },
          (error) => {
            setLoading(false);
            handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
          }
        );
      } catch (error) {
        setAuthError(
          error instanceof Error
            ? 'Gagal memuat profil pengguna dari server. Periksa koneksi dan aturan Firestore.'
            : 'Gagal memuat profil pengguna.'
        );
        setLoading(false);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
      if (unsubscribeBootstrap) unsubscribeBootstrap();
    };
  }, []);

  const claimPrimaryAdmin = useCallback(async () => {
    if (!user || !user.emailVerified) {
      setClaimError('Akun Google Anda harus terverifikasi sebelum diaktifkan.');
      return;
    }

    setClaimBusy(true);
    setClaimError(null);
    try {
      const latestBootstrap = await fetchBootstrapDoc();
      if (latestBootstrap.exists()) {
        setClaimError('Admin Utama sudah ditetapkan oleh akun lain.');
        return;
      }

      const batch = writeBatch(db);
      batch.set(doc(db, 'system_config', 'bootstrap'), {
        primaryAdminUid: user.uid,
        claimedAt: serverTimestamp(),
      });

      const userRef = doc(db, 'users', user.uid);
      if (profile) {
        // Memperbarui peran tanpa mengubah email yang sudah terdaftar
        batch.update(userRef, {
          role: 'admin',
          status: 'active',
          isPrimaryAdmin: true,
          shiftLabel: 'Admin Utama',
          updatedAt: serverTimestamp(),
        });
      } else {
        const email = (user.email || '').trim().toLowerCase();
        const displayName = (user.displayName || email.split('@')[0] || 'Admin Utama').slice(0, 100);
        batch.set(userRef, {
          uid: user.uid,
          email,
          displayName,
          ...(user.photoURL ? { photoURL: user.photoURL.slice(0, 500) } : {}),
          role: 'admin',
          status: 'active',
          isPrimaryAdmin: true,
          shiftLabel: 'Admin Utama',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    } catch (error) {
      setClaimError(getReadableFirestoreError(error));
    } finally {
      setClaimBusy(false);
    }
  }, [user, profile]);

  const signInWithGoogle = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user') {
        setAuthError('Jendela login ditutup sebelum selesai.');
      } else if (code === 'auth/popup-blocked') {
        setAuthError('Pop-up login diblokir oleh browser. Izinkan pop-up untuk melanjutkan.');
      } else if (code === 'auth/network-request-failed') {
        setAuthError('Tidak ada koneksi internet untuk melakukan login pertama kali.');
      } else {
        setAuthError('Gagal masuk menggunakan akun Google. Silakan coba kembali.');
      }
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    setAuthBusy(true);
    try {
      await signOut(auth);
      setProfile(null);
      setBootstrapConfig(null);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const primaryAdminUid = bootstrapConfig?.primaryAdminUid || null;
  const isPrimaryAdmin = Boolean(
    user &&
      ((primaryAdminUid && primaryAdminUid === user.uid) ||
        profile?.isPrimaryAdmin ||
        (!bootstrapConfig &&
          user.email?.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL &&
          user.emailVerified))
  );
  const isAdmin =
    isPrimaryAdmin ||
    Boolean(profile && profile.role === 'admin' && profile.status === 'active');
  const isKasir = Boolean(profile && profile.role === 'kasir' && profile.status === 'active');
  const isActiveStaff = isAdmin || isKasir;
  const canBootstrapPrimaryAdmin = Boolean(
    user &&
      user.emailVerified &&
      bootstrapChecked &&
      !bootstrapConfig &&
      profile?.role === 'pending'
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        authBusy,
        authError,
        isAdmin,
        isPrimaryAdmin,
        isKasir,
        isActiveStaff,
        primaryAdminUid,
        canBootstrapPrimaryAdmin,
        claimBusy,
        claimError,
        claimPrimaryAdmin,
        signInWithGoogle,
        signOutUser,
        clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth harus digunakan di dalam AuthProvider');
  }
  return ctx;
}
