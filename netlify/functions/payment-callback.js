// netlify/functions/payment-callback.js
//
// Bank of Georgia calls this URL automatically (server-to-server) once a
// payment finishes. We verify the signature so we know the request really
// came from BOG, then — only for confirmed successful payments — look up
// the full order (name/phone/address) that create-order.js stashed, and
// forward it to the same Netlify Forms notification (email) already set up
// for regular orders. Nothing is ever sent to the kitchen before payment
// is actually confirmed.

import crypto from 'crypto';
import { getStore } from '@netlify/blobs';

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

    // Only notify the kitchen for actual successful payments — the same
    // callback URL also fires for refunds and other events, and we must
    // never let the kitchen start making food for a payment that never
    // completed (or that was later refunded).
    const statusKey = order.order_status && order.order_status.key;
    if (statusKey !== 'completed') {
      console.log('Callback received for non-completed status, ignoring:', statusKey);
      return new Response('OK (ignored, status=' + statusKey + ')', { status: 200 });
    }

    const orderId = order.order_id;
    let stashed = null;
    try {
      const store = getStore('pending-orders');
      stashed = orderId ? await store.get(orderId, { type: 'json' }) : null;
    } catch (blobErr) {
      console.error('Failed to read stashed order', blobErr);
    }

    // Fallback to whatever BOG itself sent, in case the stash was missed.
    const items = (order.purchase_units && order.purchase_units.items) || [];
    const fallbackOrderText =
      items.map((it) => `${it.quantity}x ${it.description || it.external_item_id}`).join('\n') ||
      '(\u10d3\u10d4\u10e2\u10d0\u10da\u10d4\u10d1\u10d8 \u10ec\u10d0\u10db\u10dd\u10d5\u10d0 \u2014 \u10e8\u10d5\u10d4\u10dc\u10d8\u10da\u10d8 \u10d3\u10d0\u10db\u10d0\u10d3\u10d4\u10d1\u10e3\u10da\u10d8 \u10d0\u10ee\u10da\u10d0\u10ee\u10da\u10d0\u10d5\u10d4)';
    const fallbackTotal = order.purchase_units && order.purchase_units.request_amount;
    const fallbackName = (order.buyer && order.buyer.full_name) || '';
    const fallbackPhone = (order.buyer && order.buyer.phone_number) || '';

    const name = stashed ? stashed.name : fallbackName;
    const phone = stashed ? stashed.phone : fallbackPhone;
    const address = stashed ? stashed.address : '';
    const deliveryLabel = stashed ? stashed.deliveryLabel : '';
    const orderText = stashed ? stashed.orderText : fallbackOrderText;
    const total = stashed ? stashed.total : fallbackTotal ? `${fallbackTotal}\u20be` : '';

    const siteUrl = (process.env.URL || 'https://noizy.netlify.app').replace(/\/$/, '');
    const formBody = new URLSearchParams({
      'form-name': 'noizy-order',
      name,
      phone,
      delivery_method:
        (deliveryLabel || '\u10dd\u10dc\u10da\u10d0\u10d8\u10dc \u10d2\u10d0\u10d3\u10d0\u10ee\u10d3\u10d0') +
        ' \u2014 \u2705 \u10d2\u10d0\u10d3\u10d0\u10ee\u10d3\u10d8\u10da\u10d8 \u10d1\u10d0\u10e0\u10d0\u10d7\u10d8\u10d7',
      address,
      order: orderText,
      total,
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
