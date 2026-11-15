import jsPDF from 'jspdf';

export type ReceiptPaperWidth = 58 | 80;

export interface ReceiptPrintOutcome {
  status: 'printed' | 'blocked_or_unavailable' | 'error';
  message?: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildReceiptHtmlDocument(
  receiptText: string,
  title: string = 'Struk Transaksi',
  paperWidthMm: ReceiptPaperWidth = 58
): string {
  const printableWidthMm = paperWidthMm === 80 ? 74 : 52;
  const fontSizePx = paperWidthMm === 80 ? 12 : 10.5;
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page {
      margin: 2mm;
    }
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #000000;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .receipt-sheet {
      width: ${printableWidthMm}mm;
      max-width: 100%;
      margin: 0 auto;
      padding: 2mm 1mm 6mm 1mm;
    }
    pre {
      margin: 0;
      font-family: "JetBrains Mono", "Courier New", Courier, ui-monospace, monospace;
      font-size: ${fontSizePx}px;
      line-height: 1.42;
      font-weight: 500;
      white-space: pre-wrap;
      word-break: break-word;
      color: #000000;
    }
  </style>
</head>
<body>
  <div class="receipt-sheet">
    <pre>${escapeHtml(receiptText)}</pre>
  </div>
</body>
</html>`;
}

/**
 * Mencetak struk melalui hidden print iframe terisolasi agar:
 * 1) Tidak bentrok dengan CSS modal/overflow Tailwind di halaman utama.
 * 2) Tidak terpotong timer cleanup terlalu cepat saat dialog print masih terbuka.
 * 3) Mendeteksi bila lingkungan iframe/WebView memblokir window.print() sehingga UI
 *    langsung menawarkan alternatif Unduh PDF Struk (58mm) / RawBT / Bagikan.
 */
export function printThermalReceiptText(
  receiptText: string,
  options?: {
    title?: string;
    paperWidthMm?: ReceiptPaperWidth;
  }
): Promise<ReceiptPrintOutcome> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return Promise.resolve({
      status: 'blocked_or_unavailable',
      message: 'Fungsi cetak hanya tersedia di browser.',
    });
  }

  const title = options?.title || 'Struk KEDAI KHANXA';
  const paperWidthMm: ReceiptPaperWidth = options?.paperWidthMm === 80 ? 80 : 58;
  const html = buildReceiptHtmlDocument(receiptText, title, paperWidthMm);

  return new Promise((resolve) => {
    let settled = false;
    let frame: HTMLIFrameElement | null = null;
    let hardCleanupTimer: number | undefined;

    const cleanupFrame = () => {
      if (hardCleanupTimer !== undefined) {
        window.clearTimeout(hardCleanupTimer);
        hardCleanupTimer = undefined;
      }
      if (frame && frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
      frame = null;
    };

    const finish = (outcome: ReceiptPrintOutcome, delayRemoveMs = 1500) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
      if (delayRemoveMs <= 0) {
        cleanupFrame();
      } else {
        window.setTimeout(cleanupFrame, delayRemoveMs);
      }
    };

    try {
      frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('title', 'Cetak Struk');
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '1px';
      frame.style.height = '1px';
      frame.style.border = '0';
      frame.style.opacity = '0';
      frame.style.pointerEvents = 'none';

      let executedPrint = false;

      const triggerPrintInFrame = () => {
        if (executedPrint || !frame) return;
        executedPrint = true;

        const win = frame.contentWindow;
        if (!win) {
          finish({
            status: 'error',
            message: 'Jendela cetak tidak tersedia.',
          }, 0);
          return;
        }

        let beforePrintFired = false;
        let afterPrintFired = false;

        const onBeforePrint = () => {
          beforePrintFired = true;
        };
        const onAfterPrint = () => {
          afterPrintFired = true;
          win.removeEventListener('beforeprint', onBeforePrint);
          win.removeEventListener('afterprint', onAfterPrint);
          finish({ status: 'printed' }, 400);
        };

        win.addEventListener('beforeprint', onBeforePrint);
        win.addEventListener('afterprint', onAfterPrint);

        // Jaga iframe tetap hidup hingga 120 detik agar dialog cetak browser desktop tidak kehilangan dokumen
        hardCleanupTimer = window.setTimeout(() => {
          cleanupFrame();
        }, 120000);

        window.requestAnimationFrame(() => {
          window.setTimeout(() => {
            try {
              const start = Date.now();
              win.focus();
              win.print();
              const elapsed = Date.now() - start;

              if (afterPrintFired) {
                finish({ status: 'printed' }, 400);
                return;
              }

              // Pada iframe sandbox tanpa allow-modals atau WebView terblokir, print() langsung selesai <30ms tanpa event beforeprint
              window.setTimeout(() => {
                if (settled) return;
                if (!beforePrintFired && !afterPrintFired && elapsed < 30) {
                  finish(
                    {
                      status: 'blocked_or_unavailable',
                      message:
                        'Dialog cetak langsung diblokir oleh pratinjau/browser ini. Gunakan tombol Unduh PDF Struk atau buka di tab browser baru.',
                    },
                    800
                  );
                } else {
                  finish({ status: 'printed' }, 60000);
                }
              }, 220);
            } catch {
              finish(
                {
                  status: 'blocked_or_unavailable',
                  message:
                    'Browser tidak mengizinkan dialog cetak langsung. Gunakan Unduh PDF Struk sebagai gantinya.',
                },
                0
              );
            }
          }, 40);
        });
      };

      frame.onload = triggerPrintInFrame;
      frame.srcdoc = html;
      document.body.appendChild(frame);

      // Fallback bila browser tidak memanggil onload untuk srcdoc secara cepat
      window.setTimeout(() => {
        if (!executedPrint && frame?.contentDocument?.body?.innerHTML) {
          triggerPrintInFrame();
        }
      }, 450);
    } catch {
      finish(
        {
          status: 'error',
          message: 'Gagal menyiapkan dokumen cetak.',
        },
        0
      );
    }
  });
}

/**
 * Menghasilkan dan mengunduh file PDF ukuran kertas thermal 58mm/80mm yang selalu berhasil
 * di Android, iOS, Desktop, maupun mode iframe pratinjau.
 */
export function downloadThermalReceiptPdf(
  receiptText: string,
  filenameBase: string,
  paperWidthMm: ReceiptPaperWidth = 58
): void {
  const safeBase =
    filenameBase
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 60) || 'struk_kedai_khanxa';

  const rawLines = receiptText.split('\n');
  const marginX = 3;
  const marginTop = 6;
  const lineHeightMm = paperWidthMm === 80 ? 4.3 : 3.9;
  const fontSizePt = paperWidthMm === 80 ? 9 : 7.5;
  const maxCharsPerLine = paperWidthMm === 80 ? 44 : 34;

  const wrappedLines: string[] = [];
  for (const line of rawLines) {
    if (line.length <= maxCharsPerLine) {
      wrappedLines.push(line);
    } else {
      for (let i = 0; i < line.length; i += maxCharsPerLine) {
        wrappedLines.push(line.slice(i, i + maxCharsPerLine));
      }
    }
  }

  const totalHeightMm = Math.max(70, marginTop + wrappedLines.length * lineHeightMm + 8);
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [paperWidthMm, totalHeightMm],
  });

  doc.setFont('courier', 'normal');
  doc.setFontSize(fontSizePt);
  doc.setTextColor(0, 0, 0);

  let y = marginTop;
  for (const line of wrappedLines) {
    doc.text(line, marginX, y);
    y += lineHeightMm;
  }

  doc.save(`${safeBase}.pdf`);
}

/**
 * URI RawBT untuk printer thermal Bluetooth di HP Android (aplikasi RawBT Print Service).
 */
export function buildRawBtThermalUrl(receiptText: string): string {
  const payload = `${receiptText}\n\n\n`;
  try {
    if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
      const bytes = new TextEncoder().encode(payload);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
      }
      return `rawbt:base64,${btoa(binary)}`;
    }
  } catch {
    // Fallback below
  }
  return `rawbt:${encodeURIComponent(payload)}`;
}

export async function shareReceiptTextNative(
  receiptText: string,
  title: string = 'Struk KEDAI KHANXA'
): Promise<'shared' | 'unsupported' | 'cancelled'> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return 'unsupported';
  }
  try {
    await navigator.share({
      title,
      text: receiptText,
    });
    return 'shared';
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return 'cancelled';
    }
    return 'unsupported';
  }
}
