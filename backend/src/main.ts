import { Hono } from "hono";
import { registerApiRoutes } from "./api.ts";
import {
  getPageById,
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

type CancelPageRequestMessage = {
  type: "cancel_page_request";
  requestId: string;
};

type PendingPageRequest = {
  hostId: string;
  pageId: string;
  sessionKey: string | null;
  contentType: string | null;
  resolve: (value: { bytes: Uint8Array; contentType: string }) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

const app = new Hono();
const hostSockets = new Map<string, WebSocket>();
const socketHostIds = new WeakMap<WebSocket, string>();
const pendingPageRequests = new Map<string, PendingPageRequest>();
const pendingRequestIdsBySession = new Map<string, string>();

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

  return await relayPageFromHost(selection.host_id, firstPageId, c, `volume-preview:${token}`);
});

// Relay a page image by reader page index using the precomputed session page order.
// This avoids re-querying the database for host+volume page mapping on every page turn.
app.get("/api/volume-view/:token/page/:pageIndex/image", async (c) => {
  const token = c.req.param("token");
  const pageIndex = Number(c.req.param("pageIndex"));
  const requestKind = c.req.query("prefetch") === "1" ? "prefetch" : "active";

  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    return c.text("Invalid page index", 400);
  }

  const selection = getVolumeViewSession(token);
  if (!selection) {
    return c.text("Volume view not found", 404);
  }

  const pageId = selection.page_ids[pageIndex - 1];
  if (!pageId) {
    return c.text("Page not found", 404);
  }

  return await relayPageFromHost(selection.host_id, pageId, c, `volume-reader:${token}:${requestKind}`);
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

  return await relayPageFromHost(onlineHost.id, pageId, c, null);
});


// Ask one connected host for a specific page and turn the result into a normal HTTP image response.
// This helper is reused by both the generic page route and the token-based volume preview route.
async function relayPageFromHost(
  hostId: string,
  pageId: string,
  c: { text: (text: string, status?: number) => Response },
  sessionKey: string | null,
) {
  const socket = hostSockets.get(hostId);
  if (!socket) {
    return c.text("Host socket missing", 503);
  }

  const requestId = crypto.randomUUID();

  const imagePromise = new Promise<{ bytes: Uint8Array; contentType: string }>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      failPendingPageRequest(requestId, new Error("Timed out waiting for host response"));
    }, 10_000);

    pendingPageRequests.set(requestId, {
      hostId,
      pageId,
      sessionKey,
      contentType: null,
      resolve,
      reject,
      timeoutId,
    });

    replacePendingSessionRequest(hostId, sessionKey, requestId);
  });

  socket.send(JSON.stringify({
    type: "page_request",
    requestId,
    pageId,
    sessionKey,
  }));

  try {
    const image = await imagePromise;

    return new Response(image.bytes.buffer as ArrayBuffer, {
      headers: {
        "content-type": image.contentType,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return c.text(`Failed to fetch page from host: ${String(error)}`, 502);
  }
}

function replacePendingSessionRequest(hostId: string, sessionKey: string | null, nextRequestId: string) {
  if (!sessionKey) {
    return;
  }

  const previousRequestId = pendingRequestIdsBySession.get(sessionKey);
  const socket = hostSockets.get(hostId);

  if (previousRequestId) {
    if (socket) {
      socket.send(JSON.stringify({
        type: "cancel_page_request",
        requestId: previousRequestId,
      } satisfies CancelPageRequestMessage));
    }

    failPendingPageRequest(previousRequestId, new Error("Superseded by a newer page request"));
  }

  pendingRequestIdsBySession.set(sessionKey, nextRequestId);
}

function failPendingPageRequest(requestId: string, error: Error) {
  const pending = pendingPageRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingPageRequests.delete(requestId);
  clearPendingSessionRequest(pending.sessionKey, requestId);
  pending.reject(error);
}

function finishPendingPageRequest(requestId: string, bytes: Uint8Array) {
  const pending = pendingPageRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingPageRequests.delete(requestId);
  clearPendingSessionRequest(pending.sessionKey, requestId);

  if (!pending.contentType) {
    pending.reject(new Error("Missing content type for page response"));
  } else {
    pending.resolve({ bytes, contentType: pending.contentType });
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
        const message = JSON.parse(event.data) as RegisterManifestMessage | PageErrorMessage;

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

        if (message.type === "page_error") {
          const pending = pendingPageRequests.get(message.requestId);
          if (!pending) {
            return;
          }

          failPendingPageRequest(message.requestId, new Error(message.error));
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

    const bytes = event.data instanceof Uint8Array
      ? Uint8Array.from(event.data)
      : new Uint8Array(event.data as ArrayBuffer);

    const separator = findBinaryHeaderSeparator(bytes);
    if (separator === -1) {
      socket.send(JSON.stringify({ ok: false, error: "Invalid binary page response envelope" }));
      return;
    }

    let header: PageResponseHeader;
    try {
      const headerText = new TextDecoder().decode(bytes.slice(0, separator));
      header = JSON.parse(headerText) as PageResponseHeader;
    } catch {
      socket.send(JSON.stringify({ ok: false, error: "Invalid binary page response header" }));
      return;
    }

    if (header.type !== "page_response") {
      socket.send(JSON.stringify({ ok: false, error: "Unexpected binary message type" }));
      return;
    }

    const pending = pendingPageRequests.get(header.requestId);
    if (!pending) {
      return;
    }

    if (pending.hostId !== hostId) {
      socket.send(JSON.stringify({ ok: false, error: "Mismatched host for page response" }));
      return;
    }

    pending.contentType = header.contentType;
    finishPendingPageRequest(header.requestId, bytes.slice(separator + 2));
  };

  socket.onclose = () => {
    const hostId = socketHostIds.get(socket);
    if (hostId) {
      hostSockets.delete(hostId);
      for (const [requestId, pending] of pendingPageRequests.entries()) {
        if (pending.hostId === hostId) {
          failPendingPageRequest(requestId, new Error("Host disconnected"));
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

function findBinaryHeaderSeparator(bytes: Uint8Array) {
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) {
      return index;
    }
  }

  return -1;
}

function clearPendingSessionRequest(sessionKey: string | null, requestId: string) {
  if (!sessionKey) {
    return;
  }

  if (pendingRequestIdsBySession.get(sessionKey) === requestId) {
    pendingRequestIdsBySession.delete(sessionKey);
  }
}
