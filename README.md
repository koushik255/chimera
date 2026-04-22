# chimera

This project now uses the Go backend in `go-backend/`.
The old Hono / Deno backend has been removed.

## Project layout

- `go-backend/` — HTTP API + WebSocket host backend
- `frontend/` — SolidJS frontend
- `hoster/` — Python host process that scans files and serves page bytes over WebSocket

## Run the Go backend

```bash
cd go-backend
go run ./cmd/server
```

Default settings:
- `PORT=8000`
- `DATABASE_PATH=./data/app.db`

Optional:

```bash
PORT=8000 DATABASE_PATH=./data/app.db go run ./cmd/server
```

## Run the frontend

```bash
cd frontend
npm install
npm run dev
```

Vite runs on `http://localhost:5173` and proxies `/api` and `/pages` to the Go backend on port `8000`.

## Run the host

```bash
cd hoster
uv sync
edit config.json
uv run chimera-host
```

The desktop host opens a native window with runtime status, shows the local manga library being served, and minimizes to the system tray when the window is closed.

The host cache is intentionally small by default:
- `cachePages: 1` keeps only one page in the in-memory LRU cache
- `cacheBytes` still acts as a byte ceiling
- `maxCacheablePageBytes` prevents unusually large images from being cached at all

For the old terminal-only mode:

```bash
cd hoster
uv run python send_image.py --front
```

The host connects to `/ws/host`, registers its manifest, and serves page bytes back to the Go backend.

## Backend docs

Inside `go-backend/`:
- `explain.md` — concise function overview of `internal/server.go`
- `explain-protocol.md` — concise WebSocket protocol reference
- `explain-sequence.md` — concise request flow walkthrough
- `explain-cheatsheet.md` — short overall summary
