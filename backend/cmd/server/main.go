package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"chimera/go-backend/internal"
)

func main() {
	cfg := internal.LoadConfig()

	sqliteStore, err := internal.NewSQLiteStore(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("open sqlite store: %v", err)
	}
	defer sqliteStore.Close()

	app := internal.New(cfg, sqliteStore)

	httpServer := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           app.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Backend running on http://localhost:%d", cfg.Port)
	log.Printf("Host WebSocket endpoint: ws://localhost:%d/ws/host", cfg.Port)

	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen and serve: %v", err)
		}
	}()

	shutdownSignalCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-shutdownSignalCtx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
