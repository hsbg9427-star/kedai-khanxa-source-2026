import React, { useMemo, useState } from 'react';
import { BookUser, Search, UserPlus, X } from 'lucide-react';
import type { Customer } from '../types/database';
import { formatRupiah } from '../utils/formatters';
import { resolvePosCustomerMatch } from '../utils/qrisFee';

interface CustomerBonComboboxProps {
  customers: Customer[];
  selectedCustomerId: string;
  customerInput: string;
  newCustomerPhone: string;
  onSelectCustomer: (customerId: string, displayName: string) => void;
  onChangeInput: (nextText: string) => void;
  onChangeNewPhone: (nextPhone: string) => void;
  onClear: () => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  isDebtMode?: boolean;
}

export function CustomerBonCombobox({
  customers,
  selectedCustomerId,
  customerInput,
  newCustomerPhone,
  onSelectCustomer,
  onChangeInput,
  onChangeNewPhone,
  onClear,
  label = 'Pelanggan',
  placeholder = 'Ketik nama baru / pilih pelanggan (opsional)',
  required = false,
  isDebtMode = false,
}: CustomerBonComboboxProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const matchResult = useMemo(
    () => resolvePosCustomerMatch(customers, customerInput, selectedCustomerId || undefined),
    [customers, customerInput, selectedCustomerId]
  );

  const suggestions = useMemo(() => {
    const q = customerInput.trim().toLowerCase();
    const sorted = [...customers].sort((a, b) => {
      const debtDiff = (Number(b.totalDebt) || 0) - (Number(a.totalDebt) || 0);
      if (debtDiff !== 0) return debtDiff;
      return a.name.localeCompare(b.name, 'id-ID');
    });
    if (!q) return sorted.slice(0, 8);
    return sorted
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.phone || '').toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [customers, customerInput]);

  const activeCustomer = matchResult.matchedCustomer;
  const activeDebt = Number(activeCustomer?.totalDebt) || 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-xs font-semibold text-slate-700">
          {label} {required && <span className="text-rose-600">*</span>}
        </label>
        {activeCustomer && activeDebt > 0 && (
          <span className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
            Piutang aktif: {formatRupiah(activeDebt)}
          </span>
        )}
      </div>

      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={customerInput}
          required={required}
          onFocus={() => setDropdownOpen(true)}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 160)}
          onChange={(e) => {
            onChangeInput(e.target.value);
            setDropdownOpen(true);
          }}
          placeholder={placeholder}
          className="w-full min-h-[40px] pl-8 pr-8 rounded-lg border border-slate-200 bg-white text-xs sm:text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
        />
        {customerInput.trim().length > 0 && (
          <button
            type="button"
            onClick={() => {
              onClear();
              setDropdownOpen(false);
            }}
            aria-label="Hapus pilihan pelanggan"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        {dropdownOpen && suggestions.length > 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto divide-y divide-slate-100">
            {suggestions.map((c) => {
              const cDebt = Number(c.totalDebt) || 0;
              const isSel = activeCustomer?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectCustomer(c.id, c.name);
                    setDropdownOpen(false);
                  }}
                  className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 text-xs hover:bg-emerald-50/70 transition-colors cursor-pointer ${
                    isSel ? 'bg-emerald-50 font-semibold text-emerald-900' : 'text-slate-800'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.name}</div>
                    {c.phone && <div className="text-[11px] text-slate-500">{c.phone}</div>}
                  </div>
                  {cDebt > 0 ? (
                    <span className="shrink-0 text-[11px] font-semibold text-amber-800 bg-amber-100/80 px-1.5 py-0.5 rounded tabular-nums">
                      Bon {formatRupiah(cDebt)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] text-slate-400">Lunas</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {matchResult.isNewCustomer && (
        <div className="p-2.5 bg-emerald-50/70 border border-emerald-200 rounded-lg space-y-2">
          <div className="flex items-start gap-2 text-[11px] text-emerald-900">
            <UserPlus className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5" />
            <span>
              Pelanggan baru <strong>{matchResult.cleanName}</strong> akan otomatis didaftarkan ke
              Data Pelanggan saat transaksi disimpan.
            </span>
          </div>
          <input
            type="text"
            value={newCustomerPhone}
            onChange={(e) => onChangeNewPhone(e.target.value)}
            placeholder="No. HP / WhatsApp pelanggan baru (opsional)"
            className="w-full min-h-[34px] px-2.5 rounded-md border border-emerald-200 bg-white text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
          />
        </div>
      )}

      {activeCustomer && activeDebt > 0 && (
        <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900 flex items-start gap-2">
          <BookUser className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
          <span>
            Pelanggan ini memiliki gabungan piutang (Kasir/PPOB/Mini ATM) sebesar{' '}
            <strong className="tabular-nums">{formatRupiah(activeDebt)}</strong>.{' '}
            {isDebtMode
              ? 'Sisa transaksi ini akan otomatis digabung ke bon pelanggan dan dapat dilunasi sekaligus di Kasir atau Pelanggan & Piutang.'
              : 'Pelunasan bon dapat dilakukan sekaligus di Kasir atau menu Pelanggan & Piutang.'}
          </span>
        </div>
      )}
    </div>
  );
}
