import type { ReactNode } from 'react'

export interface Column<T> {
  header: string
  // Cell content. Return a string for plain text, or any node for styling.
  cell: (row: T) => ReactNode
  align?: 'left' | 'right'
  width?: string
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[] | null
  loading?: boolean
  error?: string
  empty?: string
  rowKey: (row: T, index: number) => string
  // Optional master/detail: clicking a row selects it.
  onRowClick?: (row: T) => void
  selectedKey?: string | null
  rowClass?: (row: T) => string | undefined
}

// The one table used by every report screen. Deliberately dumb: no sorting,
// paging or client-side filtering yet - the WinForms grids it replaces don't
// have those either, and inventing them here would make the two diverge.
export function DataTable<T>({
  columns,
  rows,
  loading,
  error,
  empty = 'Nothing to show.',
  rowKey,
  onRowClick,
  selectedKey,
  rowClass,
}: Props<T>) {
  if (error) return <p className="error">{error}</p>
  if (loading) return <p className="muted">Loading…</p>
  if (!rows) return null
  if (rows.length === 0) return <p className="muted">{empty}</p>

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} style={{ textAlign: c.align ?? 'left', width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row, index)
            const classes = [
              rowClass?.(row),
              onRowClick ? 'clickable' : '',
              selectedKey === key ? 'selected' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <tr key={key} className={classes} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c, i) => (
                  <td key={i} style={{ textAlign: c.align ?? 'left' }}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
