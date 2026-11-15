import React, { useMemo, useState } from 'react';
import type { SalesTrendPoint } from '../utils/fullReports';
import { formatRupiah } from '../utils/formatters';

interface SalesTrendChartProps {
  points: SalesTrendPoint[];
  granularityLabel: string;
}

function formatCompactAxis(val: number): string {
  if (val >= 1_000_000) {
    const m = val / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)} jt`;
  }
  if (val >= 1_000) {
    return `${Math.round(val / 1_000)} rb`;
  }
  return String(Math.round(val));
}

export function SalesTrendChart({ points, granularityLabel }: SalesTrendChartProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const hasAnyData = useMemo(
    () => points.some((p) => p.revenue > 0 || p.profit !== 0 || p.transactionCount > 0),
    [points]
  );

  const selectedPoint = useMemo(() => {
    if (selectedKey) {
      const found = points.find((p) => p.key === selectedKey);
      if (found) return found;
    }
    const lastNonZero = [...points].reverse().find((p) => p.revenue > 0);
    return lastNonZero || points[points.length - 1] || null;
  }, [points, selectedKey]);

  if (points.length === 0 || !hasAnyData) {
    return (
      <div className="border border-dashed border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
        Belum ada data transaksi penjualan selesai untuk grafik tren {granularityLabel.toLowerCase()}.
      </div>
    );
  }

  const maxVal = Math.max(
    1000,
    ...points.map((p) => Math.max(0, p.revenue, p.profit))
  );
  const niceMax = Math.ceil(maxVal * 1.15);

  const chartHeight = 230;
  const padTop = 18;
  const padBottom = 34;
  const padLeft = 52;
  const padRight = 16;
  const plotHeight = chartHeight - padTop - padBottom;
  const minSlotWidth = points.length > 10 ? 44 : 58;
  const plotWidth = Math.max(540, points.length * minSlotWidth);
  const svgWidth = padLeft + plotWidth + padRight;
  const slotW = plotWidth / points.length;
  const barW = Math.min(24, Math.max(12, slotW * 0.44));

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const profitLinePath = points
    .map((p, idx) => {
      const cx = padLeft + idx * slotW + slotW / 2;
      const clamped = Math.max(0, p.profit);
      const cy = padTop + plotHeight - (clamped / niceMax) * plotHeight;
      return `${idx === 0 ? 'M' : 'L'} ${cx.toFixed(1)} ${cy.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="space-y-3">
      {/* Detail titik terpilih (nyaman disentuh di Android) */}
      {selectedPoint && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-xs">
          <div className="font-medium text-slate-700">
            Titik aktif: <strong className="text-slate-900">{selectedPoint.label}</strong>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono-num">
            <span className="text-slate-700">
              Omzet: <strong className="text-slate-900">{formatRupiah(selectedPoint.revenue)}</strong>
            </span>
            <span className="text-emerald-700">
              Laba Kotor: <strong>{formatRupiah(selectedPoint.profit)}</strong>
            </span>
            <span className="text-slate-600">{selectedPoint.transactionCount} trx</span>
          </div>
        </div>
      )}

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <div className="inline-flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-emerald-700 inline-block" />
          <span>Omzet Penjualan</span>
        </div>
        <div className="inline-flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-amber-600 inline-block" />
          <span>Laba Kotor</span>
        </div>
        <span className="text-[11px] text-slate-400">Ketuk batang grafik untuk detail angka</span>
      </div>

      {/* Scroll horizontal aman untuk Android bila jumlah batang > 10 */}
      <div className="overflow-x-auto pb-1">
        <svg
          viewBox={`0 0 ${svgWidth} ${chartHeight}`}
          className="w-full min-w-[540px] h-[230px] select-none"
          role="img"
          aria-label={`Grafik tren omzet ${granularityLabel}`}
        >
          {/* Grid horizontal & sumbu Y */}
          {ticks.map((t) => {
            const y = padTop + plotHeight - t * plotHeight;
            const val = niceMax * t;
            return (
              <g key={t}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={svgWidth - padRight}
                  y2={y}
                  stroke={t === 0 ? '#cbd5e1' : '#e2e8f0'}
                  strokeDasharray={t === 0 ? undefined : '3 3'}
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-slate-500 text-[10px] font-mono"
                >
                  {formatCompactAxis(val)}
                </text>
              </g>
            );
          })}

          {/* Batang Omzet */}
          {points.map((p, idx) => {
            const cx = padLeft + idx * slotW + slotW / 2;
            const barH = Math.max(0, (Math.max(0, p.revenue) / niceMax) * plotHeight);
            const y = padTop + plotHeight - barH;
            const isSelected = selectedPoint?.key === p.key;

            return (
              <g
                key={p.key}
                className="cursor-pointer"
                onClick={() => setSelectedKey(p.key)}
                onMouseEnter={() => setSelectedKey(p.key)}
              >
                {/* Hit area penuh setinggi plot agar mudah disentuh jari di Android */}
                <rect
                  x={padLeft + idx * slotW}
                  y={padTop}
                  width={slotW}
                  height={plotHeight + padBottom}
                  fill="transparent"
                />
                {isSelected && (
                  <rect
                    x={padLeft + idx * slotW + 2}
                    y={padTop}
                    width={Math.max(4, slotW - 4)}
                    height={plotHeight}
                    rx={4}
                    fill="#ecfdf5"
                  />
                )}
                <rect
                  x={cx - barW / 2}
                  y={y}
                  width={barW}
                  height={Math.max(p.revenue > 0 ? 3 : 0, barH)}
                  rx={3}
                  fill={isSelected ? '#065f46' : '#047857'}
                  opacity={isSelected ? 1 : 0.85}
                />
                <text
                  x={cx}
                  y={chartHeight - 10}
                  textAnchor="middle"
                  className={`text-[10px] font-mono ${
                    isSelected ? 'fill-emerald-800 font-bold' : 'fill-slate-500'
                  }`}
                >
                  {p.shortLabel}
                </text>
              </g>
            );
          })}

          {/* Garis Laba Kotor */}
          <path
            d={profitLinePath}
            fill="none"
            stroke="#d97706"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
          {points.map((p, idx) => {
            const cx = padLeft + idx * slotW + slotW / 2;
            const cy = padTop + plotHeight - (Math.max(0, p.profit) / niceMax) * plotHeight;
            const isSelected = selectedPoint?.key === p.key;
            return (
              <circle
                key={`pt-${p.key}`}
                cx={cx}
                cy={cy}
                r={isSelected ? 4 : 2.5}
                fill="#d97706"
                stroke="#ffffff"
                strokeWidth="1.2"
                pointerEvents="none"
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
