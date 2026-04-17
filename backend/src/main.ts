import { Hono } from "hono";
import {
  countPagesForHostVolume,
  createVolumeViewSession,
  getFirstPageForHostVolume,
  getPageById,
  getSeriesById,
  getVolumeViewSession,
  hostServesVolume,
  listDebugHosts,
  listDebugPagesForVolume,
  listDebugSeries,
  listDebugVolumes,
  listHomeSeries,
  listHosts,
  listHostsForPage,
  listHostsWithVolumesForSeries,
  type RegisterManifestMessage,
  upsertManifest,
} from "./db.ts";

type PageResponseHeader = {
  type: "page_response";
  requestId: string;
  pageId: string;
  contentType: string;
};

type PageErrorMessage = {
  type: "page_error";
  requestId: string;
  pageId: string;
  error: string;
};

type PendingPageRequest = {
  hostId: string;
  pageId: string;
  contentType: string | null;
  resolve: (value: { bytes: Uint8Array; contentType: string }) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

const app = new Hono();
const hostSockets = new Map<string, WebSocket>();
const socketHostIds = new WeakMap<WebSocket, string>();
const pendingPageRequests = new Map<string, PendingPageRequest>();

// Render a tiny homepage showing the series currently indexed in SQLite.
// This is just a temporary server-rendered frontend for testing the pipeline.
app.get("/", (c) => {
  const series = listHomeSeries();
  const hosts = listHosts();

  return c.html(renderPage("Home", `
    <h1>Manga test frontend</h1>
    <p>Connected hosts in memory: ${hostSockets.size}</p>
    <h2>Hosts</h2>
    <ul>
      ${hosts.map((host) => `<li>${escapeHtml(host.username)} (${escapeHtml(host.id)}) ${hostSockets.has(host.id) ? "[online]" : "[offline]"}</li>`).join("")}
    </ul>
    <h2>Series</h2>
    <ul>
      ${series.map((item) => `<li><a href="/series/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a> (${item.volume_count} volumes)</li>`).join("")}
    </ul>
  `));
});

// Show one series and group its volumes by host.
// This mirrors the real model better because the available volumes depend on which host is serving them.
app.get("/series/:seriesId", (c) => {
  const seriesId = c.req.param("seriesId");
  const series = getSeriesById(seriesId);

  if (!series) {
    return c.text("Series not found", 404);
  }

  const rows = listHostsWithVolumesForSeries(seriesId);
  const onlineRows = rows.filter((row) => hostSockets.has(row.host_id));
  const hosts = new Map<string, { username: string; volumes: typeof onlineRows }>();

  for (const row of onlineRows) {
    const existing = hosts.get(row.host_id);
    if (existing) {
      existing.volumes.push(row);
      continue;
    }

    hosts.set(row.host_id, {
      username: row.username,
      volumes: [row],
    });
  }

  return c.html(renderPage(series.title, `
    <p><a href="/">Back</a></p>
    <h1>${escapeHtml(series.title)}</h1>
    ${[...hosts.entries()].map(([hostId, host]) => `
      <section>
        <h2>${escapeHtml(host.username)}</h2>
        <ul>
          ${host.volumes.map((volume) => `
            <li>
              <form method="post" action="/volume-view">
                <input type="hidden" name="hostId" value="${escapeHtml(hostId)}" />
                <input type="hidden" name="volumeId" value="${escapeHtml(volume.volume_id)}" />
                <button type="submit">${escapeHtml(volume.volume_title)}</button>
                - ${volume.page_count} pages
              </form>
            </li>
          `).join("")}
        </ul>
      </section>
    `).join("") || "<p>No hosts found for this series.</p>"}
  `));
});

// Receive a host+volume selection from the series page.
// The backend stores that choice under a random token, then redirects to a cleaner public URL.
app.post("/volume-view", async (c) => {
  const form = await c.req.formData();
  const hostId = form.get("hostId");
  const volumeId = form.get("volumeId");

  if (typeof hostId !== "string" || typeof volumeId !== "string") {
    return c.text("Invalid host or volume selection", 400);
  }

  if (!hostSockets.has(hostId)) {
    return c.text("Selected host is offline", 503);
  }

  if (!hostServesVolume(hostId, volumeId)) {
    return c.text("Selected host does not serve that volume", 400);
  }

  const token = crypto.randomUUID();
  createVolumeViewSession(token, hostId, volumeId);
  return c.redirect(`/volume-view/${encodeURIComponent(token)}`);
});

// Render a host-specific volume view using a token rather than exposing the raw host ID in the URL.
// The token maps back to the selected host and volume inside the backend database.
app.get("/volume-view/:token", (c) => {
  const token = c.req.param("token");
  const selection = getVolumeViewSession(token);

  if (!selection) {
    return c.text("Volume view not found", 404);
  }

  const pageCount = countPagesForHostVolume(selection.host_id, selection.volume_id);

  return c.html(renderPage(selection.volume_title, `
    <p><a href="/">Home</a> / <a href="/series/${encodeURIComponent(selection.series_id)}">${escapeHtml(selection.series_title)}</a></p>
    <h1>${escapeHtml(selection.volume_title)}</h1>
    <p>Selected host: ${escapeHtml(selection.host_username)}</p>
    <p>Page count: ${pageCount}</p>
    <p>First page:</p>
    <img src="/volume-view/${encodeURIComponent(token)}/preview" style="max-width: 100%; height: auto;" />
  `));
});

// Fetch the first page preview for the selected host+volume pair.
// This ensures the preview comes from the chosen host instead of any host that happens to have that page.
app.get("/volume-view/:token/preview", async (c) => {
  const token = c.req.param("token");
  const selection = getVolumeViewSession(token);

  if (!selection) {
    return c.text("Volume view not found", 404);
  }

  const firstPage = getFirstPageForHostVolume(selection.host_id, selection.volume_id);
  if (!firstPage) {
    return c.text("No pages found for this host and volume", 404);
  }

  return await relayPageFromHost(selection.host_id, firstPage.id, c);
});

// Relay one page image through the backend.
// The backend looks up a host for the page, requests bytes over WebSocket, then returns a normal HTTP image response.
app.get("/pages/:pageId/image", async (c) => {
  const pageId = c.req.param("pageId");
  const page = getPageById(pageId);

  if (!page) {
    return c.text("Page not found", 404);
  }

  const hostRows = listHostsForPage(pageId);
  const onlineHost = hostRows.find((host) => hostSockets.has(host.id));
  if (!onlineHost) {
    return c.text("No online host available for this page", 503);
  }

  return await relayPageFromHost(onlineHost.id, pageId, c);
});

// Debug endpoint to inspect the raw series rows stored in SQLite.
// Useful when checking whether manifest ingestion worked correctly.
app.get("/debug/series", (c) => {
  return c.json(listDebugSeries());
});

// Debug endpoint to inspect volumes and their current page counts.
// This helps verify that the scanner and manifest registration produced the expected structure.
app.get("/debug/volumes", (c) => {
  return c.json(listDebugVolumes());
});

// Debug endpoint to list all pages for one volume.
// Helpful when checking ordering, IDs, and whether a rescan updated rows correctly.
app.get("/debug/pages/:volumeId", (c) => {
  const volumeId = c.req.param("volumeId");
  return c.json({ volumeId, pages: listDebugPagesForVolume(volumeId) });
});

// Debug endpoint to compare hosts stored in SQLite with hosts currently connected in memory.
// This makes it easier to spot cases where metadata exists but the live socket is offline.
app.get("/debug/hosts", (c) => {
  const hosts = listDebugHosts();

  return c.json({
    connectedHostIds: [...hostSockets.keys()],
    hosts: hosts.map((host) => ({
      ...host,
      online: hostSockets.has(host.id),
    })),
  });
});

// Ask one connected host for a specific page and turn the result into a normal HTTP image response.
// This helper is reused by both the generic page route and the token-based volume preview route.
async function relayPageFromHost(hostId: string, pageId: string, c: { text: (text: string, status?: number) => Response }) {
  const socket = hostSockets.get(hostId);
  if (!socket) {
    return c.text("Host socket missing", 503);
  }

  const requestId = crypto.randomUUID();

  const imagePromise = new Promise<{ bytes: Uint8Array; contentType: string }>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingPageRequests.has(requestId)) {
        pendingPageRequests.delete(requestId);
      }
      reject(new Error("Timed out waiting for host response"));
    }, 10_000);

    pendingPageRequests.set(requestId, {
      hostId,
      pageId,
      contentType: null,
      resolve,
      reject,
      timeoutId,
    });
  });

  socket.send(JSON.stringify({
    type: "page_request",
    requestId,
    pageId,
  }));

  try {
    const image = await imagePromise;

    return new Response(Uint8Array.from(image.bytes), {
      headers: {
        "content-type": image.contentType,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return c.text(`Failed to fetch page from host: ${String(error)}`, 502);
  }
}

// Upgrade an incoming HTTP request into a WebSocket used by a Python host.
// After the socket is open, this function handles manifest registration and page-response messages.
function handleHostWebSocket(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    socket.send(JSON.stringify({
      ok: true,
      message: "Connected to backend. Send register_manifest.",
    }));
  };

  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const message = JSON.parse(event.data) as RegisterManifestMessage | PageResponseHeader | PageErrorMessage;

        if (message.type === "register_manifest") {
          upsertManifest(message);
          hostSockets.set(message.host.id, socket);
          socketHostIds.set(socket, message.host.id);
          socket.send(JSON.stringify({
            ok: true,
            message: `Registered manifest for ${message.host.username}`,
          }));
          return;
        }

        if (message.type === "page_response") {
          const pending = pendingPageRequests.get(message.requestId);
          if (!pending) {
            socket.send(JSON.stringify({ ok: false, error: "Unexpected page response header" }));
            return;
          }

          pending.contentType = message.contentType;
          return;
        }

        if (message.type === "page_error") {
          const pending = pendingPageRequests.get(message.requestId);
          if (!pending) {
            socket.send(JSON.stringify({ ok: false, error: "Unexpected page error" }));
            return;
          }

          clearTimeout(pending.timeoutId);
          pending.reject(new Error(message.error));
          pendingPageRequests.delete(message.requestId);
          return;
        }

        socket.send(JSON.stringify({ ok: false, error: "Unknown message type" }));
      } catch {
        socket.send(JSON.stringify({ ok: false, error: "Invalid JSON message" }));
      }

      return;
    }

    const hostId = socketHostIds.get(socket);
    if (!hostId) {
      socket.send(JSON.stringify({ ok: false, error: "Host not registered yet" }));
      return;
    }

    const pendingEntry = [...pendingPageRequests.entries()].find(([, pending]) => pending.hostId === hostId);
    if (!pendingEntry) {
      socket.send(JSON.stringify({ ok: false, error: "Unexpected binary message" }));
      return;
    }

    const [requestId, pending] = pendingEntry;

    if (!pending.contentType) {
      socket.send(JSON.stringify({ ok: false, error: "Missing page response header before bytes" }));
      return;
    }

    const bytes = event.data instanceof Uint8Array
      ? Uint8Array.from(event.data)
      : new Uint8Array(event.data as ArrayBuffer);

    clearTimeout(pending.timeoutId);
    pending.resolve({ bytes, contentType: pending.contentType });
    pendingPageRequests.delete(requestId);
  };

  socket.onclose = () => {
    const hostId = socketHostIds.get(socket);
    if (hostId) {
      hostSockets.delete(hostId);
      for (const [requestId, pending] of pendingPageRequests.entries()) {
        if (pending.hostId === hostId) {
          clearTimeout(pending.timeoutId);
          pending.reject(new Error("Host disconnected"));
          pendingPageRequests.delete(requestId);
        }
      }
    }
  };

  socket.onerror = () => {
    console.error("Host WebSocket error");
  };

  return response;
}

// Wrap a small HTML fragment in a complete document.
// Keeping this helper separate makes the route handlers easier to read.
function renderPage(title: string, body: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

// Escape user/data values before putting them into raw HTML.
// This avoids broken markup and basic HTML injection in our temporary frontend.
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

Deno.serve({ port: 8000 }, (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/ws/host") {
    return handleHostWebSocket(req);
  }

  return app.fetch(req);
});

console.log("Backend running on http://localhost:8000");
console.log("Host WebSocket endpoint: ws://localhost:8000/ws/host");
