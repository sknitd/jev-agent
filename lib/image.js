// Prepares images to TypeSafe's limits: PNG/JPEG, each side 280–1568 px.
const MAX = 1568;
const MIN = 280;

export function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * @typedef {Object} PreparedImage
 * @property {string} base64        JPEG, no data: prefix (TypeSafe data_base64)
 * @property {"jpg"} format
 * @property {string} dataUrl       for DeepSeek vision + panel thumbnail
 * @property {number} width         canvas width sent to Jev (may include padding)
 * @property {number} height
 * @property {number} contentWidth  width of the real screenshot inside the canvas
 * @property {number} contentHeight
 */

/** @param {string} dataUrl captureVisibleTab output @returns {Promise<PreparedImage>} */
export async function prepareScreenshot(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;

  let scale = Math.min(1, MAX / Math.max(w, h));
  if (Math.min(w, h) * scale < MIN) scale = MIN / Math.min(w, h);
  if (Math.max(w, h) * scale > MAX) scale = MAX / Math.max(w, h); // extreme aspect: fit, then pad

  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const W = Math.max(cw, MIN), H = Math.max(ch, MIN);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, cw, ch);
  bmp.close?.();

  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const base64 = bytesToBase64(await out.arrayBuffer());
  return {
    base64, format: "jpg", dataUrl: `data:image/jpeg;base64,${base64}`,
    width: W, height: H, contentWidth: cw, contentHeight: ch
  };
}

/** 400×400 white image with a red square at 0.3–0.7 of each side, for connection tests. */
export async function makeTestImage() {
  const canvas = new OffscreenCanvas(400, 400);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = "#e01e1e";
  ctx.fillRect(120, 120, 160, 160);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const base64 = bytesToBase64(await blob.arrayBuffer());
  return { base64, format: "jpg", dataUrl: `data:image/jpeg;base64,${base64}` };
}
