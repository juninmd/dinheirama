// Escapes text for Telegram parse_mode HTML.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Escapes and caps at `max` chars of output without cutting an entity (&amp;) or a surrogate pair:
// slicing after escapeHtml could leave "&am", which Telegram rejects with 400.
export function escapeHtmlClipped(s: string, max: number): string {
  let out = ''
  for (const ch of s) {
    const e = escapeHtml(ch)
    if (out.length + e.length > max) break
    out += e
  }
  return out
}
