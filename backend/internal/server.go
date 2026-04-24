package internal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	store *SQLiteStore

	mu                      sync.RWMutex
	hostSockets             map[string]*hostSocket
	pendingPageRequests     map[string]*pendingPageRequest
	pendingRequestIDsByPage map[string]string
	pendingRequestIDsBySess map[string]string

	upgrader websocket.Upgrader
}

type hostSocket struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type pendingPageRequest struct {
	hostID     string
	pageID     string
	sessionKey string
	waiters    []chan pageResult
	timer      *time.Timer
}

type pageResult struct {
	bytes       []byte
	contentType string
	err         error
}

func logPageLifecycle(stage, requestID, hostID, pageID, sessionKey, details string) {
	fmt.Printf("[page lifecycle] stage=%s requestID=%s hostID=%s pageID=%s sessionKey=%s %s\n", stage, requestID, hostID, pageID, sessionKey, details)
}

func pendingPageKey(hostID, pageID string) string {
	return hostID + "\x00" + pageID
}

type seriesHostVolume struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	VolumeNumber *int   `json:"volumeNumber"`
	PageCount    int    `json:"pageCount"`
}

type seriesHost struct {
	HostID   string             `json:"hostId"`
	Username string             `json:"username"`
	Online   bool               `json:"online"`
	Volumes  []seriesHostVolume `json:"volumes"`
}

