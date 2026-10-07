/**
 * Short, readable form of a cuid.
 *
 * Diagnostics shows job and order ids in a dense table. Full cuids are
 * unreadable there and wrap badly, but they still have to be copyable and
 * unique, so the prefix plus enough tail to disambiguate is shown.
 */
export function humanizeId(value: string | null | undefined, head = 8, tail = 4): string {
  const id = String(value || "").trim()
  if (!id) return "-"
  if (id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}
