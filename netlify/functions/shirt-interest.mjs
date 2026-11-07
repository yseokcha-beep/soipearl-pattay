// Cooler Shirt Shop interest API for Netlify (NOT related to Stripe payment code).
// Each product/browser pair is stored under its own key, avoiding lost increments.
// Note: clearing browser data / new devices can register another like.
import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

const PRODUCT_IDS = new Set(['0', '1', '2', '3', '4', '5']);
const NO_CACHE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => Response.json(body, { status, headers: NO_CACHE });

function sameSecret(sent, expected) {
  if (!sent || !expected) return false;
  const a = createHash('sha256').update(sent).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function getCounts(blobItems) {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const entry of blobItems) {
    const match = /^likes\/([0-5])\/[a-f0-9]{64}$/.exec(entry.key);
    if (match) counts[match[1]] += 1;
  }
  return counts;
}

async function countsFromStore(store) {
  const { blobs } = await store.list({ prefix: 'likes/' });
  return getCounts(blobs);
}

export default async (request) => {
  const path = new URL(request.url);
  const isStats = path.searchParams.get('stats') === '1';
  const method = request.method.toUpperCase();
  if ((isStats && method !== 'GET') || (!isStats && method !== 'GET' && method !== 'POST')) {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const store = getStore({ name: 'soi6-shirt-interest', consistency: 'strong' });

    if (isStats) {
      const adminKey = process.env.INTEREST_ADMIN_KEY;
      if (!adminKey) return json({ error: 'Configure INTEREST_ADMIN_KEY in Netlify environment variables' }, 503);
      const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!sameSecret(token, adminKey)) return json({ error: 'Unauthorized' }, 401);
      return json({ counts: await countsFromStore(store) });
    }

    if (method === 'GET') {
      return json({status:'ok', products: 6});
    }

    // Browsers must submit from the site itself; this is a basic guard,
    // not a complete anti-bot or multi-device uniqueness guarantee.
    const origin = request.headers.get('origin');
    if (origin && origin !== path.origin) return json({ error: 'Invalid origin' }, 403);

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return json({ error: 'Expected JSON' }, 415);
    }
    const size = Number(request.headers.get('content-length') || 0);
    if (size > 2048) return json({ error: 'Request too large' }, 413);
    let payload;
    try { payload = await request.json(); }
    catch (_) { return json({ error: 'Invalid JSON' }, 400); }
    const productId = String(payload?.productId ?? '');
    const visitorId = payload?.visitorId;
    if (!PRODUCT_IDS.has(productId) || typeof visitorId !== 'string' ||
        visitorId.length < 16 || visitorId.length > 160 ||
        !/^[a-zA-Z0-9_.-]+$/.test(visitorId)) {
      return json({ error: 'Invalid product or visitor' }, 400);
    }

    // Pseudonymous visitor key; never store raw phone or email for interest clicks.
    const digest = createHash('sha256').update(visitorId).digest('hex');
    const key = `likes/${productId}/${digest}`;
    const saved = await store.set(key, '1', {onlyIfNew:true});
    // Only owner-authorized requests can read counts.
    return json({saved:true, alreadyLiked:!saved.modified});
  } catch (error) {
    console.error('shirt-interest: storage error', error);
    return json({ error: 'Interest database is temporarily unavailable' }, 503);
  }
};
