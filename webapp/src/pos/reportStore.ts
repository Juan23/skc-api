// Data layer for the web POS printable daily report (webapp-pos-plan.md
// Increment 7) - the browser analogue of SKC Branch's frmSalesReport. A
// management/accountability document (per-sale list + signed-off summary),
// NOT a customer receipt: the POS deliberately never prints receipts.
//
// The server is the source of truth - it alone knows about voids and sales rung
// on another device. But closing time is exactly when a branch may be offline,
// so a TODAY-ONLY range falls back to the local POS stores rather than refusing
// to print (banner-flagged, since local data can't see other devices or remote
// voids). Any other range has no fallback - the local store keeps a day log,
// not history. The CSV export has no fallback either: item lines for synced
// sales live only on the server.
import { api } from '../api/client'
import type { SaleSummary, SaleLineExport } from '../api/types'
import { endOfDay, localDate } from '../lib/format'
import { loadTodayLocal } from './dayLogStore'

export type ReportFlag = '' | 'VOIDED' | 'SHORTFALL' | 'REJECTED' | 'UNSYNCED'

export interface ReportRow {
  no: string // server sale no.; blank for a locally-read (unsynced) row
  soldAt: string
  cashier: string
  totalCentavos: number
  flag: ReportFlag
  counted: boolean // included in the gross total (not voided/rejected)
}

export interface ReportSummary {
  countedSales: number
  grossCentavos: number
  voidedCount: number
  voidedCentavos: number
  shortfallCount: number
  rejectedCount: number
  unsyncedCount: number
}

// A per-product roll-up of everything sold in the range - what the owner reads
// to see WHICH items moved (the per-sale rows only show sale totals). Built from
// the same line data the CSV uses, so on-screen and CSV agree.
export interface ItemTally {
  key: string // sku for a product; a sentinel for the rolled-up discount row
  description: string
  qty: number
  valueCentavos: number
  isDiscount: boolean
}

export interface ReportLoad {
  rows: ReportRow[]
  tally: ItemTally[]
  offline: boolean
}

// Aggregate item lines into a per-product tally. Discount lines (sku == null,
// negative total) are rolled into a single "Discounts" row so the tally total
// still reconciles to net gross. Products sort most-sold-first (qty desc, then
// name); the discount row always sits last. Callers pass only lines of COUNTED
// sales (voided/rejected already excluded) - a voided sale sold nothing.
function tallyLines(
  lines: { sku: string | null; description: string; qty: number; lineTotalCentavos: number }[],
): ItemTally[] {
  const products = new Map<string, ItemTally>()
  let discountCentavos = 0
  let discountCount = 0
  for (const l of lines) {
    if (l.sku == null) {
      discountCentavos += l.lineTotalCentavos
      discountCount += 1
      continue
    }
    const existing = products.get(l.sku)
    if (existing) {
      existing.qty += l.qty
      existing.valueCentavos += l.lineTotalCentavos
    } else {
      products.set(l.sku, {
        key: l.sku,
        description: l.description,
        qty: l.qty,
        valueCentavos: l.lineTotalCentavos,
        isDiscount: false,
      })
    }
  }
  const rows = [...products.values()].sort((a, b) => b.qty - a.qty || (a.description < b.description ? -1 : 1))
  if (discountCount > 0) {
    rows.push({ key: '__discounts__', description: 'Discounts', qty: discountCount, valueCentavos: discountCentavos, isDiscount: true })
  }
  return rows
}

// Sum of every tally row = net gross of counted sales (products positive,
// discounts negative), matching summarize().grossCentavos.
export function tallyTotalCentavos(tally: ItemTally[]): number {
  return tally.reduce((sum, t) => sum + t.valueCentavos, 0)
}

// Whole-centavo conversion so the summary sums integers, never IEEE doubles -
// mirrors frmSalesReport's footer discipline (avoids 145.6999… artefacts).
function toCentavos(pesos: number): number {
  return Math.round(pesos * 100)
}

// soldAt is ISO 'YYYY-MM-DDThh:mm:ss' from the server, or local wall-clock
// 'YYYY-MM-DD hh:mm:ss' (space) from the offline store. Either way the first 10
// chars are the date and a plain string compare sorts chronologically within a
// range (never re-parsed through Date - lib/format RULE 1).
function sortBySoldAt(rows: ReportRow[]): ReportRow[] {
  return rows.sort((a, b) => (a.soldAt < b.soldAt ? -1 : a.soldAt > b.soldAt ? 1 : 0))
}

