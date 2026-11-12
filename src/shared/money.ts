/** Server-side money helpers using decimal strings / numeric — never float for totals. */

export function toMoney(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0.00';
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function addMoney(...values: unknown[]): string {
  const cents = values.reduce<number>((sum, v) => sum + Math.round(Number(v ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}

export function mulMoney(unit: unknown, qty: number): string {
  const cents = Math.round(Number(unit ?? 0) * 100) * qty;
  return (cents / 100).toFixed(2);
}

export function percentOf(amount: unknown, percent: unknown): string {
  const cents = Math.round(Number(amount ?? 0) * 100);
  const result = Math.round((cents * Number(percent ?? 0)) / 100);
  return (result / 100).toFixed(2);
}

export function effectiveProductPrice(product: {
  price: string | number;
  sale_price?: string | number | null;
  sale_starts_at?: string | Date | null;
  sale_ends_at?: string | Date | null;
}): string {
  const now = Date.now();
  const sale = product.sale_price;
  if (sale == null) return toMoney(product.price);
  const start = product.sale_starts_at ? new Date(product.sale_starts_at).getTime() : null;
  const end = product.sale_ends_at ? new Date(product.sale_ends_at).getTime() : null;
  if (start && now < start) return toMoney(product.price);
  if (end && now > end) return toMoney(product.price);
  return toMoney(sale);
}
