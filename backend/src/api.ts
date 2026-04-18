import type { Hono } from "hono";
import {
  createVolumeViewSession,
  getSeriesById,
  getVolumeViewSession,
  hostServesVolume,
  listHomeSeries,
  listHostsWithVolumesForSeries,
  listPageIdsForHostVolume,
} from "./db.ts";

type ApiDeps = {
  hostSockets: Map<string, WebSocket>;
};

// Register JSON API routes used by the Solid frontend.
// These endpoints mirror the current HTML flow, but return structured data instead.
export function registerApiRoutes(app: Hono, deps: ApiDeps) {
  app.get("/api/series", (c) => {
    return c.json({
      series: listHomeSeries(),
    });
  });

  app.get("/api/series/:seriesId", (c) => {
    const seriesId = c.req.param("seriesId");
    const series = getSeriesById(seriesId);

    if (!series) {
      return c.json({ error: "Series not found" }, 404);
    }

    const rows = listHostsWithVolumesForSeries(seriesId);
    const onlineRows = rows.filter((row) => deps.hostSockets.has(row.host_id));
    const hosts = new Map<string, {
      hostId: string;
      username: string;
      online: boolean;
      volumes: Array<{
        id: string;
        title: string;
        volumeNumber: number | null;
        pageCount: number;
      }>;
    }>();

    for (const row of onlineRows) {
      const existing = hosts.get(row.host_id);
      if (existing) {
        existing.volumes.push({
          id: row.volume_id,
          title: row.volume_title,
          volumeNumber: row.volume_number,
          pageCount: row.page_count,
        });
        continue;
      }

      hosts.set(row.host_id, {
        hostId: row.host_id,
        username: row.username,
        online: true,
        volumes: [{
          id: row.volume_id,
          title: row.volume_title,
          volumeNumber: row.volume_number,
          pageCount: row.page_count,
        }],
      });
    }

    return c.json({
      series,
      hosts: [...hosts.values()],
    });
  });

  app.post("/api/volume-view", async (c) => {
    const body = await c.req.json().catch(() => null) as { hostId?: string; volumeId?: string } | null;

    if (!body?.hostId || !body?.volumeId) {
      return c.json({ error: "Invalid host or volume selection" }, 400);
    }

    if (!deps.hostSockets.has(body.hostId)) {
      return c.json({ error: "Selected host is offline" }, 503);
    }

    if (!hostServesVolume(body.hostId, body.volumeId)) {
      return c.json({ error: "Selected host does not serve that volume" }, 400);
    }

    const token = crypto.randomUUID();
    const pageIds = listPageIdsForHostVolume(body.hostId, body.volumeId);
    createVolumeViewSession(token, body.hostId, body.volumeId, pageIds);

    return c.json({ token, url: `/volume-view/${token}` });
  });

  app.get("/api/volume-view/:token", (c) => {
    const token = c.req.param("token");
    const selection = getVolumeViewSession(token);

    if (!selection) {
      return c.json({ error: "Volume view not found" }, 404);
    }

    return c.json({
      token,
      host: {
        id: selection.host_id,
        username: selection.host_username,
        online: deps.hostSockets.has(selection.host_id),
      },
      series: {
        id: selection.series_id,
        title: selection.series_title,
      },
      volume: {
        id: selection.volume_id,
        title: selection.volume_title,
        volumeNumber: selection.volume_number,
        pageCount: selection.page_ids.length,
      },
      previewImageUrl: `/api/volume-view/${token}/preview`,
      readerUrl: `/read/${token}`,
    });
  });
}
