import { Hono } from "hono";
import {
  countPagesForVolume,
  getFirstPageForVolume,
  getPageById,
  getSeriesById,
  getVolumeById,
  listDebugHosts,
  listDebugPagesForVolume,
  listDebugSeries,
  listDebugVolumes,
  listHomeSeries,
  listHosts,
  listHostsForPage,
  listVolumesForSeries,
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

// Show one series and list its volumes from the database.
// The :seriesId part comes from the URL path parameter.
app.get("/series/:seriesId", (c) => {
  const seriesId = c.req.param("seriesId");
  const series = getSeriesById(seriesId);

  if (!series) {
    return c.text("Series not found", 404);
  }

  const volumes = listVolumesForSeries(seriesId);

  return c.html(renderPage(series.title, `
    <p><a href="/">Back</a></p>
    <h1>${escapeHtml(series.title)}</h1>
    <ul>
      ${volumes.map((volume) => `<li><a href="/volumes/${encodeURIComponent(volume.id)}">${escapeHtml(volume.title)}</a> - ${volume.page_count} pages</li>`).join("")}
    </ul>
  `));
});

// Show one volume and preview its first page image.
// This lets us test DB lookup + live image relay without a full reader yet.
app.get("/volumes/:volumeId", (c) => {
  const volumeId = c.req.param("volumeId");
  const volume = getVolumeById(volumeId);

  if (!volume) {
    return c.text("Volume not found", 404);
  }

  const firstPage = getFirstPageForVolume(volumeId);
  const pageCount = countPagesForVolume(volumeId);

  return c.html(renderPage(volume.title, `
    <p><a href="/">Home</a> / <a href="/series/${encodeURIComponent(volume.series_id)}">${escapeHtml(volume.series_title)}</a></p>
    <h1>${escapeHtml(volume.title)}</h1>
    <p>Page count: ${pageCount}</p>
    ${firstPage ? `<p>First page:</p><img src="/pages/${encodeURIComponent(firstPage.id)}/image" style="max-width: 100%; height: auto;" />` : "<p>No pages found.</p>"}
  `));
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

  const socket = hostSockets.get(onlineHost.id);
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
      hostId: onlineHost.id,
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
