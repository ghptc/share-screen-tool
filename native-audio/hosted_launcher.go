package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

const hostedLauncherAddr = "127.0.0.1:18495"

func serveHostedDesktop(origin, binary string) error {
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(config, "screen-share", "launcher")
	clientCert, err := os.ReadFile(filepath.Join(dir, "browser.pem"))
	if err != nil {
		return err
	}
	server := desktopServer(origin, binary, true)
	server.Addr = hostedLauncherAddr
	server.TLSConfig, err = hostedTLSConfig(clientCert)
	if err != nil {
		return err
	}
	server.Handler = hostedDesktopHandler(origin, server.Handler)
	return server.ListenAndServeTLS(filepath.Join(dir, "server.pem"), filepath.Join(dir, "server-key.pem"))
}

func hostedTLSConfig(clientCert []byte) (*tls.Config, error) {
	block, _ := pem.Decode(clientCert)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("invalid desktop browser certificate")
	}
	browser, err := x509.ParseCertificate(block.Bytes)
	if err != nil || browser.IsCA {
		return nil, errors.New("desktop launcher requires the enrolled browser's end-entity certificate")
	}
	clients := x509.NewCertPool()
	clients.AddCert(browser)
	// Browsers can send an anonymous CORS preflight. Both real actions
	// require a verified client certificate from this desktop user's store.
	return &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.VerifyClientCertIfGiven, ClientCAs: clients}, nil
}

func hostedDesktopHandler(origin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || host != "127.0.0.1" || r.Host != hostedLauncherAddr || r.Header.Get("Origin") != origin ||
			r.TLS == nil || (r.URL.Path != "/sources" && r.URL.Path != "/start") || r.URL.RawQuery != "" {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") == http.MethodPost {
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" || len(r.TLS.VerifiedChains) == 0 {
			http.Error(w, "Authorized desktop browser required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
