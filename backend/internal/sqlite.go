package internal

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(databasePath string) (*SQLiteStore, error) {
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := configureSQLite(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}

	store := &SQLiteStore{db: db}
	if err := store.setup(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}

	return store, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func (s *SQLiteStore) ListHomeSeries(ctx context.Context) ([]HomeSeriesRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT s.id, s.title, COUNT(DISTINCT v.id) AS volume_count
		FROM series s
		LEFT JOIN volumes v ON v.series_id = s.id
		GROUP BY s.id, s.title
		ORDER BY s.title
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []HomeSeriesRow
	for rows.Next() {
		var row HomeSeriesRow
		if err := rows.Scan(&row.ID, &row.Title, &row.VolumeCount); err != nil {
			return nil, err
		}
		result = append(result, row)
	}

	return result, rows.Err()
}

func (s *SQLiteStore) GetSeriesByID(ctx context.Context, seriesID string) (*SeriesRow, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, title FROM series WHERE id = ?`, seriesID)

	var series SeriesRow
	if err := row.Scan(&series.ID, &series.Title); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	return &series, nil
}

func (s *SQLiteStore) ListHostsWithVolumesForSeries(ctx context.Context, seriesID string) ([]HostSeriesVolumeRow, error) {
	rows, err := s.db.QueryContext(ctx, `
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
	`, seriesID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []HostSeriesVolumeRow
	for rows.Next() {
		var row HostSeriesVolumeRow
		if err := rows.Scan(&row.HostID, &row.Username, &row.VolumeID, &row.VolumeTitle, &row.VolumeNumber, &row.PageCount); err != nil {
			return nil, err
		}
		result = append(result, row)
	}

	return result, rows.Err()
}

func (s *SQLiteStore) HostServesVolume(ctx context.Context, hostID, volumeID string) (bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT 1 AS ok
		FROM host_pages hp
		JOIN pages p ON p.id = hp.page_id
		WHERE hp.host_id = ? AND p.volume_id = ?
		LIMIT 1
	`, hostID, volumeID)

	var ok int
	if err := row.Scan(&ok); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}

	return true, nil
}

func (s *SQLiteStore) ListPageIDsForHostVolume(ctx context.Context, hostID, volumeID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT p.id
		FROM host_pages hp
		JOIN pages p ON p.id = hp.page_id
		WHERE hp.host_id = ? AND p.volume_id = ?
		ORDER BY p.page_index
	`, hostID, volumeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var pageID string
		if err := rows.Scan(&pageID); err != nil {
			return nil, err
		}
		result = append(result, pageID)
	}

	return result, rows.Err()
}

func (s *SQLiteStore) CreateVolumeViewSession(ctx context.Context, id, hostID, volumeID string, pageIDs []string) error {
	pageIDsJSON, err := json.Marshal(pageIDs)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO volume_view_sessions (id, host_id, volume_id, page_ids_json)
		VALUES (?, ?, ?, ?)
	`, id, hostID, volumeID, string(pageIDsJSON))
	return err
}

func (s *SQLiteStore) GetVolumeViewSession(ctx context.Context, id string) (*VolumeViewSessionRow, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT
			vvs.id,
			h.id AS host_id,
			h.username AS host_username,
			v.id AS volume_id,
			v.title AS volume_title,
			v.volume_number,
			s.id AS series_id,
			s.title AS series_title,
			vvs.page_ids_json
		FROM volume_view_sessions vvs
		JOIN hosts h ON h.id = vvs.host_id
		JOIN volumes v ON v.id = vvs.volume_id
		JOIN series s ON s.id = v.series_id
		WHERE vvs.id = ?
	`, id)

	var session VolumeViewSessionRow
	var pageIDsJSON sql.NullString
	if err := row.Scan(
		&session.ID,
		&session.HostID,
		&session.HostUsername,
		&session.VolumeID,
		&session.VolumeTitle,
		&session.VolumeNumber,
		&session.SeriesID,
		&session.SeriesTitle,
		&pageIDsJSON,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	if pageIDsJSON.Valid && pageIDsJSON.String != "" {
		if err := json.Unmarshal([]byte(pageIDsJSON.String), &session.PageIDs); err != nil {
			return nil, err
		}
	}

	return &session, nil
}

func (s *SQLiteStore) GetPageByID(ctx context.Context, pageID string) (*PageRow, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, content_type FROM pages WHERE id = ?`, pageID)

	var page PageRow
	if err := row.Scan(&page.ID, &page.ContentType); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	return &page, nil
}

