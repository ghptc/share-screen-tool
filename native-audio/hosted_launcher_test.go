package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func browserCertificate(t *testing.T, isCA bool) tls.Certificate {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		Subject: pkix.Name{CommonName: "Screen Share browser"}, SerialNumber: big.NewInt(1),
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		BasicConstraintsValid: true, IsCA: isCA, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: c}
}

func TestHostedLauncherTrustsOnlyEnrolledBrowser(t *testing.T) {
	enroll := func(c *x509.Certificate) (*tls.Config, error) {
		return hostedTLSConfig(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw}))
	}
	browser := browserCertificate(t, false).Leaf
	config, err := enroll(browser)
	if err != nil || config.ClientAuth != tls.VerifyClientCertIfGiven {
		t.Fatal("missing browser certificate verification", err)
	}
	opts := x509.VerifyOptions{Roots: config.ClientCAs, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	if _, err := browser.Verify(opts); err != nil {
		t.Fatal(err)
	}
	if _, err := browserCertificate(t, false).Leaf.Verify(opts); err == nil {
		t.Fatal("accepted another user's certificate with the same name")
	}
	if _, err := enroll(browserCertificate(t, true).Leaf); err == nil {
		t.Fatal("accepted a CA in place of one enrolled browser")
	}
}

func TestHostedLauncherBoundary(t *testing.T) {
	const origin = "https://player.test"
	for _, tc := range []struct {
		name string
		edit func(*http.Request)
		want int
	}{
		{"trusted browser", func(r *http.Request) {}, 200},
		{"metadata", func(r *http.Request) { r.URL.Path = "/sources" }, 200},
		{"unsigned browser", func(r *http.Request) { r.TLS.VerifiedChains = nil }, 403},
		{"anonymous discovery", func(r *http.Request) { r.TLS.VerifiedChains = nil; r.URL.Path = "/sources" }, 403},
		{"anonymous preflight", func(r *http.Request) {
			r.TLS.VerifiedChains = nil
			r.Method = "OPTIONS"
			r.Header.Set("Access-Control-Request-Method", "POST")
			r.Header.Set("Access-Control-Request-Private-Network", "true")
		}, 204},
		{"foreign origin", func(r *http.Request) { r.Header.Set("Origin", "https://other.test") }, 403},
		{"no origin", func(r *http.Request) { r.Header.Del("Origin") }, 403},
		{"wrong host", func(r *http.Request) { r.Host = "other.test:18495" }, 403},
		{"remote peer", func(r *http.Request) { r.RemoteAddr = "192.0.2.1:1000" }, 403},
		{"plaintext", func(r *http.Request) { r.TLS = nil }, 403},
		{"form", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 403},
		{"get", func(r *http.Request) { r.Method = "GET" }, 403},
		{"unknown route", func(r *http.Request) { r.URL.Path = "/stop" }, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "https://"+hostedLauncherAddr+"/start", nil)
			r.RemoteAddr = "127.0.0.1:60000"
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			r.TLS.VerifiedChains = [][]*x509.Certificate{{{}}}
			tc.edit(r)
			w := httptest.NewRecorder()
			called := false
			hostedDesktopHandler(origin, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })).ServeHTTP(w, r)
			if w.Code != tc.want || called != (tc.want == 200) {
				t.Fatalf("status %d, dispatched %t", w.Code, called)
			}
			if tc.want == 204 && (w.Header().Get("Access-Control-Allow-Origin") != origin || w.Header().Get("Access-Control-Allow-Credentials") != "true") {
				t.Fatal("missing credentialed preflight")
			}
			if tc.want == 204 && w.Header().Get("Access-Control-Allow-Private-Network") != "true" {
				t.Fatal("missing loopback preflight permission")
			}
		})
	}
}

func TestHostedLauncherStartsSelectedApplication(t *testing.T) {
	const origin = "https://player.test"
	graph, err := json.Marshal(startupGraph(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DUMP_GRAPH", string(graph))
	mockGraphDump(t, `printf '%s' "$DUMP_GRAPH"`)
	// Only fixture metadata and a text-only stand-in helper are available.
	dir := t.TempDir()
	t.Setenv("FIXTURE_DIR", dir)
	helper := filepath.Join(dir, "helper")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\n"+`printf '%s\n' "$@" > "$FIXTURE_DIR/args"
/bin/cat > "$FIXTURE_DIR/pair"
echo ready
`), 0700); err != nil {
		t.Fatal(err)
	}
	browser := browserCertificate(t, false)
	server := httptest.NewUnstartedServer(hostedDesktopHandler(origin, desktopServer(origin, helper, true).Handler))
	server.TLS, err = hostedTLSConfig(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: browser.Leaf.Raw}))
	if err != nil {
		t.Fatal(err)
	}
	server.StartTLS()
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.Certificates = []tls.Certificate{browser}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	post := func(path, body string) string {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), "POST", server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = hostedLauncherAddr
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("%s returned %d, read error %v", path, res.StatusCode, err)
		}
		return string(data)
	}
	var sources []struct{ ID string }
	if err := json.Unmarshal([]byte(post("/sources", "{}")), &sources); err != nil || len(sources) != 1 || sources[0].ID != "9:103" {
		t.Fatal("selected application missing from launcher catalog")
	}
	code := strings.Repeat("x", 43)
	if got := post("/start", `{"source":"`+sources[0].ID+`","code":"`+code+`"}`); got != `{"started":true}` {
		t.Fatal("missing startup acknowledgement")
	}
	args, err := os.ReadFile(filepath.Join(dir, "args"))
	if err != nil || string(args) != "--local-player-capture\n--start\n--pipewire-instance\n9\n--application\n103\n--additional-applications\n\n" {
		t.Fatal("helper did not receive the exact selected application")
	}
	pair, err := os.ReadFile(filepath.Join(dir, "pair"))
	var claim struct{ APIURL, Code string }
	if err != nil || json.Unmarshal(pair, &claim) != nil || claim.APIURL != origin+"/api" || claim.Code != code {
		t.Fatal("helper did not receive the origin-bound claim on stdin")
	}
}

func TestHostedLauncherRejectsUnscopedAndMultipleApplications(t *testing.T) {
	server := desktopServer("https://player.test", "/nonexistent-helper", true)
	for _, selection := range []string{`"source":"123"`, `"source":"1:2","additional":["1:3"]`, `"source":"1:monitor"`, `"sink":"headset"`} {
		body := `{` + selection + `,"code":"` + strings.Repeat("x", 43) + `"}`
		w := httptest.NewRecorder()
		server.Handler.ServeHTTP(w, httptest.NewRequest("POST", "/start", strings.NewReader(body)))
		if w.Code != 400 || strings.Contains(w.Body.String(), strings.Repeat("x", 43)) {
			t.Fatal("invalid selection was accepted or its claim disclosed")
		}
	}
}
