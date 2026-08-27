const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');

async function fetchMonthOrders(monthParam) {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - (monthParam - 1), 1);
  const created = Math.floor(startDate.getTime() / 1000);

  let allData = [];
  let lastId;
  while (true) {
    const params = { created: { gte: created }, limit: 100 };
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

// 캐시가 필요한 누적 기간들 (여기 숫자만 추가/삭제하면 됨, 예: OFFICIAL VIP가 나중에 6개월로 바뀌면 6 추가)
const MONTHS_TO_CACHE = [3];

exports.handler = async () => {
  const store = getStore('vip-cache');
  const results = {};

  for (const monthParam of MONTHS_TO_CACHE) {
    try {
      const orders = await fetchMonthOrders(monthParam);
      await store.setJSON(`month-${monthParam}`, { orders, updatedAt: new Date().toISOString() });
      results[monthParam] = `ok (${orders.length} orders)`;
    } catch (err) {
      results[monthParam] = `failed: ${err.message}`;
      console.error(`refresh-vip-cache month=${monthParam} failed:`, err.message);
    }
  }

  console.log('refresh-vip-cache done:', JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify(results) };
};

// Netlify 예약 함수(Scheduled Functions) 설정 — 10분마다 자동 실행
exports.config = {
  schedule: '*/10 * * * *',
};
