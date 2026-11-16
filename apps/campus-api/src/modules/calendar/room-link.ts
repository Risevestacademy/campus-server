import {
  ROOM_LINK_CODE,
  ROOM_LINK_PATH,
} from '../room-links/room-link-code.js';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Anything that looks like a web link, up to a space, a tag or a quote. The
 * lookahead starts a candidate at every scheme, so a link inside another one
 * (a Google redirect, two links run together) is still tried on its own.
 */
const CANDIDATE = /(?=(https?:\/\/[^\s<>"']+))/gi;

/**
 * The code of the first campus room link, `{APP_PUBLIC_URL}/join/{code}`, in
 * an event's location, else its description. Only the shape is checked here:
 * whether the link is live, and the member may open it, is the room-links
 * module's to say.
 *
 * A link counts when it opens the same page in a browser, so the scheme, a
 * leading `www.`, the case of the host and percent-encoding in the path may
 * all differ from `APP_PUBLIC_URL`. The code itself is case-sensitive.
 */
export function extractRoomLinkCode(
  appUrl: string,
  location: string | null,
  description: string | null,
): string | null {
  const app = new URL(appUrl);
  const host = siteHost(app);
  const base = `${app.pathname.replace(/\/+$/, '')}${ROOM_LINK_PATH}`;
  // The whole run of letters and digits after `/join/` at the start of the
  // path, so a code one character too long is not taken for a code.
  const path = new RegExp(`^${base.replace(ESCAPE, '\\$&')}([A-Za-z0-9]+)`);
  for (const field of [location, description]) {
    for (const [, candidate] of field?.matchAll(CANDIDATE) ?? []) {
      const code = codeIn(candidate, host, path);
      if (code) {
        return code;
      }
    }
  }
  return null;
}

function codeIn(candidate: string, host: string, path: RegExp): string | null {
  let url: URL;
  let pathname: string;
  try {
    url = new URL(candidate);
    // decodeURI leaves an encoded `/` alone, so `/join%2F{code}` stays apart.
    pathname = decodeURI(url.pathname);
  } catch {
    return null;
  }
  if (siteHost(url) !== host) {
    return null;
  }
  const code = path.exec(pathname)?.[1];
  return code && ROOM_LINK_CODE.test(code) ? code : null;
}

/** Host and port, lowercased, without a leading `www.`. */
function siteHost(url: URL): string {
  return `${url.hostname.replace(/^www\./, '')}:${url.port}`;
}
