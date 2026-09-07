import crypto from 'crypto';
import { env, razorpayConfigured } from '../config/env';
import { logger } from '../config/logger';
import { toPaise } from '../utils/money';
import { ApiError, ERROR_CODES } from '../utils/apiError';

/**
 * Payment gateway abstraction (spec section 20).
 *
 * Two adapters implement the same interface:
 *   - `razorpay` for real payments
 *   - `mock`     so the whole checkout flow, including the COD advance, can be
 *                exercised locally without gateway credentials
 *
 * The key id is public and safe to hand to the app. The key *secret* is used
 * only here, server-side, and is never included in any response.
 */

export interface CreateGatewayOrderParams {
  /** Amount in rupees. Converted to the gateway's minor unit internally. */
  amount: number;
  receipt: string;
  notes?: Record<string, string>;
}

export interface GatewayOrder {
  provider: string;
  providerOrderId: string;
  /** Minor units (paise) as the gateway reports them. */
  amountMinor: number;
  currency: string;
  /** Public key the client SDK needs. Never the secret. */
  publicKey: string;
  receipt: string;
}

export interface VerifySignatureParams {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface FetchedPayment {
  providerPaymentId: string;
  providerOrderId: string | null;
  /** Minor units captured by the gateway. */
  amountMinor: number;
  currency: string;
  status: string;
  captured: boolean;
  method?: string | null;
  bank?: string | null;
  wallet?: string | null;
  vpa?: string | null;
  cardLast4?: string | null;
  failureReason?: string | null;
}

interface GatewayAdapter {
  readonly name: string;
  readonly publicKey: string;
  createOrder(params: CreateGatewayOrderParams): Promise<GatewayOrder>;
  verifySignature(params: VerifySignatureParams): boolean;
  fetchPayment(providerPaymentId: string): Promise<FetchedPayment>;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  refund(providerPaymentId: string, amount: number, notes?: Record<string, string>): Promise<{ refundId: string }>;
}

// ---------------------------------------------------------------------------
// Razorpay adapter
// ---------------------------------------------------------------------------

class RazorpayAdapter implements GatewayAdapter {
  readonly name = 'razorpay';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  constructor() {
    if (!razorpayConfigured) {
      throw new Error('Razorpay selected as PAYMENT_PROVIDER but RAZORPAY_KEY_ID/SECRET are not set');
    }
    // Required lazily so a `mock` deployment never needs the SDK installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const Razorpay = require('razorpay');
    this.client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  }

  get publicKey(): string {
    return env.RAZORPAY_KEY_ID;
  }

  async createOrder(params: CreateGatewayOrderParams): Promise<GatewayOrder> {
    const amountMinor = toPaise(params.amount);
    if (amountMinor <= 0) throw ApiError.badRequest('Payment amount must be greater than zero');

    const order = await this.client.orders.create({
      amount: amountMinor,
      currency: env.PAYMENT_CURRENCY,
      receipt: params.receipt,
      notes: params.notes ?? {},
      payment_capture: 1,
    });

    return {
      provider: this.name,
      providerOrderId: order.id,
      amountMinor: Number(order.amount),
      currency: order.currency,
      publicKey: this.publicKey,
      receipt: params.receipt,
    };
  }

  /**
   * HMAC-SHA256 of `order_id|payment_id` keyed with the secret - Razorpay's
   * documented handshake. Compared in constant time.
   */
  verifySignature(params: VerifySignatureParams): boolean {
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${params.providerOrderId}|${params.providerPaymentId}`)
      .digest('hex');
    return timingSafeEqualHex(expected, params.signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    return timingSafeEqualHex(expected, signature);
  }

  async fetchPayment(providerPaymentId: string): Promise<FetchedPayment> {
    const payment = await this.client.payments.fetch(providerPaymentId);
    return {
      providerPaymentId: payment.id,
      providerOrderId: payment.order_id ?? null,
      amountMinor: Number(payment.amount),
      currency: payment.currency,
      status: payment.status,
      captured: Boolean(payment.captured) || payment.status === 'captured',
      method: payment.method ?? null,
      bank: payment.bank ?? null,
      wallet: payment.wallet ?? null,
      vpa: payment.vpa ?? null,
      cardLast4: payment.card?.last4 ?? null,
      failureReason: payment.error_description ?? null,
    };
  }

  async refund(providerPaymentId: string, amount: number, notes?: Record<string, string>) {
    const refund = await this.client.payments.refund(providerPaymentId, {
      amount: toPaise(amount),
      notes: notes ?? {},
    });
    return { refundId: refund.id };
  }
}

// ---------------------------------------------------------------------------
// Mock adapter (development / automated tests)
// ---------------------------------------------------------------------------

/**
 * Simulates a gateway well enough to exercise the real verification path: it
 * still signs, and the server still checks that signature and the amount. What
 * it does not do is move money.
 *
 * The mock secret is derived from the JWT secret rather than being a constant,
 * so a signature produced against one environment cannot be replayed against
 * another.
 */
class MockAdapter implements GatewayAdapter {
  readonly name = 'mock';

  private readonly secret = crypto
    .createHash('sha256')
    .update(`mock-gateway:${env.JWT_ACCESS_SECRET}`)
    .digest('hex');

  private readonly store = new Map<string, { amountMinor: number; receipt: string }>();

  get publicKey(): string {
    return 'mock_public_key';
  }

  async createOrder(params: CreateGatewayOrderParams): Promise<GatewayOrder> {
    const amountMinor = toPaise(params.amount);
    if (amountMinor <= 0) throw ApiError.badRequest('Payment amount must be greater than zero');
    const providerOrderId = `mock_order_${crypto.randomBytes(10).toString('hex')}`;
    this.store.set(providerOrderId, { amountMinor, receipt: params.receipt });
    logger.warn(`[payment] MOCK gateway order ${providerOrderId} for ${params.amount}`);
    return {
      provider: this.name,
      providerOrderId,
      amountMinor,
      currency: env.PAYMENT_CURRENCY,
      publicKey: this.publicKey,
      receipt: params.receipt,
    };
  }

  /** Exposed so the dev-only "simulate success" endpoint can produce a valid pair. */
  signPayload(providerOrderId: string, providerPaymentId: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${providerOrderId}|${providerPaymentId}`)
      .digest('hex');
  }

