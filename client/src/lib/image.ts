/**
 * Shrink an uploaded photo before it is stored.
 *
 * Line-item photos live in the database as base64 data URLs, get copied down
 * the carry-forward chain, and land in every nightly backup — so a 3 MB phone
 * photo is expensive several times over. Downscaling to a long edge of 480px
 * as JPEG brings that to roughly 30–60 KB, which is more than enough for a
 * thumbnail on screen and a small image on the PDF.
 *
 * Uses canvas, so there is no dependency.
 */
export function shrinkImage(file: File, maxEdge = 480, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image the browser can read'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Could not process that image'));
        // JPEG has no alpha, so fill white rather than letting transparency go black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
