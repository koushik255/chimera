import { Database } from "@db/sqlite";

export type HostInfo = {
  id: string;
  username: string;
};

export type ManifestPage = {
  id: string;
  volumeId: string;
  index: number;
  fileName: string;
  contentType: string;
  fileSize: number;
};

export type ManifestVolume = {
  id: string;
  seriesId: string;
  title: string;
  volumeNumber: number | null;
  pageCount: number;
  pages: ManifestPage[];
};

export type ManifestSeries = {
  id: string;
  title: string;
  volumes: ManifestVolume[];
};

export type RegisterManifestMessage = {
  type: "register_manifest";
  host: HostInfo;
  series: ManifestSeries[];
};

export type HomeSeriesRow = {
  id: string;
  title: string;
  volume_count: number;
};

export type HostRow = {
  id: string;
  username: string;
};

export type SeriesRow = {
  id: string;
  title: string;
};

export type VolumeSummaryRow = {
  id: string;
  title: string;
  volume_number: number | null;
  page_count: number;
};

export type VolumeDetailRow = {
  id: string;
  title: string;
  volume_number: number | null;
  series_id: string;
  series_title: string;
};

export type PagePreviewRow = {
  id: string;
  page_index: number;
  content_type: string;
};

export type PageRow = {
  id: string;
  content_type: string;
};

export type DebugPageRow = {
  id: string;
  volume_id: string;
  page_index: number;
  file_name: string;
  content_type: string;
  file_size: number;
};

export type DebugHostRow = {
  id: string;
  username: string;
  created_at: string;
  updated_at: string;
  page_count: number;
};

export type HostSeriesVolumeRow = {
  host_id: string;
  username: string;
  volume_id: string;
  volume_title: string;
  volume_number: number | null;
  page_count: number;
};

export type VolumeViewSessionRow = {
  id: string;
  host_id: string;
  host_username: string;
  volume_id: string;
  volume_title: string;
  volume_number: number | null;
  series_id: string;
  series_title: string;
};

Deno.mkdirSync("./data", { recursive: true });
const db = new Database("./data/app.db");

setupDatabase();

export function listHomeSeries() {
  return db.prepare(`
    SELECT s.id, s.title, COUNT(DISTINCT v.id) AS volume_count
    FROM series s
    LEFT JOIN volumes v ON v.series_id = s.id
    GROUP BY s.id, s.title
    ORDER BY s.title
  `).all() as HomeSeriesRow[];
}

export function listHosts() {
  return db.prepare(`
    SELECT id, username FROM hosts ORDER BY username
  `).all() as HostRow[];
}

export function getSeriesById(seriesId: string) {
  return db.prepare(`SELECT id, title FROM series WHERE id = ?`).get(seriesId) as SeriesRow | undefined;
}

export function listVolumesForSeries(seriesId: string) {
  return db.prepare(`
    SELECT v.id, v.title, v.volume_number, COUNT(p.id) AS page_count
    FROM volumes v
    LEFT JOIN pages p ON p.volume_id = v.id
    WHERE v.series_id = ?
    GROUP BY v.id, v.title, v.volume_number
    ORDER BY v.volume_number, v.title
  `).all(seriesId) as VolumeSummaryRow[];
}

export function listHostsWithVolumesForSeries(seriesId: string) {
  return db.prepare(`
    SELECT
      h.id AS host_id,
      h.username,
      v.id AS volume_id,
      v.title AS volume_title,
      v.volume_number,
      COUNT(DISTINCT p.id) AS page_count
    FROM hosts h
    JOIN host_pages hp ON hp.host_id = h.id
    JOIN pages p ON p.id = hp.page_id
    JOIN volumes v ON v.id = p.volume_id
    WHERE v.series_id = ?
    GROUP BY h.id, h.username, v.id, v.title, v.volume_number
    ORDER BY h.username, v.volume_number, v.title
  `).all(seriesId) as HostSeriesVolumeRow[];
}

export function getVolumeById(volumeId: string) {
  return db.prepare(`
    SELECT v.id, v.title, v.volume_number, s.id AS series_id, s.title AS series_title
    FROM volumes v
    JOIN series s ON s.id = v.series_id
    WHERE v.id = ?
  `).get(volumeId) as VolumeDetailRow | undefined;
}

export function getFirstPageForVolume(volumeId: string) {
  return db.prepare(`
    SELECT id, page_index, content_type
    FROM pages
    WHERE volume_id = ?
    ORDER BY page_index
    LIMIT 1
  `).get(volumeId) as PagePreviewRow | undefined;
}

export function getFirstPageForHostVolume(hostId: string, volumeId: string) {
  return db.prepare(`
    SELECT p.id, p.page_index, p.content_type
    FROM host_pages hp
    JOIN pages p ON p.id = hp.page_id
    WHERE hp.host_id = ? AND p.volume_id = ?
    ORDER BY p.page_index
    LIMIT 1
  `).get(hostId, volumeId) as PagePreviewRow | undefined;
}

export function countPagesForVolume(volumeId: string) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM pages WHERE volume_id = ?`).get(volumeId) as { count: number };
  return row.count;
}

export function countPagesForHostVolume(hostId: string, volumeId: string) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM host_pages hp
    JOIN pages p ON p.id = hp.page_id
    WHERE hp.host_id = ? AND p.volume_id = ?
  `).get(hostId, volumeId) as { count: number };
  return row.count;
}

