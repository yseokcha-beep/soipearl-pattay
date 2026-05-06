const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
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
        tip_amount: amount,
        fee_amount: fee,
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        clientSecret: paymentIntent.client_secret 
      })
    };
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: err.message })
    };
  }
};
