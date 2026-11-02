'use strict';

// Read-only staff dashboard data source.
// Uses the date of Stripe's payment_intent.succeeded EVENT rather than
// PaymentIntent creation. No payment creation/confirmation, webhook writes,
// VIP cache changes or overlay changes happen in this function.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const TZ = 'Asia/Bangkok';
const ONE_DAY_SECONDS = 86400;
const THAI_OFFSET_SECONDS = 7 * 3600;
const BUSINESS_DAY_START_HOUR = 5; // Keep the previous operating day's orders until 05:00 Thailand time

function thaiDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// Until 04:59:59 Thailand time, the active business day is yesterday.
function thaiBusinessDateString(date = new Date()) {
  return thaiDateString(new Date(date.getTime() - BUSINESS_DAY_START_HOUR * 3600 * 1000));
}

function startOfThaiDay(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error('Invalid date. Use YYYY-MM-DD.');
  }
  const [year, month, day] = dateString.split('-').map(Number);
  const utcDay = Date.UTC(year, month - 1, day);
  if (new Date(utcDay).toISOString().slice(0, 10) !== dateString) {
    throw new Error('Invalid calendar date.');
  }
  return Math.floor(utcDay / 1000) - THAI_OFFSET_SECONDS + BUSINESS_DAY_START_HOUR * 3600;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  // Optional read-only historical check for recent Thai business dates (05:00 to 05:00).
  // The staff dashboard does NOT pass a date; it uses the 05:00-to-05:00 Thai business day.
  const requestedDate = (event.queryStringParameters || {}).date || thaiBusinessDateString();
  let start, end;
  try {
    start = startOfThaiDay(requestedDate);
    end = start + ONE_DAY_SECONDS;
    const currentDayStart = startOfThaiDay(thaiBusinessDateString());
    // Stripe's Events API provides the most recent 30 days only.
    if (start > currentDayStart || start < currentDayStart - 28 * ONE_DAY_SECONDS) {
      return json(400, { error: 'Only business dates in the last 29 days are available.' });
    }
  } catch (err) {
    return json(400, { error: err.message });
  }

  try {
    const results = new Map();
    let cursor;

    // A Stripe success event is dated when payment succeeds, including a
    // PaymentIntent created days earlier. Paginate ALL successes for the day.
    while (true) {
      const params = {
        type: 'payment_intent.succeeded',
        created: { gte: start, lt: end },
        limit: 100
      };
      if (cursor) params.starting_after = cursor;

      const page = await stripe.events.list(params);
      if (!page || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
        throw new Error('Incomplete Stripe event response.');
      }

      for (const item of page.data) {
        const pi = item && item.data && item.data.object;
        if (!item || item.type !== 'payment_intent.succeeded' ||
            !pi || typeof pi.id !== 'string' || pi.status !== 'succeeded' ||
            results.has(pi.id)) continue;

        const m = pi.metadata || {};
        results.set(pi.id, {
          id: pi.id,
          bar: m.bar || '—',
          staff_name: m.staff_name || '—',
          staff_no: m.staff_no || '',
          from: m.from || 'Anonymous',
          message: m.message || '',
          tip_amount: parseInt(m.tip_amount, 10) || 0,
          fee_amount: parseInt(m.fee_amount, 10) || 0,
          payment_intent: pi.id,
          time: new Date(item.created * 1000).toISOString(),
          done: false
        });
      }

      if (!page.has_more) break;
      const nextCursor = page.data.length && page.data[page.data.length - 1].id;
      if (!nextCursor || nextCursor === cursor) {
        throw new Error('Stripe event pagination did not advance.');
      }
      cursor = nextCursor;
    }

    const orders = Array.from(results.values())
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    return json(200, { orders });
  } catch (err) {
    console.error('dashboard-orders lookup failed:', err);
    // Never turn a partial/failed lookup into a misleading empty order list.
    return json(500, { error: 'Unable to load verified orders. Please retry.' });
  }
};
