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

const codeToSlug = new Map(); // filled from every search result
const productCache = new Map(); // `${lang}:${slug}` -> { at, data }

const SORTS = { newest: 0, price_high_to_low: 3, price_low_to_high: 4, biggest_discount: 5, popular: 7 };

function shortProduct(p, lang) {
  const sizes = (p.variations || [])
    .filter((v) => Number(v.available) > 0)
    .map((v) => v.title);
  const outOfStockSizes = (p.variations || [])
    .filter((v) => !(Number(v.available) > 0))
    .map((v) => v.title);
  const code = (p.title || '').split(' ').pop();
  if (code && p.slug) codeToSlug.set(`${lang}:${code.toUpperCase()}`, p.slug);
  return {
    title: p.title,
    code,
    slug: p.slug,
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
  const products = (data.data || []).slice(0, limit).map((p) => shortProduct(p, lang));
  if (input.with_matching_sets) await attachMatchingSets(products, lang);
  return { total_found: data.meta?.total ?? (data.data || []).length, products };
}

async function fetchProductDetail(slug, lang) {
  const key = `${lang}:${slug}`;
  const hit = productCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const p = await getJson('/product', { lang, slug });
  const d = p.data || p;
  productCache.set(key, { at: Date.now(), data: d });
  if (productCache.size > 500) productCache.delete(productCache.keys().next().value);
  return d;
}

export async function getProduct(input) {
  const lang = normLang(input.lang);
  let slug = input.slug || (input.code && codeToSlug.get(`${lang}:${String(input.code).toUpperCase()}`));
  if (!slug && input.code) {
    const found = await getJson('/products', { lang, search: input.code });
    const exact =
      (found.data || []).find((p) => (p.title || '').toUpperCase().endsWith(input.code.toUpperCase())) ||
      (found.data || [])[0];
    if (!exact) return { found: false };
    slug = exact.slug;
  }
  if (!slug) return { found: false };
  const d = await fetchProductDetail(slug, lang);
  if (!d || !d.title) return { found: false };
  const matching = (d.related_products || []).map((x) => shortProduct(x, lang));
  const chains = (d.linked_products || []).map((x) => shortProduct(x, lang));
  return {
    found: true,
    ...shortProduct(d, lang),
    url: d.url || productUrl(d.slug, lang),
    description: d.specification || d.meta_description || undefined,
    weight: d.weight || undefined,
    dimensions: d.size || undefined,
    variation_type: d.variation_type || undefined,
    // Pieces of the same design/set shown on the product page ("matching items")
    matching_set_items: matching.length ? matching : undefined,
    // Chains suggested for this pendant on the product page
    suggested_chains: chains.length ? chains.slice(0, 4) : undefined,
  };
}

// For several products at once: their matching set pieces (used to build sets).
export async function getMatchingSets(input) {
  const refs = [
    ...(input.slugs || []).map((slug) => ({ slug })),
    ...(input.codes || []).map((code) => ({ code })),
  ].slice(0, 6);
  const found = await Promise.all(refs.map((r) => getProduct({ ...r, lang: input.lang }).catch(() => ({ found: false }))));
  const results = [];
  for (const p of found) {
    if (!p.found) continue;
    results.push({
      code: p.code,
      title: p.title,
      price_amd: p.price_amd,
      discount_price_amd: p.discount_price_amd,
      in_stock: p.in_stock,
      sizes_in_stock: p.sizes_in_stock,
      url: p.url,
      image: p.image,
      matching_set_items: p.matching_set_items || [],
      suggested_chains: p.suggested_chains,
    });
  }
  return { products: results };
}

// Adds in-stock matching set pieces to search results (one parallel round of detail calls).
async function attachMatchingSets(products, lang) {
  await Promise.all(
    products.map(async (p) => {
      try {
        const d = await fetchProductDetail(p.slug, lang);
        const items = (d.related_products || []).map((x) => shortProduct(x, lang)).filter((x) => x.in_stock);
        if (items.length) p.matching_set_items = items;
        const chains = (d.linked_products || []).map((x) => shortProduct(x, lang)).filter((x) => x.in_stock);
        if (chains.length) p.suggested_chains = chains.slice(0, 3);
      } catch {}
    }),
  );
}
