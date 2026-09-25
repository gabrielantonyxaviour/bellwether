/** A local symbol glyph for rehearsal assets without a published token logo. */
export function tokenIcon(symbol: string): string {
  const letter = symbol.slice(0, 1).replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "?"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#262626"/><text x="20" y="26" text-anchor="middle" fill="white" font-family="Arial" font-size="20">${letter}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
