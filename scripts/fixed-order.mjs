// One fixed, machine independent way to order strings.
//
// String.prototype.localeCompare with no locale follows the computer's language,
// so the same list can sort differently on a Danish, Turkish or Lithuanian machine
// than on an English one. Anything that picks a winner, builds a stored list or is
// compared in a test must use plain code unit order instead.

export function compareCodeUnits(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// For lists shown to people only. The locale is fixed to English, so every machine shows the same order.
const displayCollator = new Intl.Collator('en', { numeric: false });
export function compareForDisplay(left, right) {
  return displayCollator.compare(String(left), String(right));
}
