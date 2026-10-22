// Read-only access to the public siamoods.com catalog API.

import { config } from './config.js';

const LANGS = ['hy', 'en', 'ru'];
const normLang = (l) => (LANGS.includes(l) ? l : 'hy');

async function getJson(path, params = {}) {
  const url = new URL(`${config.siteApiBaseUrl}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, String(x)));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Catalog ${path} -> ${res.status}`);
  return res.json();
}

export function productUrl(slug, lang) {
  const l = normLang(lang);
  const prefix = l === 'hy' ? '' : `/${l}`;
  return `${config.siteBaseUrl}${prefix}/product/${slug}`;
}

// ---- Category / stone / collection names → IDs (refreshed every 6h) ----

let taxonomy = null;
let taxonomyAt = 0;

export async function getTaxonomy() {
  if (taxonomy && Date.now() - taxonomyAt < 6 * 3600 * 1000) return taxonomy;
  const result = {};
  for (const lang of LANGS) {
    const data = await getJson('/store-data', { lang });
    result[lang] = {
      types: (data.types || []).map((t) => ({ id: t.id, name: t.name })),
      stones: (data.stones || []).map((t) => ({ id: t.id, name: t.name })),
      collections: (data.collections || []).map((t) => ({ id: t.id, name: t.name })),
    };
  }
  taxonomy = result;
  taxonomyAt = Date.now();
  return taxonomy;
}

// Text block for the system prompt: lets the model pick IDs itself.
export async function taxonomyText() {
  const t = await getTaxonomy();
  const line = (key) =>
    t.hy[key]
      .map((item) => {
        const en = t.en[key].find((x) => x.id === item.id)?.name;
        const ru = t.ru[key].find((x) => x.id === item.id)?.name;
        return `${item.id}: ${item.name} / ${en || '-'} / ${ru || '-'}`;
      })
      .join('\n');
  return [
    'PRODUCT TYPES (id: hy / en / ru):',
    line('types'),
    '',
    'STONES / MATERIALS (id: hy / en / ru):',
    line('stones'),
    '',
    'COLLECTIONS / THEMES (id: hy / en / ru):',
    line('collections'),
  ].join('\n');
}

// ---- Search ----

const SORTS = { newest: 0, price_high_to_low: 3, price_low_to_high: 4, biggest_discount: 5, popular: 7 };

function shortProduct(p, lang) {
  const sizes = (p.variations || [])
    .filter((v) => Number(v.available) > 0)
    .map((v) => v.title);
  const outOfStockSizes = (p.variations || [])
    .filter((v) => !(Number(v.available) > 0))
    .map((v) => v.title);
  return {
    title: p.title,
    code: (p.title || '').split(' ').pop(),
    price_amd: p.price,
    discount_price_amd: p.discount ? p.discount_price : null,
    discount_percent: p.discount || null,
    in_stock: Number(p.available) > 0,
    sizes_in_stock: sizes.length ? sizes : undefined,
    sizes_out_of_stock: outOfStockSizes.length ? outOfStockSizes : undefined,
    url: productUrl(p.slug, lang),
    image: p.images?.[0]?.ogg_image || p.images?.[0]?.image || null,
  };
}

export async function searchProducts(input) {
  const lang = normLang(input.lang);
  const params = {
    lang,
    search: input.query,
    type: input.type_ids,
    stone: input.stone_ids,
    filter: input.collection_ids,
    discount: input.discounted_only ? 1 : undefined,
    balance: input.include_out_of_stock ? undefined : 1,
    sort_by: SORTS[input.sort] ?? SORTS.popular,
  };
  // The site applies a price range only when both ends are present.
  if (input.min_price != null || input.max_price != null) {
    params.min_price = input.min_price ?? 0;
    params.max_price = input.max_price ?? 10_000_000;
  }
  const data = await getJson('/products', params);
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 8);
  return {
    total_found: data.meta?.total ?? (data.data || []).length,
    products: (data.data || []).slice(0, limit).map((p) => shortProduct(p, lang)),
  };
}

export async function getProduct(input) {
  const lang = normLang(input.lang);
  let slug = input.slug;
  if (!slug && input.code) {
    const found = await getJson('/products', { lang, search: input.code });
    const exact =
      (found.data || []).find((p) => (p.title || '').toUpperCase().endsWith(input.code.toUpperCase())) ||
      (found.data || [])[0];
    if (!exact) return { found: false };
    slug = exact.slug;
  }
  if (!slug) return { found: false };
  const p = await getJson('/product', { lang, slug });
  const d = p.data || p;
  if (!d || !d.title) return { found: false };
  return {
    found: true,
    ...shortProduct(d, lang),
    url: d.url || productUrl(d.slug, lang),
    description: d.specification || d.meta_description || undefined,
    weight: d.weight || undefined,
    dimensions: d.size || undefined,
    variation_type: d.variation_type || undefined,
  };
}
