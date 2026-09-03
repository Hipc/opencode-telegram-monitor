/**
 * Build a bordered two-column Rich-Message table out of field rows. The
 * `bordered compact` attributes give the table native Telegram grid borders
 * (feat/bordered-rich-tables) while keeping cell indents small so rows do not
 * waste height; label/value cells size themselves to the content, so long
 * values wrap inside their own cell instead of running back to the left
 * margin. All field-table consumers share this single exit point, so the
 * presentation choice is global by construction.
 */
export function fieldTable(rows: string[]): string {
  return `<table bordered compact>${rows.join("")}</table>`;
}

/**
 * One table row: a bold label cell and an escaped value cell.
 */
export function fieldRow(label: string, value: string): string {
  return `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>`;
}

/**
 * Title line shown above a notification table: the icon followed by the
 * project name. Kept as a plain paragraph (not a table cell) so Telegram's
 * notification preview picks up its text.
 */
export function titleLine(icon: string, projectLabel: string): string {
  return paragraph(`${icon} ${projectLabel}`);
}

/**
 * Wrap a plain-text line into an HTML paragraph for Rich Messages.
 */
export function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}