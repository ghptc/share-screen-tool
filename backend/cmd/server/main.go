package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ghptc/whiterun-live/backend/internal/cloudsfu"
	"github.com/ghptc/whiterun-live/backend/internal/config"
	"github.com/ghptc/whiterun-live/backend/internal/discord"
	"github.com/ghptc/whiterun-live/backend/internal/httpapi"
	"github.com/ghptc/whiterun-live/backend/internal/rooms"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if len(os.Args) == 3 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 4 * time.Second}
		res, err := client.Get(os.Args[2])
		if err != nil {
			os.Exit(1)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	mux := http.NewServeMux()

	api := rooms.New(rooms.Config{APIKey: cfg.APIKey, APISecret: cfg.APISecret, AdminKey: cfg.AdminKey, LocalPlayerKey: cfg.LocalPlayerKey, HTTPURL: cfg.LiveKitURL, WSURL: cfg.WSURL, AppOrigin: cfg.AppOrigin})
	dc, err := discord.Load(cfg.AppOrigin, cfg.APIKey, cfg.APISecret, cfg.LocalPlayerKey)
	if err != nil {
		logger.Error("invalid Discord configuration", "error", err)
		os.Exit(1)
	}
	prototype, err := cloudsfu.PrototypeEnabled(cfg.Addr, dc != nil && dc.Fixture)
	if err != nil {
		logger.Error("invalid media profile", "error", err)
		os.Exit(1)
	}
	if prototype {
		media, err := cloudsfu.FromEnvironment()
		if err != nil {
			logger.Error("invalid SFU configuration", "error", err)
			os.Exit(1)
		}
		api.EnableCloudflarePrototype(media)
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	} else {
		mux.Handle("/", httpapi.New(cfg.LiveKitURL))
		if dc == nil || dc.Fixture {
			api.Register(mux)
		} else {
			api.RegisterNative(mux)
		}
	}
	if dc != nil {
		api.RegisterDiscord(mux, dc)
	}
	server := &http.Server{Addr: cfg.Addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	if prototype {
		server.WriteTimeout = 30 * time.Second
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	monitorCtx, stopMonitor := context.WithCancel(context.Background())
	defer stopMonitor()
	monitorDone := make(chan struct{})
	if dc != nil {
		go func() { defer close(monitorDone); api.ReconcileDiscord(monitorCtx) }()
	} else {
		close(monitorDone)
	}
	failures := make(chan error, 1)
	go func() { failures <- server.ListenAndServe() }()
	logger.Info("server starting", "address", cfg.Addr)
	select {
	case err := <-failures:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		drain := 5 * time.Second
		if prototype {
			drain = 30 * time.Second
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), drain)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("shutdown failed", "error", err)
		}
		stopMonitor()
		<-monitorDone
		logger.Info("server stopped")
	}
}
