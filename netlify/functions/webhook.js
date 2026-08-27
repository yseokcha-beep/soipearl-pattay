const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');

function mapOrders(data) {
  return data
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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod === 'GET') {
    try {
      const monthParam = parseInt((event.queryStringParameters || {}).month, 10);
      const isMonth = Number.isInteger(monthParam) && monthParam >= 1;

      if (isMonth && monthParam >= 2) {
        // 2개월 이상 누적은 데이터가 많아서 매번 Stripe를 라이브로 페이지네이션하면
        // 타임아웃(502) 남 → refresh-vip-cache 함수가 주기적으로 미리 계산해서
        // 저장해둔 캐시를 그대로 서빙 (즉시 응답, 타임아웃 없음)
        const store = getStore({
          name: 'vip-cache',
          siteID: process.env.BLOBS_SITE_ID,
          token: process.env.BLOBS_TOKEN,
        });
        const cached = await store.get(`month-${monthParam}`, { type: 'json' });
        return {
          statusCode: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(cached || { orders: [] }),
        };
      }

      // month=1(이번달) 또는 대시보드(오늘 하루) — 데이터量 적어서 기존처럼 실시간 조회
      const now = new Date();
      const startDate = isMonth
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const created = Math.floor(startDate.getTime() / 1000);

      let allData = [];
      if (isMonth) {
        let lastId;
        while (true) {
          const params = { created: { gte: created }, limit: 100 };
          if (lastId) params.starting_after = lastId;
          const page = await stripe.paymentIntents.list(params);
          allData = allData.concat(page.data);
          if (!page.has_more) break;
          lastId = page.data[page.data.length - 1].id;
        }
      } else {
        const page = await stripe.paymentIntents.list({ created: { gte: created }, limit: 100 });
        allData = page.data;
      }

      const orders = mapOrders(allData);

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders }),
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  if (event.httpMethod === 'POST') {
    const sig = event.headers['stripe-signature'];
    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }
    if (stripeEvent.type === 'payment_intent.succeeded') {
      console.log('Payment succeeded:', stripeEvent.data.object.id);
    }
    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
