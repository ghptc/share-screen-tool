package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// systemd owns the mode-0600 Unix socket. Listing touches only graph metadata.
func serveDesktop(origin, socket string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Hostname() != "localhost" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("desktop player requires a localhost origin")
	}
	var listener net.Listener
	if socket != "" {
		info, e := os.Lstat(filepath.Dir(socket))
		if e != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
			return errors.New("desktop socket requires an owner-only directory")
		}
		listener, err = net.Listen("unix", socket)
	} else {
		if os.Getenv("LISTEN_FDS") != "1" || os.Getenv("LISTEN_PID") != strconv.Itoa(os.Getpid()) {
			return errors.New("start the desktop launcher with its user socket")
		}
		fd := os.NewFile(3, "desktop launcher")
		listener, err = net.FileListener(fd)
		fd.Close()
	}
	if err != nil {
		return err
	}
	defer listener.Close()
	if listener.Addr().Network() != "unix" {
		return errors.New("desktop launcher requires a Unix socket")
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sources", func(w http.ResponseWriter, r *http.Request) {
		graph, err := readGraph(r.Context())
		if err != nil {
			http.Error(w, "PipeWire unavailable", 503)
			return
		}
		type source struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Detail string `json:"detail"`
		}
		core := coreInstance(graph)
		if core == "" {
			http.Error(w, "PipeWire instance unavailable", 503)
			return
		}
		sources := []source{}
		for _, n := range graph {
			if n.Info.State != "running" || !applicationAllowed(graph, n) {
				continue
			}
			if _, err := stereoPorts(graph, n.ID, "output"); err != nil {
				continue
			}
			name, _ := n.Info.Props["application.name"].(string)
			if name == "" {
				name, _ = n.Info.Props["node.name"].(string)
			}
			detail, _ := n.Info.Props["media.name"].(string)
			nodeName, _ := n.Info.Props["node.name"].(string)
			if nodeName != "" && nodeName != name {
				detail = nodeName
			}
			sources = append(sources, source{core + ":" + strconv.FormatUint(propID(n.Info.Props["object.serial"]), 10), name, detail})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(sources)
	})
	slots := make(chan struct{}, 32)
	codePattern := regexp.MustCompile("^[A-Za-z0-9_-]{43}$")
	mux.HandleFunc("POST /start", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Source     string
			Additional []string
			Code       string
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		dec.DisallowUnknownFields()
		if dec.Decode(&req) != nil || !codePattern.MatchString(req.Code) {
			http.Error(w, "Invalid audio selection", 400)
			return
		}
		core, serialText, scoped := strings.Cut(req.Source, ":")
		if !scoped {
			serialText, core = req.Source, ""
		} // Older manual player selections.
		if scoped {
			if _, err := strconv.ParseUint(core, 10, 32); err != nil {
				http.Error(w, "Invalid PipeWire instance", 400)
				return
			}
		}
		serial, err := strconv.ParseUint(serialText, 10, 64)
		if err != nil || serial == 0 {
			http.Error(w, "Select an application", 400)
			return
		}
		if len(req.Additional) > 7 {
			http.Error(w, "Too many audio sources", 400)
			return
		}
		seen := map[uint64]bool{serial: true}
		var extra []string
		for _, v := range req.Additional {
			c, id, ok := strings.Cut(v, ":")
			n, err := strconv.ParseUint(id, 10, 64)
			if !ok || !scoped || c != core || err != nil || n == 0 || seen[n] {
				http.Error(w, "Invalid audio source set", 400)
				return
			}
			seen[n] = true
			extra = append(extra, strconv.FormatUint(n, 10))
		}
		select {
		case slots <- struct{}{}:
		default:
			http.Error(w, "Audio launcher busy", 429)
			return
		}
		child := exec.Command(binary, "--local-player-capture", "--start", "--pipewire-instance", core, "--application", strconv.FormatUint(serial, 10), "--additional-applications", strings.Join(extra, ","))
		child.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
		pair, _ := json.Marshal(map[string]string{"apiUrl": origin + "/api", "code": req.Code})
		child.Stdin = bytes.NewReader(pair)
		child.Stderr = os.Stderr
		ready, err := child.StdoutPipe()
		if err == nil {
			err = child.Start()
		}
		if err != nil {
			<-slots
			http.Error(w, "Audio helper unavailable", 503)
			return
		}
		started := make(chan bool, 1)
		go func() {
			line, _ := bufio.NewReader(ready).ReadString('\n')
			started <- line == "ready\n"
			_ = child.Wait()
			<-slots
		}()
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		select {
		case ok := <-started:
			if !ok {
				http.Error(w, "Application ended or audio authorization expired", 409)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"started":true}`)
		case <-ctx.Done():
			_ = child.Process.Kill()
			http.Error(w, "Audio start interrupted", 408)
		}
	})
	server := http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 10 * time.Second}
	return server.Serve(listener)
}
