// Product-add helpers, ported from the office app's "Add Item" form so a product
// created in the browser gets the same shape of SKU and the same casing as one
// created in WinForms.

// Title-case a free-text field, matching frmAddMasterItem's ToProperCase
// (TextInfo.ToTitleCase over the lower-cased, trimmed text). "beryl's DARK" ->
// "Beryl's Dark". The word boundary is start-of-string, whitespace, or a hyphen -
// NOT an apostrophe: like .NET's ToTitleCase, "beryl's" stays "Beryl's", not
// "Beryl'S" (a naive \b\w regex breaks on the apostrophe and mis-capitalizes it,
// producing casing that diverges from what the WinForms client stores for the
// same name). It isn't a key, just display text, so this need only match the
// realistic cases (apostrophes, hyphens), not every ToTitleCase edge.
export function toProperCase(text: string): string {
  const t = text.trim()
  if (!t) return t
  return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
}

// Auto-generate a readable SKU stem from brand + base name, mirroring the office
// app's GenerateSKU: first 4 alphanumerics of the brand and first 8 of the base
// name, lower-cased, joined by '-'. It is a stem, NOT a guaranteed-unique key -
// the save path appends -2, -3, ... on a 409 until the server accepts one, same
// as btnSave_Click.
export function generateSku(brand: string, baseName: string): string {
  const brandPart = alnum(brand).slice(0, 4)
  const namePart = alnum(baseName).slice(0, 8)
  return [brandPart, namePart].filter(Boolean).join('-')
}

function alnum(input: string): string {
  return (input || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}
