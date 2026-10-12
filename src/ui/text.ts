// Small text helpers every view shares, so a limit or a plural reads the same
// on every card.

/** `text` cut to `limit` characters, ending in an ellipsis when it was longer. */
export function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}

/** `text` on one line, whitespace collapsed, then cut. */
export function oneLine(text: string, limit: number): string {
  return cut(text.replaceAll(/\s+/g, " ").trim(), limit)
}

/** `1 step`, `3 steps`. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`
}

/** `950`, `12.3k`, `1.2M`. */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** `a`, `a and b`, `a, b and c`. */
export function listed(items: string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/** `code` as inline code. */
export function code(text: string): string {
  return `\`${text}\``
}