export function getPageById(pageId: string) {
  return db.prepare(`SELECT id, content_type FROM pages WHERE id = ?`).get(pageId) as PageRow | undefined;
}

export function listHostsForPage(pageId: string) {
  return db.prepare(`
    SELECT h.id, h.username
    FROM host_pages hp
    JOIN hosts h ON h.id = hp.host_id
    WHERE hp.page_id = ?
    ORDER BY h.username
  `).all(pageId) as HostRow[];
}

export function listDebugSeries() {
  return db.prepare(`SELECT * FROM series ORDER BY title`).all();
}

export function listDebugVolumes() {
  return db.prepare(`
    SELECT v.id, v.series_id, v.title, v.volume_number, COUNT(p.id) AS page_count
    FROM volumes v
    LEFT JOIN pages p ON p.volume_id = v.id
    GROUP BY v.id, v.series_id, v.title, v.volume_number
    ORDER BY v.volume_number, v.title
  `).all();
}

export function listDebugPagesForVolume(volumeId: string) {
  return db.prepare(`
    SELECT id, volume_id, page_index, file_name, content_type, file_size
    FROM pages
    WHERE volume_id = ?
    ORDER BY page_index
  `).all(volumeId) as DebugPageRow[];
}

export function hostServesVolume(hostId: string, volumeId: string) {
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM host_pages hp
    JOIN pages p ON p.id = hp.page_id
    WHERE hp.host_id = ? AND p.volume_id = ?
    LIMIT 1
  `).get(hostId, volumeId) as { ok: number } | undefined;

  return row !== undefined;
}

export function createVolumeViewSession(id: string, hostId: string, volumeId: string) {
  db.prepare(`
    INSERT INTO volume_view_sessions (id, host_id, volume_id)
    VALUES (?, ?, ?)
  `).run(id, hostId, volumeId);
}

export function getVolumeViewSession(id: string) {
  return db.prepare(`
    SELECT
      vvs.id,
      h.id AS host_id,
      h.username AS host_username,
      v.id AS volume_id,
      v.title AS volume_title,
      v.volume_number,
      s.id AS series_id,
      s.title AS series_title
    FROM volume_view_sessions vvs
    JOIN hosts h ON h.id = vvs.host_id
    JOIN volumes v ON v.id = vvs.volume_id
    JOIN series s ON s.id = v.series_id
    WHERE vvs.id = ?
  `).get(id) as VolumeViewSessionRow | undefined;
}

export function listDebugHosts() {
  return db.prepare(`
    SELECT h.id, h.username, h.created_at, h.updated_at, COUNT(hp.page_id) AS page_count
    FROM hosts h
    LEFT JOIN host_pages hp ON hp.host_id = h.id
    GROUP BY h.id, h.username, h.created_at, h.updated_at
    ORDER BY h.username
  `).all() as DebugHostRow[];
}

export function upsertManifest(message: RegisterManifestMessage) {
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO hosts (id, username, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, updated_at = CURRENT_TIMESTAMP
    `).run(message.host.id, message.host.username);

    db.prepare(`DELETE FROM host_pages WHERE host_id = ?`).run(message.host.id);

    for (const series of message.series) {
      db.prepare(`
        INSERT INTO series (id, title)
        VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
      `).run(series.id, series.title);

      for (const volume of series.volumes) {
        db.prepare(`
          INSERT INTO volumes (id, series_id, title, volume_number)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            series_id = excluded.series_id,
            title = excluded.title,
            volume_number = excluded.volume_number
        `).run(volume.id, volume.seriesId, volume.title, volume.volumeNumber);

        for (const page of volume.pages) {
          db.prepare(`
            INSERT INTO pages (id, volume_id, page_index, file_name, content_type, file_size)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              volume_id = excluded.volume_id,
              page_index = excluded.page_index,
              file_name = excluded.file_name,
              content_type = excluded.content_type,
              file_size = excluded.file_size
          `).run(page.id, page.volumeId, page.index, page.fileName, page.contentType, page.fileSize);

          db.prepare(`
            INSERT INTO host_pages (host_id, page_id)
            VALUES (?, ?)
            ON CONFLICT(host_id, page_id) DO NOTHING
          `).run(message.host.id, page.id);
        }
      }
    }

    cleanupOrphanedRows();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function setupDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS volumes (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      title TEXT NOT NULL,
      volume_number INTEGER,
      FOREIGN KEY(series_id) REFERENCES series(id)
    );

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      volume_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      FOREIGN KEY(volume_id) REFERENCES volumes(id)
    );

    CREATE TABLE IF NOT EXISTS host_pages (
      host_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY(host_id, page_id),
      FOREIGN KEY(host_id) REFERENCES hosts(id),
      FOREIGN KEY(page_id) REFERENCES pages(id)
    );

    CREATE TABLE IF NOT EXISTS volume_view_sessions (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      volume_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(host_id) REFERENCES hosts(id),
      FOREIGN KEY(volume_id) REFERENCES volumes(id)
    );
  `);
}

function cleanupOrphanedRows() {
  db.prepare(`
    DELETE FROM pages
    WHERE id NOT IN (SELECT DISTINCT page_id FROM host_pages)
  `).run();

  db.prepare(`
    DELETE FROM volumes
    WHERE id NOT IN (SELECT DISTINCT volume_id FROM pages)
  `).run();

  db.prepare(`
    DELETE FROM series
    WHERE id NOT IN (SELECT DISTINCT series_id FROM volumes)
  `).run();
}
