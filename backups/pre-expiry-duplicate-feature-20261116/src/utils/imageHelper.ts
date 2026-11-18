const MAX_DATA_URL_LENGTH = 75000;
const MAX_DIMENSION = 320;

export function compressCanvasToJpegDataUrl(sourceCanvas: HTMLCanvasElement): string {
  let quality = 0.78;
  let dataUrl = sourceCanvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length > MAX_DATA_URL_LENGTH && quality > 0.35) {
    quality -= 0.1;
    dataUrl = sourceCanvas.toDataURL('image/jpeg', quality);
  }
  if (dataUrl.length > MAX_DATA_URL_LENGTH) {
    // Perkecil dimensi jika masih di atas batas
    const smaller = document.createElement('canvas');
    smaller.width = Math.max(120, Math.round(sourceCanvas.width * 0.7));
    smaller.height = Math.max(120, Math.round(sourceCanvas.height * 0.7));
    const ctx = smaller.getContext('2d');
    if (ctx) {
      ctx.drawImage(sourceCanvas, 0, 0, smaller.width, smaller.height);
      dataUrl = smaller.toDataURL('image/jpeg', 0.55);
    }
  }
  return dataUrl;
}

export async function compressImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Format gambar tidak didukung.'));
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Browser tidak mendukung pemrosesan gambar.'));
          return;
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(compressCanvasToJpegDataUrl(canvas));
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

export function captureVideoFrameAsDataUrl(video: HTMLVideoElement): string {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(vw, vh));
  const width = Math.max(1, Math.round(vw * scale));
  const height = Math.max(1, Math.round(vh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Gagal menangkap gambar dari kamera.');
  }
  ctx.drawImage(video, 0, 0, width, height);
  return compressCanvasToJpegDataUrl(canvas);
}