// Load the per-sale rows for a date range. Online: the server's authoritative
// list. On a network failure for a TODAY-ONLY range: the local stores, flagged
// offline. Any other range rethrows so the caller can tell the user past days
// need a connection.
export async function loadReport(branch: string, startDate: string, endDate: string): Promise<ReportLoad> {
  // Capture "today" up front, not inside the catch: if the clock crosses
  // midnight while the request is in flight, a catch-time re-read would no
  // longer match the (still legitimately "today") requested range and would
  // wrongly deny the offline fallback right at the boundary.
  const today = localDate()
  try {
    // Both come from the same server; fetch in parallel. /api/sales gives the
    // per-sale rows + summary counts; /api/sales/lines gives the item detail the
    // tally needs (the report used to fetch lines only at CSV-export time).
    const [sales, lines] = await Promise.all([
      api.get<SaleSummary[]>(`/api/sales?branch=${encodeURIComponent(branch)}&start=${startDate}&end=${endOfDay(endDate)}`),
      fetchSaleLines(branch, startDate, endDate),
    ])
    const rows: ReportRow[] = sales.map((s) => ({
      no: String(s.localId),
      soldAt: s.soldAt,
      cashier: s.staffName ?? '',
      totalCentavos: toCentavos(s.totalAmount),
      // Voided wins over shortfall: a voided sale was reversed outright.
      flag: s.voided ? 'VOIDED' : s.hasShortfall ? 'SHORTFALL' : '',
      counted: !s.voided,
    }))
    const tally = tallyLines(
      lines
        .filter((l) => !l.voided) // a voided sale sold nothing
        .map((l) => ({ sku: l.sku, description: l.description, qty: l.qty, lineTotalCentavos: toCentavos(l.lineTotal) })),
    )
    return { rows: sortBySoldAt(rows), tally, offline: false }
  } catch (err) {
    if (startDate !== today || endDate !== today) throw err
    // Reuse the day log's local UNION (pendingSales + syncedLog, branch-scoped,
    // today-only) so the offline report matches the day log exactly.
    const local = await loadTodayLocal(branch)
    // Tally from the local line detail (present for every locally-rung sale),
    // over counted (non-voided, non-rejected) sales only.
    const tally = tallyLines(
      local
        .filter((e) => e.status !== 'voided' && e.status !== 'error')
        .flatMap((e) => e.lines ?? [])
        .map((l) => ({ sku: l.sku, description: l.description, qty: l.qty, lineTotalCentavos: l.lineTotalCentavos })),
    )
    const rows: ReportRow[] = local.map((e) => ({
      no: '', // the server assigns the sale no.; unsynced sales have none yet
      soldAt: e.soldAt,
      cashier: e.staffName || '',
      totalCentavos: e.totalCentavos,
      flag:
        e.status === 'voided'
          ? 'VOIDED'
          : e.status === 'error'
            ? 'REJECTED'
            : e.status === 'pending'
              ? 'UNSYNCED'
              : e.status === 'shortfall'
                ? 'SHORTFALL'
                : '',
      // Rejected sales never counted server-side; voided ones were reversed.
      counted: e.status !== 'voided' && e.status !== 'error',
    }))
    return { rows: sortBySoldAt(rows), tally, offline: true }
  }
}

export function summarize(rows: ReportRow[]): ReportSummary {
  const isFlag = (f: ReportFlag) => rows.filter((r) => r.flag === f)
  const counted = rows.filter((r) => r.counted)
  return {
    countedSales: counted.length,
    grossCentavos: counted.reduce((sum, r) => sum + r.totalCentavos, 0),
    voidedCount: isFlag('VOIDED').length,
    voidedCentavos: isFlag('VOIDED').reduce((sum, r) => sum + r.totalCentavos, 0),
    shortfallCount: isFlag('SHORTFALL').length,
    rejectedCount: isFlag('REJECTED').length,
    unsyncedCount: isFlag('UNSYNCED').length,
  }
}

export async function fetchSaleLines(branch: string, startDate: string, endDate: string): Promise<SaleLineExport[]> {
  return api.get<SaleLineExport[]>(
    `/api/sales/lines?branch=${encodeURIComponent(branch)}&start=${startDate}&end=${endOfDay(endDate)}`,
  )
}

// One row per item per sale, so a SUMIFS in Excel can total per item (the
// printed report is sale-level and can't). Mirrors frmSalesReport.WriteCsv:
// invariant number formatting (no thousands separator - "1,234.00" would split
// a column), RFC-style quoting only when needed. The caller prepends a UTF-8 BOM
// so Excel doesn't mangle non-ASCII product/cashier names.
export function buildCsv(lines: SaleLineExport[]): string {
  const esc = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const out = ['SaleNo,Date,Time,Cashier,PaymentMethod,SKU,Item,Qty,UnitPrice,LineTotal,ShortfallQty,Voided']
  for (const l of lines) {
    const [date, rest = ''] = l.soldAt.split(/[T ]/)
    out.push(
      [
        String(l.saleNo),
        date,
        rest.slice(0, 8),
        esc(l.staffName ?? ''),
        esc(l.paymentMethod ?? 'Cash'),
        esc(l.sku ?? ''),
        esc(l.description ?? ''),
        String(l.qty),
        l.unitPrice.toFixed(2),
        l.lineTotal.toFixed(2),
        String(l.shortfallQty),
        l.voided ? 'TRUE' : 'FALSE',
      ].join(','),
    )
  }
  return out.join('\r\n') + '\r\n'
}
