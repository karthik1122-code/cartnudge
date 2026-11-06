# WhatsApp message templates

WhatsApp only lets a business start a conversation with a **pre-approved template**. Create these three in
Meta Business Manager → WhatsApp Manager → Message templates. Category: **Utility**. Language: **English (en)**.
The names must match `WA_COD_TEMPLATE` and `WA_CART_TEMPLATE` in `.env`.

Approval usually takes from a few minutes to a day. Until they're approved, keep the app in test mode
(no `WA_PHONE_NUMBER_ID`); messages are logged instead of sent.

## 1. `cod_confirm` (COD confirmation with the pay-online offer)

Body:

```
Hi {{1}}! Thanks for your order {{3}} from {{2}}.

Total: {{4}} · Cash on delivery

Pay online now and save {{5}}. Please choose below so we can ship your order.
```

Buttons (Quick reply, in this order):
1. `Confirm order`
2. `Pay online & save`
3. `Cancel order`

Sample values: Priya · Kesar Threads · #1042 · ₹1,499 · ₹50

## 2. `cod_confirm_basic` (used when the store has no Razorpay keys, or the order is too small for the discount)

Body:

```
Hi {{1}}! Thanks for your order {{3}} from {{2}}.

Total: {{4}} · Cash on delivery

Please confirm so we can ship your order.
```

Buttons (Quick reply, in this order):
1. `Confirm order`
2. `Cancel order`

## 3. `cart_reminder` (abandoned checkout)

Body:

```
Hi {{1}}, you left items worth {{3}} in your cart at {{2}}. They're still saved for you.
```

Button: **Visit website**, dynamic URL, text `Complete my order`, URL:

```
https://YOUR_APP_URL/r/{{1}}
```

(CartNudge fills `{{1}}` with a short code, records the click and redirects to the shopper's checkout.)

## Webhook

In the Meta app → WhatsApp → Configuration:

- Callback URL: `https://YOUR_APP_URL/webhooks/whatsapp`
- Verify token: the value of `WA_VERIFY_TOKEN`
- Subscribe to the **messages** field.
