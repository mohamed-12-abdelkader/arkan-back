import { describe, expect, it } from 'vitest';

// Pure operator tests extracted from engine logic
function compare(op: string, left: unknown, right: unknown): boolean | null {
  if (left == null || right == null || left === '' || right === '') return null;
  switch (op) {
    case 'eq':
      return String(left).toLowerCase() === String(right).toLowerCase();
    case 'contains': {
      const hay = String(left).toLowerCase();
      const needle = String(right).toLowerCase();
      return (
        hay
          .split(/[,|/]/)
          .map((s) => s.trim())
          .includes(needle) || hay.includes(needle)
      );
    }
    case 'lte':
      return Number(left) <= Number(right);
    default:
      return null;
  }
}

describe('compatibility operators', () => {
  it('matches equal sockets', () => {
    expect(compare('eq', 'AM5', 'am5')).toBe(true);
    expect(compare('eq', 'AM5', 'LGA1700')).toBe(false);
  });

  it('returns null when specs missing (uncertain, not false-compatible)', () => {
    expect(compare('eq', null, 'AM5')).toBeNull();
    expect(compare('eq', 'AM5', undefined)).toBeNull();
  });

  it('checks case supported form factors', () => {
    expect(compare('contains', 'ATX, Micro-ATX, Mini-ITX', 'Micro-ATX')).toBe(true);
    expect(compare('contains', 'ATX', 'E-ATX')).toBe(false);
  });

  it('checks GPU length clearance', () => {
    expect(compare('lte', 320, 360)).toBe(true);
    expect(compare('lte', 400, 360)).toBe(false);
  });
});
