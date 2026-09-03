const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');

// OFFICIAL VIP monthly persistent cache.
// Overlay/webhook compatibility stays unchanged:
// overlay -> webhook?month=3 -> cache key "month-3"
//
// Season rules:
// 2026: May 1-Dec 31
// 2027+: Jan 1-Dec 31 automatically
//
// Completed months are fetched once and stored.
// Current month refreshes every 10 minutes.
// During first migration, only ONE missing completed month is backfilled per run.
// Existing month-3 is not overwritten until all completed months exist.

function thailandParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = type => Number(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function monthKey(year, month) {
  return `vip-${year}-${String(month).padStart(2, '0')}`;
}

function monthRange(year, month) {
  const mm = String(month).padStart(2, '0');
  const start = new Date(`${year}-${mm}-01T00:00:00+07:00`);

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMM = String(nextMonth).padStart(2, '0');
  const endExclusive = new Date(`${nextYear}-${nextMM}-01T00:00:00+07:00`);

  return { start, endExclusive };
}

function seasonMonths() {
  const now = thailandParts();
  const startMonth = now.year === 2026 ? 5 : 1;
  const months = [];

  for (let m = startMonth; m <= now.month; m++) {
    months.push({ year: now.year, month: m });
  }

  return {
    seasonYear: now.year,
    currentMonth: now.month,
    months,
  };
}

async function fetchStripeMonth(year, month) {
  const { start, endExclusive } = monthRange(year, month);
  const createdGte = Math.floor(start.getTime() / 1000);
  const createdLt = Math.floor(endExclusive.getTime() / 1000);

  let allData = [];
  let lastId;

  while (true) {
    const params = {
      created: { gte: createdGte, lt: createdLt },
      limit: 100,
    };
    if (lastId) params.starting_after = lastId;

    const page = await stripe.paymentIntents.list(params);
    allData = allData.concat(page.data);

    if (!page.has_more) break;
    lastId = page.data[page.data.length - 1].id;
  }

  return allData
    .filter(pi => pi.status === 'succeeded')
    .map(pi => {
      const m = pi.metadata || {};
      return {
        id: pi.id,
        bar: m.bar || '—',
        staff_name: m.staff_name || '—',
        staff_no: m.staff_no || '',
        from: m.from || 'Anonymous',
        message: m.message || '',
        tip_amount: parseInt(m.tip_amount) || 0,
        fee_amount: parseInt(m.fee_amount) || 0,
        payment_intent: pi.id,
        time: new Date(pi.created * 1000).toISOString(),
        done: false,
      };
    });
}

async function getJson(store, key) {
  return await store.get(key, { type: 'json' });
}

exports.handler = async () => {
  const store = getStore({
    name: 'vip-cache',
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });

  try {
    const { seasonYear, currentMonth, months } = seasonMonths();

    // Backfill only one missing completed month per invocation.
    for (const item of months) {
      if (item.month === currentMonth) continue;

      const key = monthKey(item.year, item.month);
      const cached = await getJson(store, key);

      if (!cached || !Array.isArray(cached.orders)) {
        const orders = await fetchStripeMonth(item.year, item.month);

        await store.setJSON(key, {
          orders,
          year: item.year,
          month: item.month,
          completed: true,
          updatedAt: new Date().toISOString(),
        });

        const result = {
          status: 'backfill_progress',
          season: seasonYear,
          saved: key,
          orders: orders.length,
          message: 'One completed month cached. Run again or wait for next scheduled run.',
        };

        console.log('refresh-vip-cache:', JSON.stringify(result));
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        };
      }
    }

    // All completed months are ready: refresh current month only.
    const currentKey = monthKey(seasonYear, currentMonth);
    const currentOrders = await fetchStripeMonth(seasonYear, currentMonth);

    await store.setJSON(currentKey, {
      orders: currentOrders,
      year: seasonYear,
      month: currentMonth,
      completed: false,
      updatedAt: new Date().toISOString(),
    });

    // Merge all monthly caches.
    let mergedOrders = [];
    const monthSummary = {};

    for (const item of months) {
      const key = monthKey(item.year, item.month);
      const cached = await getJson(store, key);
      const orders = cached && Array.isArray(cached.orders) ? cached.orders : [];

      mergedOrders = mergedOrders.concat(orders);
      monthSummary[key] = orders.length;
    }

    // Deduplicate by PaymentIntent id.
    const unique = new Map();
    for (const order of mergedOrders) {
      if (order && order.id) unique.set(order.id, order);
    }
    mergedOrders = Array.from(unique.values());

    // Keep the legacy key so the existing overlay/webhook do not change.
    await store.setJSON('month-3', {
      orders: mergedOrders,
      updatedAt: new Date().toISOString(),
      season: seasonYear,
      cacheMode: 'monthly-persistent',
      months: monthSummary,
    });

    const result = {
      status: 'ready',
      season: seasonYear,
      totalOrders: mergedOrders.length,
      months: monthSummary,
      message: 'month-3 cache updated successfully.',
    };

    console.log('refresh-vip-cache done:', JSON.stringify(result));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('refresh-vip-cache failed:', err);

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'failed',
        error: err.message,
      }),
    };
  }
};

exports.config = {
  schedule: '*/10 * * * *',
};
