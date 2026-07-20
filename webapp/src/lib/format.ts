// Display formatting. Two rules here are load-bearing, not stylistic.

// RULE 1: never parse a server timestamp into a JS Date.
//
// The DB columns are `timestamp without time zone` and their meaning is mixed:
// client-sent values (delivery dates, POS sold_at) are Philippine local time,
// while server CURRENT_TIMESTAMP values (adjustments, accepted_at) are UTC. The
// JSON carries no offset either way, so `new Date(s)` would apply the browser's
// timezone to both and shift half of them. We slice the ISO string textually
// instead - what the server said is what the user sees, same as WinForms.
// Use this only for columns whose time actually means something (POS sold_at,
// adjustments, production). Date-only columns - purchase and delivery dates,
// which are stamped date-only - should call formatDate instead, so this does
// NOT special-case midnight: a sale rung up at exactly 00:00 must still show
// its time rather than silently rendering as a bare date.
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const [datePart, timePart = ''] = iso.split('T')
  const hhmm = timePart.slice(0, 5)
  return hhmm ? `${datePart} ${hhmm}` : datePart
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? iso.split('T')[0] : ''
}

const money = new Intl.NumberFormat('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoney(value: number | null | undefined): string {
  return value == null ? '' : money.format(value)
}

export function formatQty(value: number | null | undefined): string {
  return value == null ? '' : new Intl.NumberFormat('en-PH').format(value)
}

// RULE 2: client-side money math is for display totals only - the server is
// always the authority (it stores NUMERIC and the POS store deliberately keeps
// money in TEXT columns to avoid float drift). Summing IEEE doubles would show
// artefacts like 145.69999999, so sum in whole centavos and convert once at the
// end. This mirrors what frmSalesReport does for its footer.
export function sumMoney(values: number[]): number {
  return values.reduce((acc, v) => acc + Math.round(v * 100), 0) / 100
}

// The API's date filters are compared against timestamps, so an end date must
// carry end-of-day or the final day's rows drop out. Sending a plain
// `YYYY-MM-DD` end would mean midnight. (Endpoints that cast to ::date are
// unaffected by the time component, so one rule works for all of them.)
export function endOfDay(date: string): string {
  return `${date}T23:59:59`
}

// Today / N days ago as YYYY-MM-DD, built from local calendar parts rather than
// toISOString() - the latter converts to UTC and in PH (UTC+8) hands back
// yesterday's date for anything before 8am.
export function localDate(daysAgo = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
