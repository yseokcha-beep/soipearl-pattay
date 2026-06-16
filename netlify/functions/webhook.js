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

  // GET → 오늘 결제 목록 Stripe에서 직접 조회
  if (event.httpMethod === 'GET') {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); // 이번 달 1일
      const created = Math.floor(startOfMonth.getTime() / 1000);

      const paymentIntents = await stripe.paymentIntents.list({
        created: { gte: created },
        limit: 100,
      });

      const orders = paymentIntents.data
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

  // POST → Stripe 웹훅 (확인용)
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
