const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');

function getTodayKey() {
  const d = new Date();
  return `orders-${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

async function getOrders(store) {
  try {
    const raw = await store.get(getTodayKey());
    if (!raw) return [];
    return JSON.parse(raw);
  } catch(e) { return []; }
}

async function saveOrders(store, orders) {
  await store.set(getTodayKey(), JSON.stringify(orders));
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

  const store = getStore({ name: 'orders', consistency: 'strong' });

  // GET → 오늘 주문 목록 반환
  if (event.httpMethod === 'GET') {
    const orders = await getOrders(store);
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders }),
    };
  }

  // PATCH → 주문 done 처리
  if (event.httpMethod === 'PATCH') {
    const { id } = JSON.parse(event.body || '{}');
    const orders = await getOrders(store);
    const order = orders.find(o => o.id === id);
    if (order) {
      order.done = true;
      await saveOrders(store, orders);
    }
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  // POST → Stripe 웹훅
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
      console.error('Webhook signature error:', err.message);
      return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    if (stripeEvent.type === 'payment_intent.succeeded') {
      const pi = stripeEvent.data.object;
      const m = pi.metadata || {};

      const order = {
        id: pi.id,
        bar: m.bar || '—',
        staff_name: m.staff_name || '—',
        staff_no: m.staff_no || '',
        from: m.from || 'Anonymous',
        message: m.message || '',
        tip_amount: parseInt(m.tip_amount) || 0,
        fee_amount: parseInt(m.fee_amount) || 0,
        payment_intent: pi.id,
        time: new Date().toISOString(),
        done: false,
      };

      const orders = await getOrders(store);
      orders.unshift(order);
      await saveOrders(store, orders);

      console.log('Order saved:', order.id, order.from, '→', order.staff_name);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
