import type { SaleLineExport } from '../api/types'

// Client-side CSV builder for the sales export, ported from frmSalesReport's
// WriteCsv so a file downloaded from the webapp is byte-compatible with one the
// WinForms app saves: same header, same column order, invariant "0.00" money (a
// "1,234.00" would split into two columns), date and time split so Excel's
// SUMIFS can group by day, and voided rows included flagged TRUE - the analysis
// filters them, the export doesn't editorialise.

// Quote a field only when it needs it, doubling any embedded quote - product
// descriptions routinely contain commas ("Flour, All-Purpose").
function escape(value: string): string {
  if (!value) return ''
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// Money without thousands separators, exactly two decimals, invariant culture.
// toFixed (not Intl) so the output is "1234.50" regardless of browser locale.
const money = (v: number) => v.toFixed(2)

export function buildSalesCsv(lines: SaleLineExport[]): string {
  const out: string[] = ['SaleNo,Date,Time,Cashier,SKU,Item,Qty,UnitPrice,LineTotal,ShortfallQty,Voided']
  for (const l of lines) {
    // soldAt is a raw `timestamp without time zone` string ("2026-07-21T14:03:09")
    // sliced textually, never parsed through Date - see lib/format.ts RULE 1.
    const [date, time = ''] = l.soldAt.split('T')
    out.push(
      [
        String(l.saleNo),
        date,
        time.slice(0, 8),
        escape(l.staffName ?? ''),
        escape(l.sku ?? ''),
        escape(l.description),
        String(l.qty),
        money(l.unitPrice),
        money(l.lineTotal),
        String(l.shortfallQty),
        l.voided ? 'TRUE' : 'FALSE',
      ].join(','),
    )
  }
  // Trailing newline like StringBuilder.AppendLine's final call produced.
  return out.join('\r\n') + '\r\n'
}

// Triggers a browser download. UTF-8 *with* BOM: without it Excel opens the file
// as ANSI and mangles any non-ASCII character in a product or cashier name.
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