func New(sqliteStore *SQLiteStore) *App {
	return &App{
		store:                   sqliteStore,
		hostSockets:             make(map[string]*hostSocket),
		pendingPageRequests:     make(map[string]*pendingPageRequest),
		pendingRequestIDsByPage: make(map[string]string),
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
	mux.HandleFunc("POST /api/host-latency-test", a.handleHostLatencyTest)
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

func (a *App) handleHostLatencyTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HostID   string `json:"hostId"`
		VolumeID string `json:"volumeId"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request body must contain a single JSON object"})
		return
	}
	if body.HostID == "" || body.VolumeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "hostId and volumeId are required"})
		return
	}
	if !a.hasHostSocket(body.HostID) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Selected host is offline"})
		return
	}

	pageIDs, err := a.store.ListPageIDsForHostVolume(r.Context(), body.HostID, body.VolumeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if len(pageIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Selected host does not serve that volume"})
		return
	}

	pageOffset := 4
	if pageOffset >= len(pageIDs) {
		pageOffset = len(pageIDs) - 1
	}
	pageID := pageIDs[pageOffset]

	startedAt := time.Now()
	result, err := a.requestPageFromHost(r.Context(), body.HostID, pageID, "host-latency-test:"+body.HostID+":"+body.VolumeID)
	elapsedMs := time.Since(startedAt).Milliseconds()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":     "Failed to fetch page from host: " + err.Error(),
			"elapsedMs": elapsedMs,
			"pageId":    pageID,
			"pageIndex": pageOffset + 1,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"hostId":      body.HostID,
		"volumeId":    body.VolumeID,
		"pageId":      pageID,
		"pageIndex":   pageOffset + 1,
		"elapsedMs":   elapsedMs,
		"bytes":       len(result.bytes),
		"contentType": result.contentType,
	})
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

	result := a.buildSeriesHosts(rows)

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
	if err := decoder.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request body must contain a single JSON object"})
		return
	}
	if body.HostID == "" || body.VolumeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "hostId and volumeId are required"})
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

	logPageLifecycle("1_handler_selected_preview_page", "pending", selection.HostID, selection.PageIDs[0], "volume-preview:"+token, "handler=handlePreviewImage")

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
	sessionKey := "volume-reader:" + token + ":" + requestKind
	logPageLifecycle("1_handler_selected_reader_page", "pending", selection.HostID, pageID, sessionKey, fmt.Sprintf("handler=handleVolumePageImage pageIndex=%d requestKind=%s", pageIndex, requestKind))
	a.relayPageFromHost(w, r, selection.HostID, pageID, sessionKey)
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

	logPageLifecycle("1_handler_selected_direct_page", "pending", onlineHostID, page.ID, "", "handler=handlePageImage")
	a.relayPageFromHost(w, r, onlineHostID, page.ID, "")
}

func (a *App) relayPageFromHost(w http.ResponseWriter, r *http.Request, hostID, pageID, sessionKey string) {
	result, err := a.requestPageFromHost(r.Context(), hostID, pageID, sessionKey)
	if err != nil {
		http.Error(w, "Failed to fetch page from host: "+err.Error(), http.StatusBadGateway)
		return
	}
	logPageLifecycle("7_backend_writing_http_response", "", hostID, pageID, sessionKey, fmt.Sprintf("bytes=%d contentType=%s", len(result.bytes), result.contentType))

	w.Header().Set("content-type", result.contentType)
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.bytes)
}

func (a *App) requestPageFromHost(ctx context.Context, hostID, pageID, sessionKey string) (pageResult, error) {
	socket := a.getHostSocket(hostID)
	if socket == nil {
		return pageResult{}, errors.New("host socket missing")
	}

	requestID := newID()
	resultCh := make(chan pageResult, 1)
	pageKey := pendingPageKey(hostID, pageID)
	logPageLifecycle("2_backend_created_request", requestID, hostID, pageID, sessionKey, "function=requestPageFromHost")

	var previousRequestID string
	a.mu.Lock()
	if existingRequestID := a.pendingRequestIDsByPage[pageKey]; existingRequestID != "" {
		if existing := a.pendingPageRequests[existingRequestID]; existing != nil {
			existing.waiters = append(existing.waiters, resultCh)
			if sessionKey != "" {
				previousRequestID = a.replacePendingSessionRequestLocked(sessionKey, existingRequestID)
			}
			a.mu.Unlock()

			if previousRequestID != "" && previousRequestID != existingRequestID {
				logPageLifecycle("3_backend_cancelled_previous_request", previousRequestID, hostID, pageID, sessionKey, "reason=superseded_by_coalesced_page_request")
				_ = socket.writeJSON(CancelPageRequestMessage{
					Type:      "cancel_page_request",
					RequestID: previousRequestID,
				})
			}

			logPageLifecycle("3_backend_coalesced_request", existingRequestID, hostID, pageID, sessionKey, fmt.Sprintf("waiterRequestID=%s", requestID))
			return waitForPageResult(ctx, requestID, existingRequestID, hostID, pageID, sessionKey, resultCh, func(err error) {
				a.removePendingPageWaiter(existingRequestID, resultCh, err)
			})
		}
	}

	timer := time.AfterFunc(pageRequestTimeout, func() {
		logPageLifecycle("6_backend_timeout_waiting_for_host", requestID, hostID, pageID, sessionKey, "function=requestPageFromHost")
		a.failPendingPageRequest(requestID, errors.New("timed out waiting for host response"))
	})
	a.pendingPageRequests[requestID] = &pendingPageRequest{
		hostID:     hostID,
		pageID:     pageID,
		sessionKey: sessionKey,
		waiters:    []chan pageResult{resultCh},
		timer:      timer,
	}
	a.pendingRequestIDsByPage[pageKey] = requestID
	previousRequestID = a.replacePendingSessionRequestLocked(sessionKey, requestID)
	a.mu.Unlock()

	if previousRequestID != "" {
		logPageLifecycle("3_backend_cancelled_previous_request", previousRequestID, hostID, pageID, sessionKey, "reason=superseded_by_newer_request")
		_ = socket.writeJSON(CancelPageRequestMessage{
			Type:      "cancel_page_request",
			RequestID: previousRequestID,
		})
	}

	if err := socket.writeJSON(map[string]any{
		"type":       "page_request",
		"requestId":  requestID,
		"pageId":     pageID,
		"sessionKey": nullIfEmpty(sessionKey),
	}); err != nil {
		logPageLifecycle("3_backend_failed_to_send_to_host", requestID, hostID, pageID, sessionKey, fmt.Sprintf("error=%v", err))
		a.failPendingPageRequest(requestID, err)
		return pageResult{}, err
	}
	logPageLifecycle("3_backend_sent_request_to_host", requestID, hostID, pageID, sessionKey, "function=requestPageFromHost")

	return waitForPageResult(ctx, requestID, requestID, hostID, pageID, sessionKey, resultCh, func(err error) {
		a.removePendingPageWaiter(requestID, resultCh, err)
	})
}

func waitForPageResult(ctx context.Context, requestID, pendingRequestID, hostID, pageID, sessionKey string, resultCh chan pageResult, onCancel func(error)) (pageResult, error) {
	select {
	case result := <-resultCh:
		if result.err != nil {
			logPageLifecycle("7_backend_request_failed", requestID, hostID, pageID, sessionKey, fmt.Sprintf("pendingRequestID=%s error=%v", pendingRequestID, result.err))
			return pageResult{}, result.err
		}
		logPageLifecycle("6_backend_received_page_bytes", requestID, hostID, pageID, sessionKey, fmt.Sprintf("pendingRequestID=%s bytes=%d contentType=%s", pendingRequestID, len(result.bytes), result.contentType))
		return result, nil
	case <-ctx.Done():
		logPageLifecycle("7_http_request_context_cancelled", requestID, hostID, pageID, sessionKey, fmt.Sprintf("pendingRequestID=%s error=%v", pendingRequestID, ctx.Err()))
		onCancel(ctx.Err())
		return pageResult{}, ctx.Err()
	}
}

func (a *App) handleHostWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	fmt.Println("from handleHostWebSocket upgrading host websocket connection")

	socket := &hostSocket{conn: conn}
	_ = socket.writeJSON(map[string]any{
		"ok":      true,
		"message": "Connected to backend. Send register_manifest.",
	})

	var hostID string
	defer func() {
		if hostID != "" {
			a.unregisterHost(hostID, socket)
			a.failPendingRequestsForHost(hostID, errors.New("host disconnected"))
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
			nextHostID, err := a.handleHostTextMessage(r, socket, hostID, payload)
			if err != nil {
				_ = socket.writeJSON(map[string]any{"ok": false, "error": err.Error()})
				continue
			}
			if nextHostID != "" {
				hostID = nextHostID
			}

		case websocket.BinaryMessage:
			if err := a.handleHostBinaryMessage(hostID, payload); err != nil {
				_ = socket.writeJSON(map[string]any{"ok": false, "error": err.Error()})
			}
		default:
			_ = socket.writeJSON(map[string]any{"ok": false, "error": "unsupported websocket message type"})
		}
	}
}

func (a *App) buildSeriesHosts(rows []HostSeriesVolumeRow) []seriesHost {
	hosts := make(map[string]*seriesHost)
	for _, row := range rows {
		if !a.hasHostSocket(row.HostID) {
			continue
		}

		host := hosts[row.HostID]
		if host == nil {
			host = &seriesHost{
				HostID:   row.HostID,
				Username: row.Username,
				Online:   true,
			}
			hosts[row.HostID] = host
		}

		host.Volumes = append(host.Volumes, seriesHostVolume{
			ID:           row.VolumeID,
			Title:        row.VolumeTitle,
			VolumeNumber: row.VolumeNumber,
			PageCount:    row.PageCount,
		})
	}

	result := make([]seriesHost, 0, len(hosts))
	for _, host := range hosts {
		result = append(result, *host)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].Username == result[j].Username {
			return result[i].HostID < result[j].HostID
		}
		return result[i].Username < result[j].Username
	})

	return result
}

func (a *App) handleHostTextMessage(r *http.Request, socket *hostSocket, currentHostID string, payload []byte) (string, error) {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return "", errors.New("invalid JSON message")
	}
	switch envelope.Type {
	case "register_manifest":
		return a.handleRegisterManifest(r, socket, currentHostID, payload)
	case "page_error":
		return currentHostID, a.handlePageError(payload)
	default:
		return currentHostID, errors.New("unknown message type")
	}
}

func (a *App) handleRegisterManifest(r *http.Request, socket *hostSocket, currentHostID string, payload []byte) (string, error) {
	var message RegisterManifestMessage
	if err := json.Unmarshal(payload, &message); err != nil {
		return currentHostID, errors.New("invalid JSON message")
	}
	fmt.Printf("[host websocket] stage=register_manifest_received hostID=%s username=%s series=%d\n", message.Host.ID, message.Host.Username, len(message.Series))
	if err := validateRegisterManifestMessage(message); err != nil {
		return currentHostID, err
	}
	if err := a.store.UpsertManifest(r.Context(), message); err != nil {
		return currentHostID, err
	}

	if currentHostID != "" && currentHostID != message.Host.ID {
		a.unregisterHost(currentHostID, socket)
	}

	a.registerHost(message.Host.ID, socket)
	_ = socket.writeJSON(map[string]any{
		"ok":      true,
		"message": "Registered manifest for " + message.Host.Username,
	})

	return message.Host.ID, nil
}

func (a *App) handlePageError(payload []byte) error {
	var message PageErrorMessage
	if err := json.Unmarshal(payload, &message); 
	err != nil {
		return errors.New("invalid JSON message")
	}
	logPageLifecycle("5_host_reported_error", message.RequestID, "", message.PageID, "", fmt.Sprintf("error=%s", message.Error))

	a.failPendingPageRequest(message.RequestID, errors.New(message.Error))
	return nil
}

func (a *App) handleHostBinaryMessage(hostID string, payload []byte) error {
	if hostID == "" {
		return errors.New("host not registered yet")
	}

	separator := findBinaryHeaderSeparator(payload)
	if separator == -1 {
		return errors.New("invalid binary page response envelope")
	}

	var header PageResponseHeader
	if err := json.Unmarshal(payload[:separator], &header); 
	    err != nil {
		    return errors.New("invalid binary page response header")
	            }
	if header.Type != "page_response" {
		return errors.New("unexpected binary message type")
	}
	logPageLifecycle("5_backend_received_binary_from_host", header.RequestID, hostID, header.PageID, "", fmt.Sprintf("contentType=%s payloadBytes=%d", header.ContentType, len(payload[separator+2:])))

	a.finishPendingPageRequest(hostID, header.RequestID, header.ContentType, payload[separator+2:])
	return nil
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

func (a *App) replacePendingSessionRequestLocked(sessionKey, nextRequestID string) string {
	if sessionKey == "" {
		return ""
	}

	previousRequestID := a.pendingRequestIDsBySess[sessionKey]
	if previousRequestID == nextRequestID {
		return ""
	}
	if previousRequestID != "" {
		a.failPendingPageRequestLocked(previousRequestID, errors.New("superseded by a newer page request"))
	}

	a.pendingRequestIDsBySess[sessionKey] = nextRequestID
	return previousRequestID
}

func (a *App) clearPendingSessionRequestLocked(sessionKey, requestID string) {
	if sessionKey == "" {
		return
	}
	if a.pendingRequestIDsBySess[sessionKey] == requestID {
		delete(a.pendingRequestIDsBySess, sessionKey)
	}
}

func (a *App) clearPendingPageRequestLocked(hostID, pageID, requestID string) {
	pageKey := pendingPageKey(hostID, pageID)
	if a.pendingRequestIDsByPage[pageKey] == requestID {
		delete(a.pendingRequestIDsByPage, pageKey)
	}
}

func (a *App) removePendingPageWaiter(requestID string, resultCh chan pageResult, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	pending := a.pendingPageRequests[requestID]
	if pending == nil {
		return
	}

	for index, waiter := range pending.waiters {
		if waiter == resultCh {
			pending.waiters = append(pending.waiters[:index], pending.waiters[index+1:]...)
			break
		}
	}

	if len(pending.waiters) == 0 {
		a.failPendingPageRequestLocked(requestID, err)
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
	logPageLifecycle("6_backend_marked_request_failed", requestID, pending.hostID, pending.pageID, pending.sessionKey, fmt.Sprintf("error=%v", err))

	delete(a.pendingPageRequests, requestID)
	a.clearPendingPageRequestLocked(pending.hostID, pending.pageID, requestID)
	a.clearPendingSessionRequestLocked(pending.sessionKey, requestID)
	pending.timer.Stop()
	for _, waiter := range pending.waiters {
		select {
		case waiter <- pageResult{err: err}:
		default:
		}
	}
}

func (a *App) finishPendingPageRequest(hostID, requestID, contentType string, bytes []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()

	pending := a.pendingPageRequests[requestID]
	if pending == nil {
		logPageLifecycle("6_backend_received_response_for_missing_request", requestID, hostID, "", "", "function=finishPendingPageRequest")
		return
	}
	if pending.hostID != hostID {
		logPageLifecycle("6_backend_rejected_response_host_mismatch", requestID, hostID, pending.pageID, pending.sessionKey, fmt.Sprintf("expectedHostID=%s", pending.hostID))
		return
	}
	logPageLifecycle("6_backend_matched_response_to_pending_request", requestID, hostID, pending.pageID, pending.sessionKey, fmt.Sprintf("bytes=%d contentType=%s", len(bytes), contentType))

	delete(a.pendingPageRequests, requestID)
	a.clearPendingPageRequestLocked(pending.hostID, pending.pageID, requestID)
	a.clearPendingSessionRequestLocked(pending.sessionKey, requestID)
	pending.timer.Stop()
	for _, waiter := range pending.waiters {
		select {
		case waiter <- pageResult{bytes: bytes, contentType: contentType}:
		default:
		}
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

func validateRegisterManifestMessage(message RegisterManifestMessage) error {
	if message.Type != "register_manifest" {
		return fmt.Errorf("invalid message type %q", message.Type)
	}
	if message.Host.ID == "" {
		return errors.New("host id is required")
	}
	if message.Host.Username == "" {
		return errors.New("host username is required")
	}

	for _, series := range message.Series {
		if err := validateManifestSeries(series); err != nil {
			return err
		}
	}

	return nil
}

func validateManifestSeries(series ManifestSeries) error {
	if series.ID == "" {
		return errors.New("series id is required")
	}
	if series.Title == "" {
		return errors.New("series title is required")
	}

	for _, volume := range series.Volumes {
		if err := validateManifestVolume(series.ID, volume); err != nil {
			return err
		}
	}

	return nil
}

func validateManifestVolume(seriesID string, volume ManifestVolume) error {
	if volume.ID == "" {
		return errors.New("volume id is required")
	}
	if volume.SeriesID != seriesID {
		return fmt.Errorf("volume %q has mismatched series id", volume.ID)
	}
	if volume.Title == "" {
		return errors.New("volume title is required")
	}

	for _, page := range volume.Pages {
		if err := validateManifestPage(volume.ID, page); err != nil {
			return err
		}
	}

	return nil
}

func validateManifestPage(volumeID string, page ManifestPage) error {
	if page.ID == "" {
		return errors.New("page id is required")
	}
	if page.VolumeID != volumeID {
		return fmt.Errorf("page %q has mismatched volume id", page.ID)
	}
	if page.Index < 0 {
		return fmt.Errorf("page %q has invalid index", page.ID)
	}
	if page.FileName == "" {
		return errors.New("page file name is required")
	}
	if page.ContentType == "" {
		return errors.New("page content type is required")
	}
	if page.FileSize < 0 {
		return fmt.Errorf("page %q has invalid file size", page.ID)
	}

	return nil
}
