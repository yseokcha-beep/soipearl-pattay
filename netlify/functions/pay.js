'use strict';

// Deploy together with the matching index.html. The old client is rejected.
const crypto = require('node:crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const VERSION = 2;
const BARS = ['Nikki Bar', 'Lollipop', 'PG Bar'];
const CREATE_WINDOW_MS = 23 * 60 * 60 * 1000;
const ORDER_ID = /^v2_(\d{13})_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function reply(statusCode, body) {
  return { statusCode, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }, body: JSON.stringify({ checkoutVersion: VERSION, ...body }) };
}
function invalid(message, code = 400) {
  const error = new Error(message); error.httpStatus = code; throw error;
}
function text(value, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max) invalid('Invalid order details.');
  const result = value.trim();
  if (required && !result) invalid('Please select a staff member.');
  return result;
}
function orderId(value) {
  if (typeof value !== 'string' || !ORDER_ID.test(value)) invalid('A new, explicit order is required.');
  return value;
}
function validateOrder(body) {
  if (!Number.isSafeInteger(body.amount) || body.amount < 20 || body.amount > 100000) {
    invalid('Please enter an amount between 20 and 100,000 THB.');
  }
  if (!BARS.includes(body.bar) || typeof body.isHornPull !== 'boolean') invalid('Please select a bar and an order type.');
  const staffName = text(body.staffName, 50, true);
  const staffNo = text(body.staffNo, 10);
  if (body.isHornPull && (body.amount !== 5250 || staffName !== 'Horn Pull' || staffNo !== '')) invalid('Invalid Horn Pull order.');
  return { amount: body.amount, bar: body.bar, staffName, staffNo,
    fromName: text(body.fromName, 50), message: text(body.message, 100), isHornPull: body.isHornPull };
}
function token(id, intentId) {
  return crypto.createHmac('sha256', process.env.STRIPE_SECRET_KEY)
    .update('soi6-checkout-v2:' + id + ':' + intentId).digest('hex');
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function receipt(intent) {
  const m = intent.metadata || {};
  const amount = Number(m.tip_amount), fee = Number(m.fee_amount);
  if (m.checkout_version !== String(VERSION) || !ORDER_ID.test(m.order_id || '') ||
      !Number.isSafeInteger(amount) || amount < 20 ||
      fee !== Math.ceil(amount * 0.0675 + 10) || intent.currency !== 'thb' ||
      intent.amount !== (amount + fee) * 100) invalid('The order needs manual verification. Please contact the venue.', 409);
  const charge = intent.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  return { amount, fee, total: amount + fee, bar: m.bar, staffName: m.staff_name,
    staffNo: m.staff_no || '', fromName: m.from || '', message: m.message || '',
    isHornPull: m.is_horn_pull === 'true',
    date: new Date((charge ? charge.created : intent.created) * 1000).toISOString() };
}
function result(intent) {
  const r = receipt(intent), id = intent.metadata.order_id;
  return { orderId: id, paymentIntentId: intent.id, status: intent.status,
    clientSecret: intent.client_secret, accessToken: token(id, intent.id), receipt: r };
}
async function retrieve(id) {
  if (typeof id !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(id)) invalid('Invalid payment reference.');
  return stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method Not Allowed' });
  try {
    let body;
    try { body = JSON.parse(event.body); } catch { invalid('Invalid request.'); }
    if (!body || body.checkoutVersion !== VERSION) invalid('Please refresh this page before making a payment.', 409);

    if (body.action === 'create') {
      const id = orderId(body.orderId), order = validateOrder(body);
      const age = Date.now() - Number(ORDER_ID.exec(id)[1]);
      // Stripe keeps idempotency keys for at least 24 h. Never recreate an old
      // order after that retention window; status/cancel remain available by ID.
      if (age < -600000 || age >= CREATE_WINDOW_MS) {
        invalid('This order must be checked with the venue before another payment. Please quote your order reference.', 409);
      }
      const fee = Math.ceil(order.amount * 0.0675 + 10);
      const intent = await stripe.paymentIntents.create({
        amount: (order.amount + fee) * 100, currency: 'thb',
        capture_method: 'automatic', payment_method_types: ['card', 'promptpay'],
        description: `Drink purchase at ${order.bar} for ${order.staffName}`,
        metadata: { checkout_version: String(VERSION), order_id: id,
          bar: order.bar, staff_name: order.staffName, staff_no: order.staffNo,
          from: order.fromName, message: order.message, is_horn_pull: String(order.isHornPull),
          tip_amount: String(order.amount), fee_amount: String(fee) }
      }, { idempotencyKey: 'soi6-create:' + id });
      // A repeated create returns its original cached response. Retrieve the
      // current status so a previously paid order is never presented as unpaid.
      return reply(200, result(await retrieve(intent.id)));
    }

    if (body.action === 'recover') {
      const intent = await retrieve(body.paymentIntentId);
      if (!equal(body.clientSecret, intent.client_secret)) invalid('Invalid payment reference.', 403);
      return reply(200, result(intent));
    }

    if (body.action !== 'status' && body.action !== 'cancel') invalid('Invalid action.');
    const id = orderId(body.orderId);
    if (!equal(body.accessToken, token(id, body.paymentIntentId))) invalid('Invalid payment reference.', 403);
    let intent = await retrieve(body.paymentIntentId);
    if (!intent.metadata || intent.metadata.order_id !== id) invalid('Order reference mismatch.', 409);
    if (body.action === 'cancel' && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)) {
      try {
        await stripe.paymentIntents.cancel(intent.id, {}, { idempotencyKey: 'soi6-cancel:' + id });
      } catch (error) {
        // A payment can finish while cancellation is in flight. Read its final
        // status instead of assuming cancellation succeeded or starting again.
        if (error.type !== 'StripeInvalidRequestError') throw error;
      }
      intent = await retrieve(intent.id);
    }
    return reply(200, result(intent));
  } catch (error) {
    if (error.httpStatus) return reply(error.httpStatus, { error: error.message });
    if (error.type === 'StripeIdempotencyError' || error.code === 'idempotency_key_in_use') {
      return reply(409, { error: 'This order is already being handled. Check its status before retrying.' });
    }
    // A timeout is not evidence of failure. Never tell the client to create a
    // different order, clear its saved reference, or retry with a different key.
    return reply(502, { error: 'Unable to verify this payment. Use Check payment status; do not start another order.' });
  }
};
