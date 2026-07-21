// The office staff who requisition deliveries, mirrored verbatim from the combo
// box in Delivery.cs (cmbRequester). Offered as suggestions on the delivery entry
// form, but the field stays free-text (a datalist, not a hard select) so a name
// not on this list - or a prefilled one from an older ticket being amended - is
// still accepted, exactly as the WinForms combo allowed typed entries.
export const REQUESTERS = [
  'Kaesseah P',
  'Gena-flor G.',
  'Allan A.',
  'Armando V.',
  'James M.',
  'Marites C.',
  'Anilien B.',
  'Allan V.',
  'Darlin V.',
  'Julieta B.',
  'Charmaine L',
  'Gina M.',
  'Hazel S.',
  'Jessie M.',
  'Mark C.',
  'Anita E.',
  'Angelie P.',
  'Flordiliza G.',
  'Anna S.',
  'Razel G.',
  'Nino G.',
  'Anna T.',
  'Kim M.',
  'JV M.',
  'Jenifer P.',
  'Janeath D.',
] as const
