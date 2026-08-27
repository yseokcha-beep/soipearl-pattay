const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
      const now = new Date();
      const monthParam = parseInt((event.queryStringParameters || {}).month, 10);
      const isMonth = Number.isInteger(monthParam) && monthParam >= 1;

      // 대시보드 (파라미터 없음) → 오늘 하루
      // month=N → N개월 누적 (N=1이면 이번 달 1일부터 = 기존 동작 그대로 유지)
      const startDate = isMonth
        ? new Date(now.getFullYear(), now.getMonth() - (monthParam - 1), 1)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const created = Math.floor(startDate.getTime() / 1000);

      // 페이지네이션 (month=N 일때만, 오늘은 그냥 100건으로 충분)
      let allData = [];
      if (isMonth) {
        let lastId = undefined;
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

      const orders = allData
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
