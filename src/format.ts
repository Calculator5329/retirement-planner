export const usd = (n: number, digits = 0): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits });

export const usdK = (n: number): string => {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}k`;
  return `${sign}$${a.toFixed(0)}`;
};

export const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`;

export const signed = (n: number): string => (n >= 0 ? '+' : '') + usd(n);
