import { localDate } from './format'

// Mints a transaction id in the exact format the WinForms clients use, so a
// purchase or delivery created here is indistinguishable from one created by the
// installed app: `PUR-yyyyMMdd-XXXXXX` / `DEL-yyyyMMdd-XXXXXX`, where the suffix
// is six uppercase hex chars (Purchases.cs / Delivery.cs both take the first six
// of a GUID's "N" form).
//
// The date embedded in the id is the TICKET's date, not necessarily today:
//   - Purchases.cs uses `entryDate` (the user-picked dtpDate, which can be
//     backdated when logging a receipt late), so the caller passes that date.
//   - Delivery.cs uses `DateTime.Now`, so the delivery caller passes nothing and
//     today's local date is used.
// Passing the picked date keeps the id's date and the ticket's stored date in
// agreement, as WinForms does.
//
// The server dedups on the full id (a resubmit of the same id is a committed
// no-op), so the caller mints ONE id per attempt and reuses it across retries -
// see the entry screens. crypto.getRandomValues is used, not crypto.randomUUID:
// the latter needs a secure context and the app is served over plain HTTP inside
// Tailscale, whereas getRandomValues works in insecure contexts too.
export function newTicketId(prefix: 'PUR' | 'DEL' | 'PRD', ymd?: string): string {
  const bytes = new Uint8Array(3) // 3 bytes -> 6 hex chars
  crypto.getRandomValues(bytes)
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
  const datePart = (ymd ?? localDate()).replace(/-/g, '') // yyyyMMdd
  return `${prefix}-${datePart}-${suffix}`
}
