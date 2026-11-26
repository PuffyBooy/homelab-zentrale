/**
 * Reduces a series to at most `n` values by averaging equal slices. A Sparkline draws
 * one bar per value, so 24 h at one point per minute become 48 bars of 30 min.
 */
export function bucket(values: readonly number[], n: number): number[] {
  if (n <= 0) return [];
  if (values.length <= n) return [...values];
  const out: number[] = [];
  const size = values.length / n;
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * size);
    const to = Math.max(from + 1, Math.floor((i + 1) * size));
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j] ?? 0;
    out.push(sum / (to - from));
  }
  return out;
}

export function maxOf(values: readonly number[]): number | null {
  return values.length ? Math.max(...values) : null;
}
