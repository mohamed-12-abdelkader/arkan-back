import { describe, expect, it } from 'vitest';
import { addMoney, mulMoney, toMoney, effectiveProductPrice } from './money';

describe('money helpers', () => {
  it('formats money without float drift', () => {
    expect(toMoney(10.1 + 0.2)).toBe('10.30');
    expect(addMoney('10.10', '0.20')).toBe('10.30');
    expect(mulMoney('99.99', 2)).toBe('199.98');
  });

  it('uses sale price only inside schedule window', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(
      effectiveProductPrice({
        price: 1000,
        sale_price: 800,
        sale_starts_at: past,
        sale_ends_at: future,
      }),
    ).toBe('800.00');
    expect(
      effectiveProductPrice({
        price: 1000,
        sale_price: 800,
        sale_starts_at: future,
        sale_ends_at: null,
      }),
    ).toBe('1000.00');
  });
});
