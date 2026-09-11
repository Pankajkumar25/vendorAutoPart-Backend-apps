import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';

import { env, corsOrigins } from './config/env';
import { requestId, requestLogger } from './middleware/request.middleware';
import { generalLimiter } from './middleware/rateLimit.middleware';
import { asyncHandler } from './middleware/asyncHandler';
import notFoundHandler from './middleware/notFound.middleware';
import { errorHandler } from './middleware/error.middleware';
import apiRouter from './routes';
import { handleWebhook } from './controllers/payment.controller';

/**
 * Express application assembly (spec sections 44, 45).
 *
 * The middleware order here is load-bearing, not cosmetic:
 *   - security & transport (helmet, cors, compression) wrap everything;
 *   - the payment webhook is mounted with a RAW body parser BEFORE `express.json`
 *     and ahead of the API router, so signature verification sees the exact
 *     bytes the gateway signed and the gateway is never blocked by auth or
 *     maintenance mode (RULE 16);
 *   - body parsing, then injection hardening (`express-mongo-sanitize`, `hpp`);
 *   - a global rate limiter, then the versioned API;
 *   - 404 and the central error handler last, so every thrown `ApiError` and
 *     every stray rejection lands in one place and leaks nothing (spec 45).
 */
const app = express();

// Behind a reverse proxy in production; a fixed hop count keeps the client IP
// trustworthy for rate limiting without the permissive-trust-proxy footgun.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(compression());

app.use(requestId);
app.use(requestLogger);

// --- Payment webhook (raw body, before JSON parsing, outside the API guards) ---
app.post(
  `${env.API_PREFIX}/payments/webhook`,
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(handleWebhook),
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Strip `$`/`.` operators from user input and collapse duplicated query params
// so `?role=user&role=admin` can never smuggle an array past a scalar check.
app.use(mongoSanitize());
app.use(hpp());

// Baseline abuse guard; the stricter per-route limiters (auth, otp, payment,
// search, upload, order) stack on top of this inside their routers.
app.use(env.API_PREFIX, generalLimiter, apiRouter);

// --- Razorpay web checkout page (for Expo Go) ---
app.get('/pay', (req, res) => {
  const key = req.query.key as string;
  const orderId = req.query.order_id as string;
  const amount = req.query.amount as string;
  const currency = (req.query.currency as string) || 'INR';
  const name = (req.query.name as string) || 'AutoParts Store';
  const description = (req.query.description as string) || 'Order Payment';
  const prefillContact = (req.query.contact as string) || '';
  const sessionId = req.query.session_id as string;
  const callbackUrl = (req.query.callback_url as string) || `${req.protocol}://${req.get('host')}/pay/callback`;

  res.send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Payment</title>
  <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
  .box{text-align:center;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .spinner{width:36px;height:36px;border:3px solid #ddd;border-top-color:#4F46E5;border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 1rem}
  @keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body>
  <div class="box"><div class="spinner"></div><p>Opening payment...</p></div>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var rzp = new Razorpay({
      key: '${key}',
      amount: ${amount},
      currency: '${currency}',
      name: '${name}',
      description: '${description}',
      order_id: '${orderId}',
      handler: function(response) {
        window.location.href = '${callbackUrl}?session_id=${sessionId}&provider_order_id=' + response.razorpay_order_id + '&provider_payment_id=' + response.razorpay_payment_id + '&signature=' + response.razorpay_signature;
      },
      prefill: { contact: '${prefillContact}' },
      theme: { color: '#4F46E5' },
      modal: {
        ondismiss: function() {
          window.location.href = '${callbackUrl}?session_id=${sessionId}&cancelled=true';
        }
      }
    });
    rzp.open();
  </script>
</body></html>`);
});

app.get('/pay/callback', (req, res) => {
  const sessionId = req.query.session_id as string;
  const cancelled = req.query.cancelled === 'true';
  const providerOrderId = req.query.provider_order_id as string || '';
  const providerPaymentId = req.query.provider_payment_id as string || '';
  const signature = req.query.signature as string || '';

  if (cancelled) {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Cancelled</title></head><body style="font-family:sans-serif;text-align:center;padding:3rem">
    <h2>Payment cancelled</h2><p>You can try again from the app.</p>
    <script>setTimeout(function(){window.close()},1500)</script>
    </body></html>`);
    return;
  }

  // Redirect back to app via deep link with payment details
  const deepLink = `autoparts://checkout-confirm?session_id=${sessionId}&provider_order_id=${providerOrderId}&provider_payment_id=${providerPaymentId}&signature=${signature}`;

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Payment Done</title></head><body style="font-family:sans-serif;text-align:center;padding:3rem">
  <h2 style="color:green">Payment successful!</h2><p>Returning to app...</p>
  <script>window.location.href = '${deepLink}'; setTimeout(function(){window.close()},3000)</script>
  </body></html>`);
});

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
