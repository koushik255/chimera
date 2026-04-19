package internal

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const pageRequestTimeout = 10 * time.Second

type App struct {
	cfg   Config
	store *SQLiteStore

	mu                      sync.RWMutex
	hostSockets             map[string]*hostSocket
	pendingPageRequests     map[string]*pendingPageRequest
	pendingRequestIDsBySess map[string]string

	upgrader websocket.Upgrader
}

type hostSocket struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type pendingPageRequest struct {
	hostID      string
	pageID      string
	sessionKey  string
	contentType string
	resultCh    chan pageResult
	timer       *time.Timer
}

type pageResult struct {
	bytes       []byte
	contentType string
	err         error
}

func New(cfg Config, sqliteStore *SQLiteStore) *App {
	return &App{
		cfg:                     cfg,
		store:                   sqliteStore,
		hostSockets:             make(map[string]*hostSocket),
		pendingPageRequests:     make(map[string]*pendingPageRequest),
		pendingRequestIDsBySess: make(map[string]string),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(_ *http.Request) bool { return true },
		},
	}
}

func (a *App) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", a.handleRoot)
	mux.HandleFunc("GET /api/series", a.handleListSeries)
	mux.HandleFunc("GET /api/series/{seriesId}", a.handleGetSeries)
	mux.HandleFunc("POST /api/volume-view", a.handleCreateVolumeView)
	mux.HandleFunc("GET /api/volume-view/{token}", a.handleGetVolumeView)
	mux.HandleFunc("GET /api/volume-view/{token}/preview", a.handlePreviewImage)
	mux.HandleFunc("GET /api/volume-view/{token}/page/{pageIndex}/image", a.handleVolumePageImage)
	mux.HandleFunc("GET /pages/{pageId}/image", a.handlePageImage)
	mux.HandleFunc("GET /ws/host", a.handleHostWebSocket)
	return mux
}

func (a *App) handleRoot(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "chimera backend running"})
}

func (a *App) handleListSeries(w http.ResponseWriter, r *http.Request) {
	series, err := a.store.ListHomeSeries(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"series": series})
}

func (a *App) handleGetSeries(w http.ResponseWriter, r *http.Request) {
	seriesID := r.PathValue("seriesId")
	series, err := a.store.GetSeriesByID(r.Context(), seriesID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if series == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Series not found"})
		return
	}

	rows, err := a.store.ListHostsWithVolumesForSeries(r.Context(), seriesID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	type volume struct {
		ID           string `json:"id"`
		Title        string `json:"title"`
		VolumeNumber *int   `json:"volumeNumber"`
		PageCount    int    `json:"pageCount"`
	}
	type host struct {
		HostID   string   `json:"hostId"`
		Username string   `json:"username"`
		Online   bool     `json:"online"`
		Volumes  []volume `json:"volumes"`
	}

	hosts := make(map[string]*host)
	for _, row := range rows {
		if !a.hasHostSocket(row.HostID) {
			continue
		}

		existing := hosts[row.HostID]
		if existing == nil {
			existing = &host{
				HostID:   row.HostID,
				Username: row.Username,
				Online:   true,
			}
			hosts[row.HostID] = existing
		}

		existing.Volumes = append(existing.Volumes, volume{
			ID:           row.VolumeID,
			Title:        row.VolumeTitle,
			VolumeNumber: row.VolumeNumber,
			PageCount:    row.PageCount,
		})
	}

	result := make([]host, 0, len(hosts))
	for _, current := range hosts {
		result = append(result, *current)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Username == result[j].Username {
			return result[i].HostID < result[j].HostID
		}
		return result[i].Username < result[j].Username
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"series": series,
		"hosts":  result,
	})
}

