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
cd /home/koushikk/chimera_hoster
go run .
```

The hoster is now available as a standalone Go program in `/home/koushikk/chimera_hoster`, with its own `config.json`.

Useful commands:

```bash
cd /home/koushikk/chimera_hoster
go run . -check
go run . -dump-manifest
```

- `--check` validates the config and scans the manga library without starting the websocket host
- `--dump-manifest` prints the generated registration payload

The host connects to `/ws/host`, registers its manifest, and serves page bytes back to the Go backend.

## Backend docs

Inside `go-backend/`:
- `explain.md` — concise function overview of `internal/server.go`
- `explain-protocol.md` — concise WebSocket protocol reference
- `explain-sequence.md` — concise request flow walkthrough
- `explain-cheatsheet.md` — short overall summary
