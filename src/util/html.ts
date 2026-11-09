/** Escape text for HTML element and attribute contexts. Model text is never rendered as HTML. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

/** Only allow http(s) links that are explicitly approved in configuration. */
export function safeApprovedUrl(url: string, approved: string[]): string | null {
  if (!approved.includes(url)) return null;
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
}