func (a *App) handleCreateVolumeView(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HostID   string `json:"hostId"`
		VolumeID string `json:"volumeId"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || body.HostID == "" || body.VolumeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid host or volume selection"})
		return
	}

	if !a.hasHostSocket(body.HostID) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Selected host is offline"})
		return
	}

	ok, err := a.store.HostServesVolume(r.Context(), body.HostID, body.VolumeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Selected host does not serve that volume"})
		return
	}

	token := newID()
	pageIDs, err := a.store.ListPageIDsForHostVolume(r.Context(), body.HostID, body.VolumeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := a.store.CreateVolumeViewSession(r.Context(), token, body.HostID, body.VolumeID, pageIDs); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"token": token,
		"url":   "/volume-view/" + token,
	})
}

func (a *App) handleGetVolumeView(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	selection, err := a.store.GetVolumeViewSession(r.Context(), token)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if selection == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Volume view not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"host": map[string]any{
			"id":       selection.HostID,
			"username": selection.HostUsername,
			"online":   a.hasHostSocket(selection.HostID),
		},
		"series": map[string]any{
			"id":    selection.SeriesID,
			"title": selection.SeriesTitle,
		},
		"volume": map[string]any{
			"id":           selection.VolumeID,
			"title":        selection.VolumeTitle,
			"volumeNumber": selection.VolumeNumber,
			"pageCount":    len(selection.PageIDs),
		},
		"previewImageUrl": "/api/volume-view/" + token + "/preview",
		"readerUrl":       "/read/" + token,
	})
}

func (a *App) handlePreviewImage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	selection, err := a.store.GetVolumeViewSession(r.Context(), token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if selection == nil {
		http.Error(w, "Volume view not found", http.StatusNotFound)
		return
	}
	if len(selection.PageIDs) == 0 {
		http.Error(w, "No pages found for this host and volume", http.StatusNotFound)
		return
	}

	a.relayPageFromHost(w, r, selection.HostID, selection.PageIDs[0], "volume-preview:"+token)
}

func (a *App) handleVolumePageImage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	pageIndex, err := strconv.Atoi(r.PathValue("pageIndex"))
	if err != nil || pageIndex < 1 {
		http.Error(w, "Invalid page index", http.StatusBadRequest)
		return
	}

	requestKind := "active"
	if r.URL.Query().Get("prefetch") == "1" {
		requestKind = "prefetch"
	}

	selection, err := a.store.GetVolumeViewSession(r.Context(), token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if selection == nil {
		http.Error(w, "Volume view not found", http.StatusNotFound)
		return
	}

	if pageIndex > len(selection.PageIDs) {
		http.Error(w, "Page not found", http.StatusNotFound)
		return
	}

	pageID := selection.PageIDs[pageIndex-1]
	a.relayPageFromHost(w, r, selection.HostID, pageID, "volume-reader:"+token+":"+requestKind)
}

func (a *App) handlePageImage(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("pageId")
	page, err := a.store.GetPageByID(r.Context(), pageID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if page == nil {
		http.Error(w, "Page not found", http.StatusNotFound)
		return
	}

	hostRows, err := a.store.ListHostsForPage(r.Context(), pageID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var onlineHostID string
	for _, host := range hostRows {
		if a.hasHostSocket(host.ID) {
			onlineHostID = host.ID
			break
		}
	}
	if onlineHostID == "" {
		http.Error(w, "No online host available for this page", http.StatusServiceUnavailable)
		return
	}

	a.relayPageFromHost(w, r, onlineHostID, page.ID, "")
}

func (a *App) relayPageFromHost(w http.ResponseWriter, r *http.Request, hostID, pageID, sessionKey string) {
	socket := a.getHostSocket(hostID)
	if socket == nil {
		http.Error(w, "Host socket missing", http.StatusServiceUnavailable)
		return
	}

	requestID := newID()
	resultCh := make(chan pageResult, 1)
	timer := time.AfterFunc(pageRequestTimeout, func() {
		a.failPendingPageRequest(requestID, errors.New("Timed out waiting for host response"))
	})

	a.mu.Lock()
	a.pendingPageRequests[requestID] = &pendingPageRequest{
		hostID:     hostID,
		pageID:     pageID,
		sessionKey: sessionKey,
		resultCh:   resultCh,
		timer:      timer,
	}
	a.replacePendingSessionRequestLocked(hostID, sessionKey, requestID)
	a.mu.Unlock()

	if err := socket.writeJSON(map[string]any{
		"type":       "page_request",
		"requestId":  requestID,
		"pageId":     pageID,
		"sessionKey": nullIfEmpty(sessionKey),
	}); err != nil {
		a.failPendingPageRequest(requestID, err)
		http.Error(w, "Failed to fetch page from host: "+err.Error(), http.StatusBadGateway)
		return
	}

	select {
	case result := <-resultCh:
		if result.err != nil {
			http.Error(w, "Failed to fetch page from host: "+result.err.Error(), http.StatusBadGateway)
			return
		}

		w.Header().Set("content-type", result.contentType)
		w.Header().Set("cache-control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result.bytes)
	case <-r.Context().Done():
		a.failPendingPageRequest(requestID, r.Context().Err())
	}
}

func (a *App) handleHostWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	socket := &hostSocket{conn: conn}
	_ = socket.writeJSON(map[string]any{
		"ok":      true,
		"message": "Connected to backend. Send register_manifest.",
	})

	var hostID string
	defer func() {
		if hostID != "" {
			a.unregisterHost(hostID, socket)
			a.failPendingRequestsForHost(hostID, errors.New("Host disconnected"))
		}
		_ = conn.Close()
	}()

	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("host websocket error: %v", err)
			}
			return
		}

		switch messageType {
		case websocket.TextMessage:
			var envelope struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(payload, &envelope); err != nil {
				_ = socket.writeJSON(map[string]any{"ok": false, "error": "Invalid JSON message"})
				continue
			}

			switch envelope.Type {
			case "register_manifest":
				var message RegisterManifestMessage
				if err := json.Unmarshal(payload, &message); err != nil {
					_ = socket.writeJSON(map[string]any{"ok": false, "error": "Invalid JSON message"})
					continue
				}
				if err := a.store.UpsertManifest(r.Context(), message); err != nil {
					_ = socket.writeJSON(map[string]any{"ok": false, "error": err.Error()})
					continue
				}

				if hostID != "" && hostID != message.Host.ID {
					a.unregisterHost(hostID, socket)
				}

				hostID = message.Host.ID
				a.registerHost(hostID, socket)
				_ = socket.writeJSON(map[string]any{
					"ok":      true,
					"message": "Registered manifest for " + message.Host.Username,
				})

			case "page_error":
				var message PageErrorMessage
				if err := json.Unmarshal(payload, &message); err != nil {
					_ = socket.writeJSON(map[string]any{"ok": false, "error": "Invalid JSON message"})
					continue
				}
				a.failPendingPageRequest(message.RequestID, errors.New(message.Error))

			default:
				_ = socket.writeJSON(map[string]any{"ok": false, "error": "Unknown message type"})
			}

		case websocket.BinaryMessage:
			if hostID == "" {
				_ = socket.writeJSON(map[string]any{"ok": false, "error": "Host not registered yet"})
				continue
			}

			separator := findBinaryHeaderSeparator(payload)
			if separator == -1 {
				_ = socket.writeJSON(map[string]any{"ok": false, "error": "Invalid binary page response envelope"})
				continue
			}

			var header PageResponseHeader
			if err := json.Unmarshal(payload[:separator], &header); err != nil {
				_ = socket.writeJSON(map[string]any{"ok": false, "error": "Invalid binary page response header"})
				continue
			}
			if header.Type != "page_response" {
				_ = socket.writeJSON(map[string]any{"ok": false, "error": "Unexpected binary message type"})
				continue
			}

			a.finishPendingPageRequest(hostID, header.RequestID, header.ContentType, payload[separator+2:])
		default:
			_ = socket.writeJSON(map[string]any{"ok": false, "error": "Unsupported websocket message type"})
		}
	}
}

func (a *App) registerHost(hostID string, socket *hostSocket) {
	a.mu.Lock()
	previousSocket := a.hostSockets[hostID]
	a.hostSockets[hostID] = socket
	a.mu.Unlock()

	if previousSocket != nil && previousSocket != socket {
		_ = previousSocket.conn.Close()
	}
}

func (a *App) unregisterHost(hostID string, socket *hostSocket) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.hostSockets[hostID] == socket {
		delete(a.hostSockets, hostID)
	}
}

func (a *App) getHostSocket(hostID string) *hostSocket {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.hostSockets[hostID]
}

func (a *App) hasHostSocket(hostID string) bool {
	return a.getHostSocket(hostID) != nil
}

func (a *App) replacePendingSessionRequestLocked(hostID, sessionKey, nextRequestID string) {
	if sessionKey == "" {
		return
	}

	previousRequestID := a.pendingRequestIDsBySess[sessionKey]
	socket := a.hostSockets[hostID]
	if previousRequestID != "" {
		if socket != nil {
			_ = socket.writeJSON(CancelPageRequestMessage{
				Type:      "cancel_page_request",
				RequestID: previousRequestID,
			})
		}
		a.failPendingPageRequestLocked(previousRequestID, errors.New("Superseded by a newer page request"))
	}

	a.pendingRequestIDsBySess[sessionKey] = nextRequestID
}

func (a *App) clearPendingSessionRequestLocked(sessionKey, requestID string) {
	if sessionKey == "" {
		return
	}
	if a.pendingRequestIDsBySess[sessionKey] == requestID {
		delete(a.pendingRequestIDsBySess, sessionKey)
	}
}

func (a *App) failPendingPageRequest(requestID string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.failPendingPageRequestLocked(requestID, err)
}

func (a *App) failPendingPageRequestLocked(requestID string, err error) {
	pending := a.pendingPageRequests[requestID]
	if pending == nil {
		return
	}

	delete(a.pendingPageRequests, requestID)
	a.clearPendingSessionRequestLocked(pending.sessionKey, requestID)
	pending.timer.Stop()
	select {
	case pending.resultCh <- pageResult{err: err}:
	default:
	}
}

func (a *App) finishPendingPageRequest(hostID, requestID, contentType string, bytes []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()

	pending := a.pendingPageRequests[requestID]
	if pending == nil {
		return
	}
	if pending.hostID != hostID {
		return
	}

	delete(a.pendingPageRequests, requestID)
	a.clearPendingSessionRequestLocked(pending.sessionKey, requestID)
	pending.timer.Stop()
	select {
	case pending.resultCh <- pageResult{bytes: bytes, contentType: contentType}:
	default:
	}
}

func (a *App) failPendingRequestsForHost(hostID string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	for requestID, pending := range a.pendingPageRequests {
		if pending.hostID == hostID {
			a.failPendingPageRequestLocked(requestID, err)
		}
	}
}

func (h *hostSocket) writeJSON(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return h.writeMessage(websocket.TextMessage, payload)
}

func (h *hostSocket) writeMessage(messageType int, payload []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conn.WriteMessage(messageType, payload)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func findBinaryHeaderSeparator(bytes []byte) int {
	for index := 0; index < len(bytes)-1; index++ {
		if bytes[index] == '\n' && bytes[index+1] == '\n' {
			return index
		}
	}
	return -1
}

func newID() string {
	return uuid.NewString()
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
