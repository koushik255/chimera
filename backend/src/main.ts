import { Hono } from "hono";
import { registerApiRoutes } from "./api.ts";
import {
  getPageById,
  getPageIdForVolumeViewSession,
  getVolumeViewSession,
  listHostsForPage,
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

registerApiRoutes(app, { hostSockets });

// Fetch the first page preview for the selected host+volume pair.
// This ensures the preview comes from the chosen host instead of any host that happens to have that page.
app.get("/api/volume-view/:token/preview", async (c) => {
  const token = c.req.param("token");
  const selection = getVolumeViewSession(token);

  if (!selection) {
    return c.text("Volume view not found", 404);
  }

  const firstPageId = selection.page_ids[0];
  if (!firstPageId) {
    return c.text("No pages found for this host and volume", 404);
  }

  return await relayPageFromHost(selection.host_id, firstPageId, c);
});

// Relay a page image by reader page index using the precomputed session page order.
// This avoids re-querying the database for host+volume page mapping on every page turn.
app.get("/api/volume-view/:token/page/:pageIndex/image", async (c) => {
  const token = c.req.param("token");
  const pageIndex = Number(c.req.param("pageIndex"));

  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    return c.text("Invalid page index", 400);
  }

  const selection = getVolumeViewSession(token);
  if (!selection) {
    return c.text("Volume view not found", 404);
  }

  const pageId = getPageIdForVolumeViewSession(token, pageIndex);
  if (!pageId) {
    return c.text("Page not found", 404);
  }

  return await relayPageFromHost(selection.host_id, pageId, c);
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

Deno.serve({ port: 8000 }, (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/ws/host") {
    return handleHostWebSocket(req);
  }

  if (url.pathname === "/") {
    return Response.json({ ok: true, message: "chimera backend running" });
  }

  return app.fetch(req);
});

console.log("Backend running on http://localhost:8000");
console.log("Host WebSocket endpoint: ws://localhost:8000/ws/host");
