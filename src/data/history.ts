// S&P 500 total return (dividends reinvested), 10-year US Treasury total
// return and US CPI, December to December, all in percent, 1928 through 2024.
// The S&P 500 and Treasury columns are Damodaran's histretSP table (January
// 2026 update, checked year for year); CPI follows the BLS series. A
// re-derived file can replace this one.

export const FIRST_YEAR = 1928;

export const SP500_TOTAL_RETURN = [
  43.81, -8.30, -25.12, -43.84, -8.64, 49.98, -1.19, 46.74, 31.94, -35.34, // 1928-37
  29.28, -1.10, -10.67, -12.77, 19.17, 25.06, 19.03, 35.82, -8.43, 5.20,  // 1938-47
  5.70, 18.30, 30.81, 23.68, 18.15, -1.21, 52.56, 32.60, 7.44, -10.46,     // 1948-57
  43.72, 12.06, 0.34, 26.64, -8.81, 22.61, 16.42, 12.40, -9.97, 23.80,     // 1958-67
  10.81, -8.24, 3.56, 14.22, 18.76, -14.31, -25.90, 37.00, 23.83, -6.98,   // 1968-77
  6.51, 18.52, 31.74, -4.70, 20.42, 22.34, 6.15, 31.24, 18.49, 5.81,       // 1978-87
  16.54, 31.48, -3.06, 30.23, 7.49, 9.97, 1.33, 37.20, 22.68, 33.10,       // 1988-97
  28.34, 20.89, -9.03, -11.85, -21.97, 28.36, 10.74, 4.83, 15.61, 5.48,    // 1998-2007
  -36.55, 25.94, 14.82, 2.10, 15.89, 32.15, 13.52, 1.38, 11.77, 21.61,     // 2008-17
  -4.23, 31.21, 18.02, 28.47, -18.04, 26.06, 24.88,                        // 2018-24
];

// Total return on a 10-year Treasury bond held for the year: coupon plus price change.
export const TREASURY_10Y = [
  0.84, 4.20, 4.54, -2.56, 8.79, 1.86, 7.96, 4.47, 5.02, 1.38,            // 1928-37
  4.21, 4.41, 5.40, -2.02, 2.29, 2.49, 2.58, 3.80, 3.13, 0.92,            // 1938-47
  1.95, 4.66, 0.43, -0.30, 2.27, 4.14, 3.29, -1.34, -2.26, 6.80,          // 1948-57
  -2.10, -2.65, 11.64, 2.06, 5.69, 1.68, 3.73, 0.72, 2.91, -1.58,         // 1958-67
  3.27, -5.01, 16.75, 9.79, 2.82, 3.66, 1.99, 3.61, 15.98, 1.29,          // 1968-77
  -0.78, 0.67, -2.99, 8.20, 32.81, 3.20, 13.73, 25.71, 24.28, -4.96,      // 1978-87
  8.22, 17.69, 6.24, 15.00, 9.36, 14.21, -8.04, 23.48, 1.43, 9.94,        // 1988-97
  14.92, -8.25, 16.66, 5.57, 15.12, 0.38, 4.49, 2.87, 1.96, 10.21,        // 1998-07
  20.10, -11.12, 8.46, 16.04, 2.97, -9.10, 10.75, 1.28, 0.69, 2.80,       // 2008-17
  -0.02, 9.64, 11.33, -4.42, -17.83, 3.88, -1.64,                         // 2018-24
];

export const CPI = [
  -1.2, 0.6, -6.4, -9.3, -10.3, 0.8, 1.5, 3.0, 1.4, 2.9,
  -2.8, 0.0, 0.7, 9.9, 9.0, 3.0, 2.3, 2.2, 18.1, 8.8,
  3.0, -2.1, 5.9, 6.0, 0.8, 0.7, -0.7, 0.4, 3.0, 2.9,
  1.8, 1.7, 1.4, 0.7, 1.3, 1.6, 1.0, 1.9, 3.5, 3.0,
  4.7, 6.2, 5.6, 3.3, 3.4, 8.7, 12.3, 6.9, 4.9, 6.7,
  9.0, 13.3, 12.5, 8.9, 3.8, 3.8, 3.9, 3.8, 1.1, 4.4,
  4.4, 4.6, 6.1, 3.1, 2.9, 2.7, 2.7, 2.5, 3.3, 1.7,
  1.6, 2.7, 3.4, 1.6, 2.4, 1.9, 3.3, 3.4, 2.5, 4.1,
  0.1, 2.7, 1.5, 3.0, 1.7, 1.5, 0.8, 0.7, 2.1, 2.1,
  1.9, 2.3, 1.4, 7.0, 6.5, 3.4, 2.9,
];

// Real (inflation-adjusted) equity return per year, as a fraction.
export const REAL_EQUITY: number[] = SP500_TOTAL_RETURN.map((r, i) => (1 + r / 100) / (1 + (CPI[i] ?? 0) / 100) - 1);

// Real 10-year Treasury return per year, as a fraction.
export const REAL_TREASURY: number[] = TREASURY_10Y.map((r, i) => (1 + r / 100) / (1 + (CPI[i] ?? 0) / 100) - 1);

export const LAST_YEAR = FIRST_YEAR + REAL_EQUITY.length - 1;

/** Median real return of a mix rebalanced every year: `stockShare` in the S&P 500, the rest in 10-year Treasuries. */
export function medianRealReturn(stockShare = 1): number {
  const s = REAL_EQUITY.map((r, i) => stockShare * r + (1 - stockShare) * (REAL_TREASURY[i] ?? 0)).sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

export function meanRealReturn(): number {
  return REAL_EQUITY.reduce((a, b) => a + b, 0) / REAL_EQUITY.length;
}