func (s *SQLiteStore) ListHostsForPage(ctx context.Context, pageID string) ([]HostRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT h.id, h.username
		FROM host_pages hp
		JOIN hosts h ON h.id = hp.host_id
		WHERE hp.page_id = ?
		ORDER BY h.username
	`, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []HostRow
	for rows.Next() {
		var row HostRow
		if err := rows.Scan(&row.ID, &row.Username); err != nil {
			return nil, err
		}
		result = append(result, row)
	}

	return result, rows.Err()
}

func (s *SQLiteStore) UpsertManifest(ctx context.Context, message RegisterManifestMessage) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	upsertHostStmt, err := tx.PrepareContext(ctx, `
		INSERT INTO hosts (id, username, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(id) DO UPDATE SET username = excluded.username, updated_at = CURRENT_TIMESTAMP
	`)
	if err != nil {
		return err
	}
	defer upsertHostStmt.Close()

	deleteHostPagesStmt, err := tx.PrepareContext(ctx, `DELETE FROM host_pages WHERE host_id = ?`)
	if err != nil {
		return err
	}
	defer deleteHostPagesStmt.Close()

	upsertSeriesStmt, err := tx.PrepareContext(ctx, `
		INSERT INTO series (id, title)
		VALUES (?, ?)
		ON CONFLICT(id) DO UPDATE SET title = excluded.title
	`)
	if err != nil {
		return err
	}
	defer upsertSeriesStmt.Close()

	upsertVolumeStmt, err := tx.PrepareContext(ctx, `
		INSERT INTO volumes (id, series_id, title, volume_number)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			series_id = excluded.series_id,
			title = excluded.title,
			volume_number = excluded.volume_number
	`)
	if err != nil {
		return err
	}
	defer upsertVolumeStmt.Close()

	upsertPageStmt, err := tx.PrepareContext(ctx, `
		INSERT INTO pages (id, volume_id, page_index, file_name, content_type, file_size)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			volume_id = excluded.volume_id,
			page_index = excluded.page_index,
			file_name = excluded.file_name,
			content_type = excluded.content_type,
			file_size = excluded.file_size
	`)
	if err != nil {
		return err
	}
	defer upsertPageStmt.Close()

	insertHostPageStmt, err := tx.PrepareContext(ctx, `
		INSERT INTO host_pages (host_id, page_id)
		VALUES (?, ?)
		ON CONFLICT(host_id, page_id) DO NOTHING
	`)
	if err != nil {
		return err
	}
	defer insertHostPageStmt.Close()

	if _, err := upsertHostStmt.ExecContext(ctx, message.Host.ID, message.Host.Username); err != nil {
		return err
	}
	if _, err := deleteHostPagesStmt.ExecContext(ctx, message.Host.ID); err != nil {
		return err
	}

	for _, series := range message.Series {
		if _, err := upsertSeriesStmt.ExecContext(ctx, series.ID, series.Title); err != nil {
			return err
		}

		for _, volume := range series.Volumes {
			if _, err := upsertVolumeStmt.ExecContext(ctx, volume.ID, volume.SeriesID, volume.Title, volume.VolumeNumber); err != nil {
				return err
			}

			for _, page := range volume.Pages {
				if _, err := upsertPageStmt.ExecContext(ctx, page.ID, page.VolumeID, page.Index, page.FileName, page.ContentType, page.FileSize); err != nil {
					return err
				}

				if _, err := insertHostPageStmt.ExecContext(ctx, message.Host.ID, page.ID); err != nil {
					return err
				}
			}
		}
	}

	if err := s.cleanupOrphanedRows(ctx, tx); err != nil {
		return err
	}

	return tx.Commit()
}

func configureSQLite(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		return fmt.Errorf("enable foreign keys: %w", err)
	}
	if _, err := db.ExecContext(ctx, `PRAGMA busy_timeout = 5000`); err != nil {
		return fmt.Errorf("set busy timeout: %w", err)
	}

	return nil
}

func (s *SQLiteStore) setup(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `
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
			page_ids_json TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(host_id) REFERENCES hosts(id),
			FOREIGN KEY(volume_id) REFERENCES volumes(id)
		);
	`); err != nil {
		return err
	}

	if _, err := s.db.ExecContext(ctx, `ALTER TABLE volume_view_sessions ADD COLUMN page_ids_json TEXT`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("add page_ids_json column: %w", err)
	}

	return nil
}

func (s *SQLiteStore) cleanupOrphanedRows(ctx context.Context, tx *sql.Tx) error {
	queries := []string{
		`DELETE FROM volume_view_sessions WHERE host_id NOT IN (SELECT id FROM hosts)`,
		`DELETE FROM volume_view_sessions WHERE volume_id NOT IN (SELECT id FROM volumes)`,
		`DELETE FROM pages WHERE id NOT IN (SELECT DISTINCT page_id FROM host_pages)`,
		`DELETE FROM volume_view_sessions WHERE volume_id NOT IN (SELECT DISTINCT volume_id FROM pages)`,
		`DELETE FROM volumes WHERE id NOT IN (SELECT DISTINCT volume_id FROM pages)`,
		`DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM volumes)`,
	}

	for _, query := range queries {
		if _, err := tx.ExecContext(ctx, query); err != nil {
			return err
		}
	}

	return nil
}
