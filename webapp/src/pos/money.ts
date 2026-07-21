// Integer-centavo money math for the offline-first web POS (webapp-pos-plan.md
// §5, Increment 3). Never let an IEEE double near a peso total - the JS
// analogue of the WinForms POS storing money as TEXT to avoid the same drift
// (145.70 -> 145.6999...). Money lives as an exact integer everywhere in the
// cart/cart-to-sale path; only formatCentavos() and centavosToDecimalString()
// convert back to a decimal, and only at the edges (display, the wire DTO).
import { formatMoney } from '../lib/format'

export function toCentavos(pesos: number): number {
  return Math.round(pesos * 100)
}

// Half-up, matching the plan's spec exactly. In practice qty is always a
// whole number today (branch till sells whole pieces), so this product is
// already exact and Math.round is a no-op - kept because a future fractional
// qty (e.g. raw material sold by weight) must not silently drift.
export function lineTotalCentavos(unitPriceCentavos: number, qty: number): number {
  return Math.round(unitPriceCentavos * qty)
}

export function sumCentavos(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

// The wire DTO's decimal string, built once at the edge. Because the internal
// value is an exact integer, this can never produce a long tail - `14570`
// serializes to exactly "145.70", never "145.69999999999998".
export function centavosToDecimalString(c: number): string {
  return (c / 100).toFixed(2)
}

export function formatCentavos(c: number): string {
  return formatMoney(c / 100)
}
