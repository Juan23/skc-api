import type { ReactNode } from 'react'

interface Props {
  start: string
  end: string
  onStart: (v: string) => void
  onEnd: (v: string) => void
  onLoad: () => void
  busy?: boolean
  children?: ReactNode // extra filters (branch picker, etc.) sit between the dates and Load
}

// `<input type="date">` gives YYYY-MM-DD directly, which is exactly the format
// the API wants - no Date object is constructed anywhere in the filter path.
// See lib/format.ts for why that matters.
export function DateRangePicker({ start, end, onStart, onEnd, onLoad, busy, children }: Props) {
  return (
    <div className="toolbar">
      <label className="inline">
        From
        <input type="date" value={start} onChange={(e) => onStart(e.target.value)} />
      </label>
      <label className="inline">
        To
        <input type="date" value={end} onChange={(e) => onEnd(e.target.value)} />
      </label>
      {children}
      <button className="btn primary" onClick={onLoad} disabled={busy}>
        {busy ? 'Loading…' : 'Load'}
      </button>
    </div>
  )
}
