// Builds a numbered "contact sheet" image of many catalog products, so the model can scan a
// whole category by eye (e.g. to find the piece in a customer's photo or an Instagram reel cover).

import sharp from 'sharp';
import { log } from './log.js';

const TILE = 180; // px
const LABEL = 22; // px strip under each photo
const COLS = 6;
export const PER_SHEET = 36;

const thumbCache = new Map(); // url -> Buffer (TILE x TILE jpeg)

async function thumb(url) {
  if (thumbCache.has(url)) return thumbCache.get(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize(TILE, TILE, { fit: 'contain', background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer();
    thumbCache.set(url, buf);
    if (thumbCache.size > 1500) thumbCache.delete(thumbCache.keys().next().value);
    return buf;
  } catch (err) {
    log.warn('thumb failed', { url, err: String(err) });
    return null;
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// products: [{ code, image }] (up to PER_SHEET). Returns a JPEG buffer.
export async function buildSheet(products) {
  const items = products.slice(0, PER_SHEET);
  const rows = Math.ceil(items.length / COLS);
  const width = COLS * TILE;
  const height = rows * (TILE + LABEL);
  const thumbs = await Promise.all(items.map((p) => (p.image ? thumb(p.image) : null)));

  const composites = [];
  items.forEach((p, i) => {
    const x = (i % COLS) * TILE;
    const y = Math.floor(i / COLS) * (TILE + LABEL);
    if (thumbs[i]) composites.push({ input: thumbs[i], left: x, top: y });
  });
  const labels = items
    .map((p, i) => {
      const x = (i % COLS) * TILE;
      const y = Math.floor(i / COLS) * (TILE + LABEL) + TILE;
      return (
        `<rect x="${x}" y="${y}" width="${TILE}" height="${LABEL}" fill="#222"/>` +
        `<text x="${x + 6}" y="${y + 16}" font-family="DejaVu Sans, sans-serif" font-size="14" fill="#fff">${i + 1}. ${esc(p.code)}</text>` +
        `<rect x="${x}" y="${y - TILE}" width="${TILE}" height="${TILE + LABEL}" fill="none" stroke="#ccc"/>`
      );
    })
    .join('');
  composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`), left: 0, top: 0 });

  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .jpeg({ quality: 78 })
    .toBuffer();
}
