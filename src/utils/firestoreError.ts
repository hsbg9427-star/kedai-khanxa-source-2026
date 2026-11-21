import { auth } from '../firebase';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function getReadableFirestoreError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('Quota exceeded')) {
    return 'Kuota harian Firestore tercapai. Kuota akan direset keesokan harinya.';
  }
  if (raw.includes('Missing or insufficient permissions') || raw.includes('permission-denied')) {
    return 'Akses ditolak oleh aturan keamanan Firestore. Pastikan peran akun Anda sesuai.';
  }
  if (raw.includes('the client is offline')) {
    return 'Perangkat sedang offline. Data akan disimpan lokal dan disinkronkan saat online.';
  }
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Partial<FirestoreErrorInfo>;
      if (parsed && typeof parsed.error === 'string') {
        if (parsed.error.includes('Missing or insufficient permissions')) {
          return 'Akses ditolak oleh aturan keamanan Firestore. Pastikan peran akun Anda sesuai.';
        }
        return 'Terjadi kendala saat memproses data ke server. Silakan coba lagi.';
      }
    } catch {
      // Abaikan kegagalan parse JSON
    }
  }
  if (error instanceof Error && raw.trim() && !raw.includes('FirebaseError:')) {
    return raw;
  }
  return 'Terjadi kendala saat memproses data ke server. Silakan coba lagi.';
}
