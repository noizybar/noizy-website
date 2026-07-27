// netlify/functions/payment-callback.js
//
// Bank of Georgia calls this URL automatically (server-to-server) once a
// payment finishes. We verify the signature so we know the request really
// came from BOG, then forward the paid order to the same Netlify Forms
// notification (email) already set up for regular orders, so it lands in
// the same inbox.

import crypto from 'crypto';

// BOG's public key, published in their official docs — used only to verify
// that a callback really came from them. Not a secret.
const BOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu4RUyAw3+CdkS3ZNILQh
zHI9Hemo+vKB9U2BSabppkKjzjjkf+0Sm76hSMiu/HFtYhqWOESryoCDJoqffY0Q
1VNt25aTxbj068QNUtnxQ7KQVLA+pG0smf+EBWlS1vBEAFbIas9d8c9b9sSEkTrr
TYQ90WIM8bGB6S/KLVoT1a7SnzabjoLc5Qf/SLDG5fu8dH8zckyeYKdRKSBJKvhx
tcBuHV4f7qsynQT+f2UYbESX/TLHwT5qFWZDHZ0YUOUIvb8n7JujVSGZO9/+ll/g
4ZIWhC1MlJgPObDwRkRd8NFOopgxMcMsDIZIoLbWKhHVq67hdbwpAq9K9WMmEhPn
PwIDAQAB
-----END PUBLIC KEY-----`;

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('Callback-Signature') || '';

  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(rawBody);
    verifier.end();
    const isValid = verifier.verify(BOG_PUBLIC_KEY, signature, 'base64');

    if (!isValid) {
      console.error('Invalid BOG callback signature');
      return new Response('Invalid signature', { status: 400 });
    }

    const data = JSON.parse(rawBody);
    const order = (data && data.body) || {};
    const basket = (order.purchase_units && order.purchase_units.basket) || [];

    const orderText =
      '\u2705 \u10d2\u10d0\u10d3\u10d0\u10ee\u10d3\u10d8\u10da\u10d8\u10d0 \u10d1\u10d0\u10e0\u10d0\u10d7\u10d8\u10d7 \u10dd\u10dc\u10da\u10d0\u10d8\u10dc\n' +
      basket.map((it) => `${it.quantity}x ${it.description || it.product_id}`).join('\n');

    const total = order.purchase_units && order.purchase_units.total_amount;
    const buyerName = (order.buyer && order.buyer.full_name) || '';

    const siteUrl = (process.env.URL || 'https://noizy.netlify.app').replace(/\/$/, '');
    const formBody = new URLSearchParams({
      'form-name': 'noizy-order',
      name: buyerName,
      phone: '',
      delivery_method: '\u10dd\u10dc\u10da\u10d0\u10d8\u10dc \u10d2\u10d0\u10d3\u10d0\u10ee\u10d3\u10d0',
      address: '',
      order: orderText,
      total: total ? `${total}\u20be` : '',
      'bot-field': '',
    });

    await fetch(siteUrl + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });

    // BOG requires HTTP 200 to consider the callback delivered
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('payment-callback error', err);
    return new Response('Error', { status: 500 });
  }
};
