import { useEffect, useRef, useState } from 'react'
import type { PosStaffPublic } from '../api/types'
import { verifyPin } from './staffSync'

// The verified-cashier control that replaces the free-text staff-name input
// when the till's branch has cashiers cached (SaleScreen decides that; this
// component never touches IndexedDB or the network). Three states:
//   verified  - `current` names a cashier; show it + a Switch button.
//   pick      - no current cashier; one button per cached active cashier.
//   pin       - a name was tapped; numeric PIN entry (keyboard + on-screen pad),
//               auto-verifies at 4 digits via the offline hash check.
//
// Deliberately NO lockout on wrong PINs: verification is client-side on a
// possibly-offline till, so any lockout is a bricked counter mid-shift. Wrong
// PIN just clears and lets them retry.
interface Props {
  staff: PosStaffPublic[]
  current: string
  onVerified: (staffName: string) => void
  onSwitch: () => void
}

export function CashierPicker({ staff, current, onVerified, onSwitch }: Props) {
  // The tapped cashier is tracked by id, and re-resolved against the LIVE
  // staff prop at verify time - a staff-list sync landing mid-PIN-entry (rename,
  // deactivate, PIN reset) must win over the object captured at tap time.
  const [pickedId, setPickedId] = useState<number | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const picked = pickedId != null ? staff.find((s) => s.staffId === pickedId) : undefined

  // The tapped cashier can vanish from the list mid-entry (deactivated or
  // deleted by the owner, landed via a background sync). Bounce back to the
  // pick list with an explanation rather than verifying against a ghost.
  useEffect(() => {
    if (pickedId != null && !picked) {
      setPickedId(null)
      setPin('')
      setError('That cashier is no longer available.')
    }
  }, [pickedId, picked])

  function tap(s: PosStaffPublic) {
    setPickedId(s.staffId)
    setPin('')
    setError('')
  }

  function cancel() {
    setPickedId(null)
    setPin('')
    setError('')
  }

  async function handlePinChange(next: string) {
    const digits = next.replace(/\D/g, '').slice(0, 4)
    setPin(digits)
    if (digits.length < 4 || !picked || checking) return
    setChecking(true)
    try {
      if (await verifyPin(picked, digits)) {
        setPickedId(null)
        setPin('')
        setError('')
        onVerified(picked.staffName)
      } else {
        setPin('')
        setError('Wrong PIN — try again.')
        inputRef.current?.focus()
      }
    } catch {
      // SubtleCrypto threw (shouldn't happen in a secure context) - treat like
      // a wrong PIN rather than wedging the checking flag.
      setPin('')
      setError('Could not check the PIN — try again.')
    } finally {
      setChecking(false)
    }
  }

  if (current !== '') {
    return (
      <div className="pos-cashier-row">
        <span className="pos-cashier-name">Cashier: {current}</span>
        <button type="button" className="pos-cashier-switch" onClick={onSwitch} aria-label="Switch cashier">
          Switch
        </button>
      </div>
    )
  }

  if (picked) {
    return (
      <div className="pos-cashier-pin">
        <div className="pos-cashier-row">
          <span className="pos-cashier-name">PIN for {picked.staffName}</span>
          <button type="button" className="pos-cashier-switch" onClick={cancel}>
            Cancel
          </button>
        </div>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          maxLength={4}
          aria-label="PIN"
          className="pos-pin-input"
          value={pin}
          onChange={(e) => void handlePinChange(e.target.value)}
          autoFocus
        />
        {error && (
          <p className="pos-pin-error" role="alert">
            {error}
          </p>
        )}
        <div className="pos-pinpad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'].map((k) => (
            <button
              key={k}
              type="button"
              className="pos-pinpad-key"
              aria-label={k === '⌫' ? 'Backspace' : k === 'C' ? 'Clear' : k}
              onClick={() => {
                if (k === '⌫') void handlePinChange(pin.slice(0, -1))
                else if (k === 'C') void handlePinChange('')
                else void handlePinChange(pin + k)
              }}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="pos-cashier-list" role="group" aria-label="Choose cashier">
      {error && (
        <p className="pos-pin-error" role="alert">
          {error}
        </p>
      )}
      {staff.map((s) => (
        <button key={s.staffId} type="button" className="pos-cashier-pick" onClick={() => tap(s)}>
          {s.staffName}
        </button>
      ))}
    </div>
  )
}
