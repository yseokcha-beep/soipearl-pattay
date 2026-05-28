const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// In-memory store for SSE clients and today's orders
let clients = [];
let todayOrders = [];
let lastDate = new Date().toDateString();

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (today !== lastDate) {
    todayOrders = [];
    lastDate = today;
  }
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(client => {
    try { client.res.write(msg); return true; }
    catch(e) { return false; }
  });
}

// SSE endpoint — dashboard & overlay connect here
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  // GET /events → SSE stream
  if (event.httpMethod === 'GET' && event.path.includes('events')) {
    resetIfNewDay();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
      body: `event: init\ndata: ${JSON.stringify({ orders: todayOrders })}\n\n`,
      isBase64Encoded: false,
    };
  }

  // POST /webhook → Stripe webhook
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
      resetIfNewDay();
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

      todayOrders.unshift(order);
      broadcast('payment', order);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  // PATCH /webhook → mark order as done
  if (event.httpMethod === 'PATCH') {
    const { id } = JSON.parse(event.body || '{}');
    const order = todayOrders.find(o => o.id === id);
    if (order) {
      order.done = true;
      broadcast('done', { id });
    }
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    };
  }

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
