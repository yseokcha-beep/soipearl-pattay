const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');

// OFFICIAL VIP season rules:
// - 2026: May 1 through Dec 31 (service began in May)
// - 2027 onward: Jan 1 through Dec 31 automatically
// Cache key remains "month-3" so the existing overlay does NOT need any changes.

function getVipSeasonRange() {
  const now = new Date();
  const year = now.getFullYear();

  // Thailand local midnight expressed with +07:00.
  const start =
    year === 2026
      ? new Date('2026-05-01T00:00:00+07:00')
      : new Date(`${year}-01-01T00:00:00+07:00`);

  // Exclusive upper bound: Jan 1 of next year.
  const endExclusive = new Date(`${year + 1}-01-01T00:00:00+07:00`);

  return { year, start, endExclusive };
}

async function fetchVipSeasonOrders() {
  const { start, endExclusive } = getVipSeasonRange();
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

exports.handler = async () => {
  const store = getStore({
    name: 'vip-cache',
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });

  const { year, start, endExclusive } = getVipSeasonRange();
  const results = {};

  try {
    const orders = await fetchVipSeasonOrders();

    // Keep this legacy cache key unchanged for overlay compatibility.
    await store.setJSON('month-3', {
      orders,
      updatedAt: new Date().toISOString(),
      season: year,
      period: {
        start: start.toISOString(),
        endExclusive: endExclusive.toISOString(),
      },
    });

    results[3] = `ok (${orders.length} orders) — VIP ${year} season`;
  } catch (err) {
    results[3] = `failed: ${err.message}`;
    console.error(`refresh-vip-cache VIP season failed:`, err.message);
  }

  console.log('refresh-vip-cache done:', JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify(results) };
};

// Netlify Scheduled Function — refresh every 10 minutes.
exports.config = {
  schedule: '*/10 * * * *',
};
