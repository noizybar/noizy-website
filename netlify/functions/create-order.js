// netlify/functions/create-order.js
//
// Receives the cart from the browser, securely authenticates with Bank of
// Georgia using the CLIENT_ID / CLIENT_SECRET (kept only on the server, via
// Netlify environment variables — never sent to the browser), creates a
// payment order, and returns the URL the customer should be redirected to
// in order to pay.
//
// The full order (including delivery address, which BOG's API has no field
// for) is stashed in Netlify Blobs, keyed by the order id. It is only
// released to the kitchen by payment-callback.js, and only once BOG
// confirms the payment actually succeeded — never before.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { items, total, name, phone, deliveryLabel, address } = await req.json();

    if (!Array.isArray(items) || items.length === 0 || !total) {
      return new Response(JSON.stringify({ error: 'Empty order' }), { status: 400 });
    }

    const clientId = process.env.BOG_CLIENT_ID;
    const clientSecret = process.env.BOG_CLIENT_SECRET;
    const siteUrl = (process.env.URL || 'https://noizy.netlify.app').replace(/\/$/, '');

    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: 'Server not configured' }), { status: 500 });
    }

    // 1. Authenticate (OAuth2 client_credentials)
    const authRes = await fetch(
      'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      }
    );
    const authData = await authRes.json();
    if (!authRes.ok || !authData.access_token) {
      console.error('BOG auth failed', authData);
      return new Response(JSON.stringify({ error: 'Payment auth failed' }), { status: 502 });
    }

    // 2. Create the order
    const basket = items.map((item, idx) => ({
      product_id: 'item-' + idx,
      description: String(item.en || 'Item').slice(0, 120),
      quantity: Number(item.qty) || 1,
      unit_price: Number(item.price) || 0,
    }));

    const orderPayload = {
      callback_url: `${siteUrl}/.netlify/functions/payment-callback`,
      external_order_id: 'noizy-' + Date.now(),
      purchase_units: {
        currency: 'GEL',
        total_amount: Number(total),
        basket,
      },
      redirect_urls: {
        success: `${siteUrl}/?payment=success`,
        fail: `${siteUrl}/?payment=fail`,
      },
      buyer: {
        full_name: name || undefined,
      },
    };

    const orderRes = await fetch('https://api.bog.ge/payments/v1/ecommerce/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authData.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'ka',
      },
      body: JSON.stringify(orderPayload),
    });
    const orderData = await orderRes.json();

    if (!orderRes.ok || !orderData._links || !orderData._links.redirect) {
      console.error('BOG order creation failed', orderData);
      return new Response(JSON.stringify({ error: 'Order creation failed' }), { status: 502 });
    }

    // 3. Stash the full order (incl. address) for payment-callback.js to
    // release ONLY once payment is confirmed. Never sent to the kitchen yet.
    try {
      const orderText = items
        .map((i) => `${i.qty}x ${i.en} \u2014 ${(i.qty * i.price).toFixed(2).replace(/\.00$/, '')}\u20be`)
        .join('\n');
      const store = getStore('pending-orders');
      await store.setJSON(orderData.id, {
        name: name || '',
        phone: phone || '',
        deliveryLabel: deliveryLabel || '',
        address: address || '',
        orderText,
        total: Number(total).toFixed(2).replace(/\.00$/, '') + '\u20be',
      });
    } catch (stashErr) {
      // Non-fatal: worst case the callback notification has less detail.
      console.error('Failed to stash order details', stashErr);
    }

    return new Response(
      JSON.stringify({
        redirectUrl: orderData._links.redirect.href,
        orderId: orderData.id,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('create-order error', err);
    return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
  }
};
