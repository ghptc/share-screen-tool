package rooms

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type desktopSource struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Detail string `json:"detail"`
}

// Exercise the real launcher and helper, with the desktop bridge restricted to
// one test-owned PipeWire stream. No unrelated desktop source can be started.
func hostedDesktop(t *testing.T, ctx context.Context, mux *http.ServeMux, f *cfFixture, binaryPath, browserTag string) func(bool) int {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "audio.sock")
	env := []string{}
	for _, k := range []string{"HOME", "PATH", "LANG", "XDG_RUNTIME_DIR"} {
		env = append(env, k+"="+os.Getenv(k))
	}
	proxy := httptest.NewServer(http.StripPrefix("/api", f.api))
	t.Cleanup(proxy.Close)
	start := func(cmd *exec.Cmd) {
		cmd.Env = append(env, "WHITERUN_DESKTOP_SOCKET="+socket)
		if err := cmd.Start(); err != nil {
			t.Fatal("could not start desktop test process")
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	}
	start(exec.CommandContext(ctx, binaryPath, "--desktop-launcher", "--player-origin", strings.Replace(proxy.URL, "127.0.0.1", "localhost", 1)))
	sink, err := exec.Command("pactl", "get-default-sink").Output()
	if err != nil {
		t.Fatal("default playback sink unavailable")
	}
	name := "game-test-" + rand.Text()
	cmd := exec.CommandContext(ctx, "pw-cat", "--playback", "--raw", "--target", strings.TrimSpace(string(sink)), "--rate", "48000", "--channels", "2", "--format", "s16", "--properties", "node.name="+name, "-")
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	start(cmd)
	go func() {
		defer in.Close()
		block := make([]byte, 960*4)
		for i := range 960 {
			for channel, frequency := range []float64{750, 1500} {
				sample := int16(320 * math.Sin(2*math.Pi*frequency*float64(i)/48000))
				binary.LittleEndian.PutUint16(block[i*4+channel*2:], uint16(sample))
			}
		}
		for {
			if _, err := in.Write(block); err != nil {
				return
			}
		}
	}()
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}}, Timeout: 16 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	find := func() *desktopSource {
		r, err := client.Post("http://desktop/sources", "application/json", strings.NewReader("{}"))
		if err != nil {
			return nil
		}
		defer r.Body.Close()
		var list []desktopSource
		if r.StatusCode == 200 && json.NewDecoder(r.Body).Decode(&list) == nil {
			for _, source := range list {
				if source.Detail == name || source.Name == name {
					return &source
				}
			}
		}
		return nil
	}
	var selected *desktopSource
	for limit := time.Now().Add(5 * time.Second); time.Now().Before(limit) && selected == nil; {
		selected = find()
		if selected == nil {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if selected == nil {
		t.Fatal("test-owned PipeWire playback stream unavailable")
	}
	t.Logf("PipeWire playback target is HyperX Cloud II Wireless: %t", strings.Contains(strings.ToLower(string(sink)), "hyperx_cloud_ii_wireless"))
	mux.HandleFunc("POST /player/{action}", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := f.a.discord.oauth.Current(r); !ok || r.Header.Get("Origin") != f.cfg.Origin {
			http.Error(w, "Forbidden", 403)
			return
		}
		switch r.PathValue("action") {
		case "sources":
			items := []desktopSource{}
			if s := find(); s != nil && s.ID == selected.ID {
				items = append(items, *s)
			}
			write(w, 200, items)
		case "start":
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
			var pick struct {
				Source     string
				Additional []string
				Code       string
			}
			if err != nil || json.Unmarshal(body, &pick) != nil || pick.Source != selected.ID || len(pick.Additional) != 0 {
				http.Error(w, "Unapproved test source", 403)
				return
			}
			req, err := http.NewRequestWithContext(r.Context(), "POST", "http://desktop/start", bytes.NewReader(body))
			if err != nil {
				http.Error(w, "Desktop unavailable", 503)
				return
			}
			reply, err := client.Do(req)
			if err != nil {
				http.Error(w, "Desktop unavailable", 503)
				return
			}
			defer reply.Body.Close()
			w.WriteHeader(reply.StatusCode)
			_, _ = io.Copy(w, reply.Body)
		default:
			http.NotFound(w, r)
		}
	})
	return func(playing bool) int {
		data, err := exec.Command("pw-dump").Output()
		if err != nil {
			t.Fatal("PipeWire graph unavailable")
		}
		var items []struct {
			ID   int
			Info struct {
				Props map[string]any
				State string
				Out   int `json:"output-node-id"`
				In    int `json:"input-node-id"`
			}
		}
		if json.Unmarshal(data, &items) != nil {
			t.Fatal("invalid PipeWire graph")
		}
		taps := map[int]bool{}
		source, target := -1, -1
		serials := map[string]int{}
		for _, v := range items {
			n, _ := v.Info.Props["node.name"].(string)
			if n == name {
				source = v.ID
			}
			if n == strings.TrimSpace(string(sink)) {
				target = v.ID
			}
			if n != "" {
				serials[fmt.Sprint(v.Info.Props["object.serial"])] = v.ID
			}
			if strings.HasPrefix(n, "whiterun-capture-") {
				taps[v.ID] = true
			}
		}
		links, localPlayback := 0, 0
		owned := map[int]bool{}
		for _, v := range items {
			if v.Info.State != "active" {
				continue
			}
			if v.Info.Out == source && taps[v.Info.In] {
				links++
				owned[v.Info.In] = true
			}
			if v.Info.Out == source && v.Info.In == target {
				localPlayback++
			}
		}
		if source < 0 || target < 0 || localPlayback != 2 {
			t.Fatal("local game lost stereo headset playback")
		}
		for _, v := range items {
			if owned[v.Info.In] && v.Info.Out != source {
				t.Fatal("additional application or monitor linked to test capture")
			}
		}
		if playing {
			out, err := exec.Command("pactl", "-f", "json", "list", "sink-inputs").Output()
			var streams []struct {
				Corked, Mute bool
				Properties   map[string]string
			}
			if err != nil || json.Unmarshal(out, &streams) != nil {
				t.Fatal("browser playback inventory unavailable")
			}
			found := false
			for _, s := range streams {
				if s.Corked || s.Mute || s.Properties["whiterun.test"] != browserTag {
					continue
				}
				node, ok := serials[s.Properties["object.serial"]]
				if !ok {
					continue
				}
				count := 0
				for _, v := range items {
					if v.Info.State == "active" && v.Info.Out == node {
						if v.Info.In != target {
							t.Fatal("browser playback entered another destination")
						}
						count++
					}
				}
				if count >= 2 {
					found = true
				}
			}
			if !found {
				t.Fatal("test browser playback missing from headset")
			}
		}
		return links
	}
}
