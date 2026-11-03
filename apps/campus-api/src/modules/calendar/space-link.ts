/**
 * Finds a campus room URL in the fields of a calendar event. Staff paste
 * a link like `{APP_PUBLIC_URL}/space/{spaceKey}` into the Google Calendar
 * event's location, video-conference link or description so the platform
 * knows which space the event belongs to.
 *
 * Scans the three fields in priority order and returns the first match.
 * The returned key is the raw extraction — the caller must still confirm
 * the space exists and is live.
 */
export function extractSpaceKey(
  appUrl: string,
  location: string | null,
  meetingUrl: string | null,
  description: string | null,
): string | null {
  const base = appUrl.replace(/\/+$/, '');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escaped}/space/([A-Za-z0-9_-]{1,64})(?:\\s|[)\\]>,;"'.!?]|$)`,
  );

  for (const field of [location, meetingUrl, description]) {
    if (!field) continue;
    const match = pattern.exec(field);
    if (match) return match[1];
  }
  return null;
}