  verifySignature(params: VerifySignatureParams): boolean {
    return timingSafeEqualHex(
      this.signPayload(params.providerOrderId, params.providerPaymentId),
      params.signature,
    );
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex');
    return timingSafeEqualHex(expected, signature);
  }

  async fetchPayment(providerPaymentId: string): Promise<FetchedPayment> {
    // The mock payment id embeds the order id it belongs to.
    const orderId = providerPaymentId.replace(/^mock_pay_/, 'mock_order_').split('__')[0];
    const record = this.store.get(orderId);
    return {
      providerPaymentId,
      providerOrderId: record ? orderId : null,
      amountMinor: record?.amountMinor ?? 0,
      currency: env.PAYMENT_CURRENCY,
      status: 'captured',
      captured: true,
      method: 'upi',
      vpa: 'test@mock',
      failureReason: null,
    };
  }

  async refund(providerPaymentId: string, _amount: number) {
    return { refundId: `mock_rfnd_${crypto.randomBytes(8).toString('hex')}` };
  }

  /** Deterministic payment id for a given gateway order, used by the simulator. */
  makePaymentId(providerOrderId: string): string {
    return `${providerOrderId.replace(/^mock_order_/, 'mock_pay_')}__${crypto
      .randomBytes(4)
      .toString('hex')}`;
  }
}

function timingSafeEqualHex(expected: string, received: string): boolean {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let adapter: GatewayAdapter | null = null;

export function gateway(): GatewayAdapter {
  if (!adapter) {
    adapter = env.PAYMENT_PROVIDER === 'razorpay' ? new RazorpayAdapter() : new MockAdapter();
    logger.info(`[payment] gateway adapter: ${adapter.name}`);
  }
  return adapter;
}

export function isMockGateway(): boolean {
  return gateway().name === 'mock';
}

export function mockAdapter(): MockAdapter {
  const g = gateway();
  if (!(g instanceof MockAdapter)) {
    throw ApiError.forbidden('Payment simulation is only available on the mock gateway');
  }
  return g;
}

/**
 * The verification everything else depends on (RULE 16).
 *
 * Both halves matter and both are done server-side:
 *   1. the signature proves the gateway - not the client - produced this result
 *   2. the captured amount is compared against the amount *we* recorded when we
 *      created the transaction, so a tampered "I paid ₹1" is rejected
 */
export async function verifyGatewayPayment(params: {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
  /** Amount in rupees that this transaction was created for. */
  expectedAmount: number;
  /**
   * Set ONLY by the webhook handler, and only after it has already verified the
   * gateway's HMAC over the raw request body.
   *
   * The handshake signature and the webhook signature prove the same thing -
   * that the gateway, not the client, produced this result - so requiring both
   * would be theatre: a real gateway does not include the handshake signature in
   * its webhook payload, and the server cannot invent one. The substantive
   * checks below (fetch the payment from the gateway's own API, confirm it was
   * captured, compare the amount against what we recorded) still run in full.
   */
  originAlreadyVerified?: boolean;
}): Promise<FetchedPayment> {
  const g = gateway();

  if (!params.originAlreadyVerified && !g.verifySignature(params)) {
    logger.warn('[payment] signature verification failed', { providerOrderId: params.providerOrderId });
    throw new ApiError(
      400,
      'We could not verify this payment. If money was deducted it will be refunded automatically.',
      ERROR_CODES.PAYMENT_VERIFICATION_FAILED,
    );
  }

  const fetched = await g.fetchPayment(params.providerPaymentId);

  if (fetched.providerOrderId && fetched.providerOrderId !== params.providerOrderId) {
    throw new ApiError(
      400,
      'This payment belongs to a different order',
      ERROR_CODES.PAYMENT_VERIFICATION_FAILED,
    );
  }

  if (!fetched.captured || !['captured', 'authorized'].includes(fetched.status)) {
    throw new ApiError(
      402,
      fetched.failureReason ?? 'The payment was not completed',
      ERROR_CODES.PAYMENT_FAILED,
    );
  }

  const expectedMinor = toPaise(params.expectedAmount);
  if (fetched.amountMinor < expectedMinor) {
    logger.error('[payment] amount mismatch', {
      providerOrderId: params.providerOrderId,
      expectedMinor,
      receivedMinor: fetched.amountMinor,
    });
    throw new ApiError(
      400,
      'The amount paid does not match the order amount',
      ERROR_CODES.PAYMENT_VERIFICATION_FAILED,
    );
  }

  return fetched;
}

/** Strips card/UPI detail before a gateway payload is persisted or logged. */
export function redactGatewayPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  const banned = new Set(['card', 'token', 'signature', 'notes', 'acquirer_data']);
  for (const [key, value] of Object.entries(payload)) {
    if (banned.has(key)) continue;
    if (typeof value === 'object' && value !== null) continue;
    clone[key] = value;
  }
  return clone;
}
