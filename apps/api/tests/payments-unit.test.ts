/**
 * PHASE 10 — pure payment rules: configuration validation, signatures, pricing, state
 * transitions and the Razorpay REST gateway (against a stubbed fetch: no network).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { parseEnv } from '../src/config/env.js';
import {
  nextPaymentStatus,
  nextRefundStatus,
  toPaymentStatus,
} from '../src/modules/payments/core.js';
import { PaymentGatewayError, type ProviderPayment } from '../src/modules/payments/gateway.js';
import { newOrderReference } from '../src/modules/payments/orders.service.js';
import { priceCourse } from '../src/modules/payments/pricing.js';
import { createRazorpayGateway } from '../src/modules/payments/razorpay.gateway.js';
import {
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../src/modules/payments/signatures.js';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/asra',
  JWT_SECRET: 'x'.repeat(40),
};
const testKeys = {
  RAZORPAY_TEST_KEY_ID: 'rzp_test_abc123',
  RAZORPAY_TEST_KEY_SECRET: 'secret-test-value',
};
const liveKeys = {
  RAZORPAY_LIVE_KEY_ID: 'rzp_live_abc123',
  RAZORPAY_LIVE_KEY_SECRET: 'secret-live-value',
};
const production = {
  NODE_ENV: 'production',
  EMAIL_TRANSPORT: 'resend',
  EMAIL_API_KEY: 're_x',
  EMAIL_FROM: 'ASRA <no-reply@example.com>',
  CLOUDINARY_CLOUD_NAME: 'asra-cloud',
  CLOUDINARY_API_KEY: '123456789012345',
  CLOUDINARY_API_SECRET: 'secret',
};

function issues(source: Record<string, string | undefined>): string[] {
  const result = parseEnv(source);
  assert.equal(result.success, false, 'expected rejection');
  return result.error!.issues.map((issue) => issue.path.join('.'));
}

describe('Razorpay configuration', () => {
  it('leaves checkout disabled when no mode is set (no implicit test or live mode)', () => {
    const result = parseEnv({ ...base, ...testKeys });
    assert.equal(result.success, true);
    assert.equal(result.data?.RAZORPAY_MODE, undefined);
  });

  it('requires the selected mode to be fully configured', () => {
    assert.deepEqual(issues({ ...base, RAZORPAY_MODE: 'test' }), ['RAZORPAY_TEST_KEY_ID']);
    assert.deepEqual(
      issues({ ...base, RAZORPAY_MODE: 'test', RAZORPAY_TEST_KEY_ID: 'rzp_test_abc' }),
      ['RAZORPAY_TEST_KEY_SECRET', 'RAZORPAY_TEST_KEY_ID'],
    );
    assert.equal(parseEnv({ ...base, RAZORPAY_MODE: 'test', ...testKeys }).success, true);
  });

  it('refuses a key id from the other environment in each slot', () => {
    assert.ok(
      issues({
        ...base,
        RAZORPAY_TEST_KEY_ID: 'rzp_live_abc',
        RAZORPAY_TEST_KEY_SECRET: 's',
      }).includes('RAZORPAY_TEST_KEY_ID'),
    );
    assert.ok(
      issues({
        ...base,
        RAZORPAY_LIVE_KEY_ID: 'rzp_test_abc',
        RAZORPAY_LIVE_KEY_SECRET: 's',
      }).includes('RAZORPAY_LIVE_KEY_ID'),
    );
  });

  it('allows live mode only in production, with a webhook secret', () => {
    assert.deepEqual(
      issues({ ...base, NODE_ENV: 'development', RAZORPAY_MODE: 'live', ...liveKeys }),
      ['RAZORPAY_MODE'],
    );
    assert.deepEqual(issues({ ...base, NODE_ENV: 'test', RAZORPAY_MODE: 'live', ...liveKeys }), [
      'RAZORPAY_MODE',
    ]);
    assert.deepEqual(issues({ ...base, ...production, RAZORPAY_MODE: 'live', ...liveKeys }), [
      'RAZORPAY_LIVE_WEBHOOK_SECRET',
    ]);
    assert.equal(
      parseEnv({
        ...base,
        ...production,
        RAZORPAY_MODE: 'live',
        ...liveKeys,
        RAZORPAY_LIVE_WEBHOOK_SECRET: 'w',
      }).success,
      true,
    );
  });

  it('requires an explicit acknowledgement to run test mode in production (e.g. staging)', () => {
    const staging = {
      ...base,
      ...production,
      RAZORPAY_MODE: 'test',
      ...testKeys,
      RAZORPAY_TEST_WEBHOOK_SECRET: 'w',
    };
    assert.deepEqual(issues(staging), ['RAZORPAY_MODE']);
    assert.equal(
      parseEnv({ ...staging, RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION: 'true' }).success,
      true,
    );
  });

  it('never echoes key or webhook secret values in validation messages', () => {
    const result = parseEnv({
      ...base,
      RAZORPAY_MODE: 'test',
      RAZORPAY_TEST_KEY_ID: 'rzp_live_LEAKCHECK',
      RAZORPAY_TEST_KEY_SECRET: 'SUPERSECRET',
    });
    assert.equal(result.success, false);
    const text = JSON.stringify(result.error!.issues);
    assert.doesNotMatch(text, /LEAKCHECK|SUPERSECRET/);
  });
});

describe('signatures', () => {
  const secret = 'key_secret';
  const hex = (message: string, key = secret) =>
    createHmac('sha256', key).update(message).digest('hex');

  it('verifies the Checkout signature over "order_id|payment_id"', () => {
    const signature = hex('order_ABC123|pay_XYZ789');
    assert.equal(verifyCheckoutSignature(secret, 'order_ABC123', 'pay_XYZ789', signature), true);
    assert.equal(verifyCheckoutSignature(secret, 'order_OTHER1', 'pay_XYZ789', signature), false);
    assert.equal(
      verifyCheckoutSignature(
        secret,
        'order_ABC123',
        'pay_XYZ789',
        hex('order_ABC123|pay_XYZ789', 'wrong'),
      ),
      false,
    );
    for (const malformed of ['', 'abc', 'z'.repeat(64), `${signature}00`]) {
      assert.equal(verifyCheckoutSignature(secret, 'order_ABC123', 'pay_XYZ789', malformed), false);
    }
  });

  it('verifies webhooks over the exact raw bytes', () => {
    const body = '{"event":"payment.captured","payload":{"a":1}}';
    const signature = hex(body, 'whsec');
    assert.equal(verifyWebhookSignature('whsec', Buffer.from(body), signature), true);
    // Same JSON, re-serialised differently: must NOT verify.
    const reserialised = JSON.stringify(JSON.parse(body), null, 1);
    assert.equal(verifyWebhookSignature('whsec', Buffer.from(reserialised), signature), false);
    assert.equal(verifyWebhookSignature('other', Buffer.from(body), signature), false);
  });
});

describe('pricing (integer paise)', () => {
  const course = (
    priceMinor: number | null,
    discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | null = null,
    discountValue: number | null = null,
    currency: string | null = 'INR',
  ) => priceCourse({ priceMinor, currency, discountType, discountValue });

  it('computes payable amounts without floating-point drift', () => {
    assert.equal(course(99_900)?.amountMinor, 99_900);
    assert.equal(course(99_900, 'PERCENTAGE', 10)?.amountMinor, 89_910);
    // 33 % of 99,999 = 32,999.67 → discount rounded DOWN to 32,999.
    assert.deepEqual(
      [
        course(99_999, 'PERCENTAGE', 33)?.discountMinor,
        course(99_999, 'PERCENTAGE', 33)?.amountMinor,
      ],
      [32_999, 67_000],
    );
    assert.equal(course(50_000, 'FIXED_AMOUNT', 70_000)?.amountMinor, 0);
    assert.equal(course(50_000, 'FIXED_AMOUNT', 20_000)?.amountMinor, 30_000);
  });

  it('classifies boundary cases as not payable online', () => {
    assert.equal(course(null), null);
    assert.equal(course(0)?.notPayableReason, 'FREE');
    assert.equal(course(0)?.isFree, true);
    assert.equal(course(50_000, 'PERCENTAGE', 100)?.notPayableReason, 'ZERO_AFTER_DISCOUNT');
    assert.equal(course(50_000, 'FIXED_AMOUNT', 50_000)?.notPayableReason, 'ZERO_AFTER_DISCOUNT');
    assert.equal(course(99)?.notPayableReason, 'BELOW_MINIMUM');
    assert.equal(course(100)?.payable, true);
    assert.equal(course(10_000, null, null, 'USD')?.notPayableReason, 'UNSUPPORTED_CURRENCY');
    assert.equal(course(10_000, 'PERCENTAGE', 101)?.notPayableReason, 'INVALID_PRICE');
    assert.equal(course(-1)?.notPayableReason, 'INVALID_PRICE');
    assert.equal(course(10_000, 'PERCENTAGE', null)?.notPayableReason, 'INVALID_PRICE');
  });
});

describe('state transitions', () => {
  const payment = (
    status: ProviderPayment['status'],
    captured = status === 'captured',
  ): ProviderPayment => ({
    id: 'pay_x',
    orderId: 'order_x',
    status,
    amountMinor: 100,
    currency: 'INR',
    captured,
    method: null,
    amountRefundedMinor: 0,
    errorCode: null,
    errorDescription: null,
  });

  it('maps provider states (a refunded-but-captured payment stays captured)', () => {
    assert.equal(toPaymentStatus(payment('captured')), 'CAPTURED');
    assert.equal(toPaymentStatus(payment('refunded', true)), 'CAPTURED');
    assert.equal(toPaymentStatus(payment('refunded', false)), 'FAILED');
    assert.equal(toPaymentStatus(payment('authorized')), 'AUTHORIZED');
  });

  it('is monotonic: captured is final, stale webhook failures never downgrade', () => {
    assert.equal(nextPaymentStatus('CAPTURED', 'FAILED', 'webhook'), 'CAPTURED');
    assert.equal(nextPaymentStatus('CAPTURED', 'FAILED', 'fetch'), 'CAPTURED');
    assert.equal(nextPaymentStatus('AUTHORIZED', 'FAILED', 'webhook'), 'AUTHORIZED');
    assert.equal(nextPaymentStatus('AUTHORIZED', 'FAILED', 'fetch'), 'FAILED');
    assert.equal(nextPaymentStatus('FAILED', 'CAPTURED', 'webhook'), 'CAPTURED');
    assert.equal(nextRefundStatus('PROCESSED', 'PENDING'), 'PROCESSED');
    assert.equal(nextRefundStatus('REQUESTED', 'PENDING'), 'PENDING');
  });

  it('generates short, unique, receipt-safe order references', () => {
    const refs = new Set(
      Array.from({ length: 500 }, () => newOrderReference(new Date('2026-10-19T00:00:00Z'))),
    );
    assert.equal(refs.size, 500);
    for (const ref of refs) assert.match(ref, /^ASRA-261019-[0-9A-HJKMNP-TV-Z]{8}$/);
  });
});

describe('Razorpay REST gateway', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  it('authenticates with the mode key and sends the server amount', async () => {
    calls.length = 0;
    const gateway = createRazorpayGateway({
      mode: 'TEST',
      keyId: 'rzp_test_K',
      keySecret: 'S3CR3T',
      fetchImpl: respond(200, {
        id: 'order_AAA111',
        amount: 89_910,
        currency: 'INR',
        receipt: 'ASRA-1',
        status: 'created',
      }),
    });
    const order = await gateway.createOrder({
      amountMinor: 89_910,
      currency: 'INR',
      receipt: 'ASRA-1',
      notes: {},
    });
    assert.equal(order.id, 'order_AAA111');
    assert.equal(calls[0]!.url, 'https://api.razorpay.com/v1/orders');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(
      headers.Authorization,
      `Basic ${Buffer.from('rzp_test_K:S3CR3T').toString('base64')}`,
    );
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      amount: 89_910,
      currency: 'INR',
      receipt: 'ASRA-1',
      notes: {},
    });
  });

  it('maps provider failures to safe, classified errors without secrets', async () => {
    const make = (status: number) =>
      createRazorpayGateway({
        mode: 'TEST',
        keyId: 'rzp_test_K',
        keySecret: 'S3CR3T',
        fetchImpl: respond(status, {
          error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
        }),
      });
    const kinds: string[] = [];
    for (const status of [400, 401, 429, 502]) {
      try {
        await make(status).fetchPayment('pay_X1');
        assert.fail('expected failure');
      } catch (error) {
        assert.ok(error instanceof PaymentGatewayError);
        assert.doesNotMatch(`${error.message} ${error.stack}`, /S3CR3T/);
        kinds.push(error.kind);
      }
    }
    assert.deepEqual(kinds, ['REJECTED', 'AUTH', 'UNAVAILABLE', 'UNAVAILABLE']);

    const malformed = createRazorpayGateway({
      mode: 'TEST',
      keyId: 'k',
      keySecret: 's',
      fetchImpl: respond(200, { unexpected: true }),
    });
    await assert.rejects(
      malformed.fetchPayment('pay_X1'),
      (e: unknown) => e instanceof PaymentGatewayError && e.outcomeUnknown,
    );

    const offline = createRazorpayGateway({
      mode: 'TEST',
      keyId: 'k',
      keySecret: 's',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await assert.rejects(
      offline.fetchPayment('pay_X1'),
      (e: unknown) => e instanceof PaymentGatewayError && e.kind === 'NETWORK',
    );
  });
});
