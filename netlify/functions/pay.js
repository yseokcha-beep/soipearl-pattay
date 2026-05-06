const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { amount, bar, staffName, staffNo, fromName, message } = JSON.parse(event.body);

    if (!amount || amount < 20) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid payment details' })
      };
    }

    const fee = Math.ceil(amount * 0.0675 + 10);
    const total = amount + fee;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: total * 100,
      currency: 'thb',
      automatic_payment_methods: { enabled: true },
      description: `Drink purchase at ${bar} for ${staffName}`,
      metadata: {
        bar: bar || '',
        staff_name: staffName || '',
        staff_no: staffNo || '',
        from: fromName || 'Anonymous',
        message: message || '',
        tip_amount: String(amount),
        fee_amount: String(fee),
      }
    });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret
      })
    };

  } catch (err) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
