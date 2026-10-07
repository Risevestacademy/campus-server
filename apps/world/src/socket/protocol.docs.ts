/**
 * The viewer the docs page loads, pinned: an unpinned script would change
 * under a page nobody redeployed.
 */
const VIEWER = 'https://unpkg.com/@asyncapi/react-component@3.2.1';

/**
 * The protocol as a page somebody can read: AsyncAPI's own viewer, pointed
 * at the document this instance serves. world's counterpart of campus-api's
 * /docs, and like it nothing here is written by hand — the page is a frame
 * around `documentUrl`.
 *
 * The viewer comes from a CDN rather than from this repository, so the page
 * needs that to be reachable; the document it shows does not.
 */
export function protocolDocsPage(documentUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Campus world: socket protocol</title>
    <link rel="stylesheet" href="${VIEWER}/styles/default.min.css" />
    <style>
      body {
        margin: 0;
      }
      #fallback {
        font-family: system-ui, sans-serif;
        padding: 24px;
      }
    </style>
  </head>
  <body>
    <div id="asyncapi">
      <p id="fallback">
        Loading the protocol. If nothing appears, the viewer could not be
        loaded; the document itself is at
        <a href="${documentUrl}">${documentUrl}</a>.
      </p>
    </div>
    <script src="${VIEWER}/browser/standalone/index.js"></script>
    <script>
      AsyncApiStandalone.render(
        {
          schema: { url: ${JSON.stringify(documentUrl)}, options: { method: 'GET' } },
          config: { show: { sidebar: true } },
        },
        document.getElementById('asyncapi'),
      );
    </script>
  </body>
</html>
`;
}
