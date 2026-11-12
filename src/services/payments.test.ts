import { describe, expect, it } from 'vitest';
import { planCancellation } from './paymentSideEffects';
import { normalizeTamaraPhone, tamaraAmountAllowed, vatPortion } from './tamara';
import { toPaymobPhone } from './paymob';
import { verifyWebhookSignature } from './whatsapp';

describe('payment side-effect routing', () => {
  it('cancels authorised Tamara orders; captured ones need a manual refund', () => {
    expect(planCancellation({ provider: 'tamara', paymentStatus: 'paid', captured: false })).toBe(
      'tamara_cancel',
    );
    expect(planCancellation({ provider: 'tamara', paymentStatus: 'paid', captured: true })).toBe(
      'manual_refund_required',
    );
  });

  it('flags paid Paymob cancellations for manual refund and ignores unpaid/COD', () => {
    expect(planCancellation({ provider: 'paymob', paymentStatus: 'paid', captured: false })).toBe(
      'manual_refund_required',
    );
    expect(planCancellation({ provider: 'paymob', paymentStatus: 'failed', captured: false })).toBe(
      null,
    );
    expect(
      planCancellation({ provider: 'cash_on_delivery', paymentStatus: 'paid', captured: false }),
    ).toBe(null);
  });
});

describe('Tamara helpers', () => {
  it('normalizes Saudi phones to the 9-digit local format', () => {
    expect(normalizeTamaraPhone('0501234567')).toBe('501234567');
    expect(normalizeTamaraPhone('+966 50 123 4567')).toBe('501234567');
    expect(normalizeTamaraPhone('966501234567')).toBe('501234567');
  });

  it('enforces the configured amount range (0 = unbounded)', () => {
    expect(tamaraAmountAllowed(100, 0, 0)).toBe(true);
    expect(tamaraAmountAllowed(50, 100, 0)).toBe(false);
    expect(tamaraAmountAllowed(5000, 100, 4000)).toBe(false);
    expect(tamaraAmountAllowed(0, 0, 0)).toBe(false);
  });

  it('extracts VAT from VAT-inclusive totals', () => {
    expect(vatPortion(115, 0.15)).toBe(15);
    expect(vatPortion(115, 0)).toBe(0);
  });
});

describe('Paymob helpers', () => {
  it('formats KSA phones as E.164', () => {
    expect(toPaymobPhone('0501234567')).toBe('+966501234567');
    expect(toPaymobPhone('501234567')).toBe('+966501234567');
    expect(toPaymobPhone('00966501234567')).toBe('+966501234567');
    expect(toPaymobPhone('')).toBe('');
  });
});

describe('WhatsApp webhook signature', () => {
  it('rejects a missing signature when a secret is configured, or in production', () => {
    expect(verifyWebhookSignature(Buffer.from('{}'), undefined)).toBe(
      process.env.NODE_ENV !== 'production' && !process.env.WHATSAPP_WEBHOOK_SECRET,
    );
  });
});
