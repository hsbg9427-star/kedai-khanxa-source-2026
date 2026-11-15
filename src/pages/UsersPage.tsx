import React, { useEffect, useState } from 'react';
import { UserPlus, Trash2, Check, Shield, Crown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import type { StaffInvite, UserProfile, UserRole, UserStatus } from '../types/database';
import {
  createStaffInvite,
  deleteStaffInvite,
  subscribeStaffInvites,
  subscribeUsers,
  updateUserAccess,
} from '../services/warungService';
import { getRoleLabel } from '../utils/formatters';
import { getReadableFirestoreError } from '../utils/firestoreError';

type UserFilter = 'all' | 'pending' | 'active' | 'inactive';

export function UsersPage() {
  const { user, isAdmin, primaryAdminUid } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [invites, setInvites] = useState<StaffInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<UserFilter>('all');
  const [shiftDrafts, setShiftDrafts] = useState<Record<string, string>>({});
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Form Undang Staf
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'kasir' | 'admin'>('kasir');
  const [inviteShift, setInviteShift] = useState('Shift Pagi');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    const unsubUsers = subscribeUsers(
      (list) => {
        setUsers(list);
        setShiftDrafts((prev) => {
          const next = { ...prev };
          list.forEach((u) => {
            if (next[u.uid] === undefined) {
              next[u.uid] = u.shiftLabel || '';
            }
          });
          return next;
        });
        setLoading(false);
      },
      (err) => {
        setFeedback({ kind: 'err', text: getReadableFirestoreError(err) });
        setLoading(false);
      }
    );
    const unsubInvites = subscribeStaffInvites(
      (list) => setInvites(list),
      (err) => setFeedback({ kind: 'err', text: getReadableFirestoreError(err) })
    );

    return () => {
      unsubUsers();
      unsubInvites();
    };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
        <Shield className="w-8 h-8 text-slate-400 mx-auto" />
        <h2 className="font-display font-semibold text-base text-slate-900">
          Halaman Khusus Admin
        </h2>
        <p className="text-sm text-slate-600">
          Hanya Admin Utama atau Admin aktif yang dapat mengatur hak akses staf KEDAI KHANXA.
        </p>
      </div>
    );
  }

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!inviteEmail.trim() || !inviteName.trim()) {
      setFeedback({ kind: 'err', text: 'Email Google dan nama staf wajib diisi.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      await createStaffInvite(
        {
          email: inviteEmail,
          displayName: inviteName,
          role: inviteRole,
          shiftLabel: inviteShift,
        },
        user.uid
      );
      setInviteEmail('');
      setInviteName('');
      setInviteRole('kasir');
      setInviteShift('Shift Pagi');
      setFeedback({
        kind: 'ok',
        text: 'Undangan staf berhasil disimpan. Ketika staf masuk memakai email Google tersebut, aksesnya aktif otomatis.',
      });
    } catch (error) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleStatusChange = async (
    targetUid: string,
    role: UserRole,
    status: UserStatus,
    shiftLabel?: string
  ) => {
    setBusyUid(targetUid);
    setFeedback(null);
    try {
      await updateUserAccess(targetUid, { role, status, shiftLabel });
      setFeedback({
        kind: 'ok',
        text: 'Hak akses dan status akun berhasil diperbarui tanpa mengubah email terdaftar.',
      });
    } catch (error) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
    } finally {
      setBusyUid(null);
    }
  };

  const handleDeleteInvite = async (id: string) => {
    try {
      await deleteStaffInvite(id);
      setFeedback({ kind: 'ok', text: 'Undangan staf dihapus.' });
    } catch (error) {
      setFeedback({ kind: 'err', text: getReadableFirestoreError(error) });
    }
  };

  const pendingCount = users.filter((u) => u.status === 'pending').length;
  const filteredUsers = users.filter((u) => {
    if (filter === 'all') return true;
    return u.status === filter;
  });

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`p-4 rounded-xl border text-sm ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Form Prapendaftaran Staf */}
      <form
        onSubmit={handleCreateInvite}
        className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
      >
        <div className="flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-emerald-700" />
          <h3 className="font-display font-semibold text-base text-slate-900">
            Daftarkan Akun Kasir atau Admin Tambahan
          </h3>
        </div>
        <p className="text-xs text-slate-600">
          Masukkan alamat email Google staf KEDAI KHANXA. Pengguna baru yang belum diundang tidak
          otomatis menjadi admin dan akan masuk daftar tunggu aktivasi terlebih dahulu.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1">
            <label htmlFor="inv-email" className="block text-xs font-medium text-slate-700">
              Email Google
            </label>
            <input
              id="inv-email"
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="kasir@gmail.com"
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="inv-name" className="block text-xs font-medium text-slate-700">
              Nama Lengkap
            </label>
            <input
              id="inv-name"
              type="text"
              required
              maxLength={100}
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              placeholder="Nama Petugas"
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="inv-role" className="block text-xs font-medium text-slate-700">
              Peran Akses
            </label>
            <select
              id="inv-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'kasir' | 'admin')}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              <option value="kasir">Kasir</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="inv-shift" className="block text-xs font-medium text-slate-700">
              Label Shift
            </label>
            <input
              id="inv-shift"
              type="text"
              maxLength={40}
              value={inviteShift}
              onChange={(e) => setInviteShift(e.target.value)}
              placeholder="Shift Pagi"
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
          >
            <Check className="w-4 h-4" />
            <span>{submitting ? 'Menyimpan...' : 'Simpan Undangan Staf'}</span>
          </button>
        </div>
      </form>

      {/* Daftar Pengguna Terdaftar */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="font-display font-semibold text-base text-slate-900">
              Pengguna Terdaftar ({users.length})
            </h3>
            <p className="text-xs text-slate-500">
              Email akun terdaftar bersifat tetap dan tidak diubah saat pengaturan peran.
            </p>
          </div>

          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
            {(
              [
                { id: 'all', label: 'Semua' },
                { id: 'pending', label: `Menunggu (${pendingCount})` },
                { id: 'active', label: 'Aktif' },
                { id: 'inactive', label: 'Nonaktif' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filter === tab.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="p-5 space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Tidak ada pengguna pada kategori filter ini.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-5">Pengguna</th>
                  <th className="py-3 px-5 whitespace-nowrap">Peran</th>
                  <th className="py-3 px-5 whitespace-nowrap">Shift</th>
                  <th className="py-3 px-5 whitespace-nowrap">Status</th>
                  <th className="py-3 px-5 text-right whitespace-nowrap">Pengaturan Akses</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredUsers.map((u) => {
                  const isSelf = u.uid === user?.uid;
                  const isPrimary = Boolean(
                    u.isPrimaryAdmin || (primaryAdminUid && u.uid === primaryAdminUid)
                  );
                  const currentShift = shiftDrafts[u.uid] ?? u.shiftLabel ?? '';
                  const isBusy = busyUid === u.uid;

                  return (
                    <tr key={u.uid} className="hover:bg-slate-50">
                      <td className="py-3.5 px-5">
                        <div className="font-medium text-slate-900 flex items-center gap-1.5">
                          <span>{u.displayName}</span>
                          {isSelf && <span className="text-xs text-slate-400">(Anda)</span>}
                          {isPrimary && (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                              <Crown className="w-3.5 h-3.5" />
                              <span>Utama</span>
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500">{u.email}</div>
                      </td>
                      <td className="py-3.5 px-5 whitespace-nowrap">
                        <span className="text-xs font-medium text-slate-800">
                          {isPrimary ? 'Admin Utama' : getRoleLabel(u.role)}
                        </span>
                      </td>
                      <td className="py-3.5 px-5 whitespace-nowrap">
                        {isPrimary || isSelf ? (
                          <span className="text-xs text-slate-600">{u.shiftLabel || 'Admin Utama'}</span>
                        ) : (
                          <input
                            type="text"
                            maxLength={40}
                            value={currentShift}
                            onChange={(e) =>
                              setShiftDrafts((prev) => ({ ...prev, [u.uid]: e.target.value }))
                            }
                            placeholder="Shift Kasir"
                            aria-label={`Shift untuk ${u.displayName}`}
                            className="w-32 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-600"
                          />
                        )}
                      </td>
                      <td className="py-3.5 px-5 whitespace-nowrap">
                        <span
                          className={`text-xs font-semibold ${
                            u.status === 'active'
                              ? 'text-emerald-700'
                              : u.status === 'pending'
                                ? 'text-amber-700'
                                : 'text-red-700'
                          }`}
                        >
                          {u.status === 'active'
                            ? 'Aktif'
                            : u.status === 'pending'
                              ? 'Menunggu'
                              : 'Nonaktif'}
                        </span>
                      </td>
                      <td className="py-3.5 px-5 text-right whitespace-nowrap">
                        {isPrimary || isSelf ? (
                          <span className="text-xs text-slate-500">
                            {isPrimary ? 'Akses Penuh Terkunci' : 'Sesi Anda'}
                          </span>
                        ) : (
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleRoleStatusChange(
                                  u.uid,
                                  'kasir',
                                  'active',
                                  currentShift || 'Shift Kasir'
                                )
                              }
                              className="px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
                            >
                              {u.status === 'pending' ? 'Aktifkan Kasir' : 'Set Kasir'}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleRoleStatusChange(
                                  u.uid,
                                  'admin',
                                  'active',
                                  currentShift || 'Admin'
                                )
                              }
                              className="px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
                            >
                              Set Admin
                            </button>
                            {u.status === 'active' ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  handleRoleStatusChange(
                                    u.uid,
                                    u.role,
                                    'inactive',
                                    currentShift
                                  )
                                }
                                className="px-2.5 py-1.5 rounded-md border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                              >
                                Nonaktifkan
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  handleRoleStatusChange(
                                    u.uid,
                                    u.role === 'pending' ? 'kasir' : u.role,
                                    'active',
                                    currentShift || 'Shift Kasir'
                                  )
                                }
                                className="px-2.5 py-1.5 rounded-md bg-emerald-700 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                              >
                                Aktifkan
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Daftar Undangan Staf */}
      {invites.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h3 className="font-display font-semibold text-base text-slate-900">
              Daftar Undangan Staf ({invites.length})
            </h3>
          </div>
          <div className="divide-y divide-slate-100">
            {invites.map((inv) => (
              <div
                key={inv.id}
                className="px-5 py-3.5 flex items-center justify-between gap-4 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 truncate">
                    {inv.displayName}
                    <span className="mx-1.5 text-slate-400" aria-hidden="true">·</span>
                    <span className="text-xs font-normal text-slate-600">
                      {getRoleLabel(inv.role)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 truncate">
                    {inv.email}
                    {inv.shiftLabel ? ` · ${inv.shiftLabel}` : ''}
                    <span className="mx-1.5" aria-hidden="true">·</span>
                    <span className={inv.status === 'claimed' ? 'text-emerald-700' : 'text-amber-700'}>
                      {inv.status === 'claimed' ? 'Sudah Diklaim' : 'Menunggu Login Pertama'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteInvite(inv.id)}
                  className="p-2 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 shrink-0 cursor-pointer"
                  aria-label={`Hapus undangan ${inv.email}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
