// Small id helper (no external dependency, safe for tests and SSR).

let counter = 0

export function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000
  const random = Math.floor(Math.random() * 0xffffff).toString(36)
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${random}`
}
