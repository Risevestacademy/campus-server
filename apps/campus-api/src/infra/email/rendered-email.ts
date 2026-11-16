/** An email written here rather than filled into a template: all three parts. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * For anything put between tags or inside an attribute. Every email written
 * here carries values from somewhere else — an address, a name, a link — and
 * none of them may be read as markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
