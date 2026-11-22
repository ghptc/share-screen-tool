package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type graphObject struct {
	ID   uint64 `json:"id"`
	Type string `json:"type"`
	Info struct {
		Cookie     *uint32        `json:"cookie"`
		Props      map[string]any `json:"props"`
		State      string         `json:"state"`
		Direction  string         `json:"direction"`
		OutputNode uint64         `json:"output-node-id"`
		InputNode  uint64         `json:"input-node-id"`
		OutputPort uint64         `json:"output-port-id"`
		InputPort  uint64         `json:"input-port-id"`
	} `json:"info"`
}

func readGraph(ctx context.Context) ([]graphObject, error) {
	c, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	data, err := exec.CommandContext(c, "pw-dump").Output()
	if err != nil {
		return nil, err
	}
	var graph []graphObject
	err = json.Unmarshal(data, &graph)
	return graph, err
}
func propID(v any) uint64 { n, _ := v.(float64); return uint64(n) }
func applicationAllowed(graph []graphObject, n graphObject) bool {
	if !strings.HasSuffix(n.Type, ":Node") || n.Info.Props["media.class"] != "Stream/Output/Audio" {
		return false
	}
	// A loopback/filter playback stream can carry a monitor or a microphone.
	if n.Info.Props["node.link-group"] != nil || n.Info.Props["node.virtual"] == true || n.Info.Props["media.role"] == "Communication" {
		return false
	}
	// Browser audio can mix games with Whiterun tabs. Never offer that ambiguous
	// stream as an isolated application. Explicit relay/mixing is not supported.
	if ambiguousPlayback(n) {
		return false
	}
	// Native clients can put the binary/application identity on the Client
	// object while providing only a generic media name on the stream itself.
	for _, client := range graph {
		if client.ID == propID(n.Info.Props["client.id"]) && strings.HasSuffix(client.Type, ":Client") {
			return !ambiguousPlayback(client)
		}
	}
	return true
}
func ambiguousPlayback(n graphObject) bool {
	props := n.Info.Props
	identity := strings.ToLower(fmt.Sprint(props["application.process.binary"], " ", props["application.name"], " ", props["application.id"], " ", props["pipewire.sec.flatpak.app-id"], " ", props["node.name"]))
	for _, word := range []string{"firefox", "chrom", "brave", "vivaldi", "webkit", "whiterun", "webrtc", "librewolf", "floorp", "zen browser", "msedge", "microsoft-edge", "opera browser"} {
		if strings.Contains(identity, word) {
			return true
		}
	}
	return false
}
func selectApplication(graph []graphObject, serial uint64) (graphObject, error) {
	for _, n := range graph {
		if propID(n.Info.Props["object.serial"]) == serial && applicationAllowed(graph, n) {
			return n, nil
		}
	}
	return graphObject{}, errors.New("selected application unavailable or not an eligible local playback stream; browser/Whiterun mixes and device monitors are excluded")
}
func stereoPorts(graph []graphObject, node uint64, direction string) ([2]uint64, error) {
	var ports [2]uint64
	for _, p := range graph {
		if !strings.HasSuffix(p.Type, ":Port") || propID(p.Info.Props["node.id"]) != node || p.Info.Direction != direction || p.Info.Props["port.monitor"] == true {
			continue
		}
		channel := fmt.Sprint(p.Info.Props["audio.channel"])
		index := -1
		if channel == "FL" {
			index = 0
		}
		if channel == "FR" {
			index = 1
		}
		if index < 0 || ports[index] != 0 {
			return ports, errors.New("application capture currently requires unambiguous stereo FL/FR ports")
		}
		ports[index] = p.ID
	}
	if ports[0] == 0 || ports[1] == 0 {
		return ports, errors.New("stereo ports are not ready")
	}
	return ports, nil
}

// PipeWire scopes object.serial to a core instance. A daemon restart can reuse it.
func coreInstance(graph []graphObject) string {
	for _, object := range graph {
		if strings.HasSuffix(object.Type, ":Core") && object.Info.Cookie != nil {
			return strconv.FormatUint(uint64(*object.Info.Cookie), 10)
		}
	}
	return ""
}

type applicationTap struct {
	core          string
	sourceSerial  uint64
	sourceID      uint64
	captureName   string
	captureSerial uint64
	captureID     uint64
}

var errLinksPending = errors.New("waiting for the selected application's stereo capture links")

// WirePlumber resolves target.object by serial and creates both links. Observe
// the actual ports before handing any PCM to the encoder.
func (tap *applicationTap) waitForLinks(ctx context.Context) error {
	wait, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		graph, err := readGraph(wait)
		if err != nil {
			return err
		}
		if tap.captureSerial == 0 {
			for _, n := range graph {
				if strings.HasSuffix(n.Type, ":Node") && n.Info.Props["node.name"] == tap.captureName && n.Info.Props["media.class"] == "Stream/Input/Audio" {
					tap.captureID = n.ID
					tap.captureSerial = propID(n.Info.Props["object.serial"])
					break
				}
			}
		}
		if err := tap.verifyGraph(graph); !errors.Is(err, errLinksPending) {
			return err
		}
		select {
		case <-wait.Done():
			return fmt.Errorf("%w: %w", errLinksPending, wait.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (tap *applicationTap) verify(ctx context.Context) error {
	graph, err := readGraph(ctx)
	if err != nil {
		return err
	}
	return tap.verifyGraph(graph)
}

func (tap *applicationTap) verifyGraph(graph []graphObject) error {
	if tap.core != "" && coreInstance(graph) != tap.core {
		return errors.New("PipeWire instance changed")
	}
	source, err := selectApplication(graph, tap.sourceSerial)
	if err != nil || source.ID != tap.sourceID {
		return errors.New("selected application ended or changed; explicit reselection required")
	}
	if tap.captureSerial == 0 {
		return errLinksPending
	}
	found := false
	for _, n := range graph {
		if n.ID == tap.captureID && n.Info.Props["media.class"] == "Stream/Input/Audio" && propID(n.Info.Props["object.serial"]) == tap.captureSerial {
			found = true
			break
		}
	}
	if !found {
		return errors.New("session capture node disappeared")
	}
	outputs, err := stereoPorts(graph, source.ID, "output")
	if err != nil {
		return err
	}
	inputs, err := stereoPorts(graph, tap.captureID, "input")
	if err != nil {
		return errLinksPending
	}
	var seen, linked [2]bool
	for _, link := range graph {
		if !strings.HasSuffix(link.Type, ":Link") || link.Info.InputNode != tap.captureID {
			continue
		}
		i := 0
		if link.Info.InputPort == inputs[1] {
			i = 1
		}
		if link.Info.OutputNode != source.ID || link.Info.OutputPort != outputs[i] || link.Info.InputPort != inputs[i] || seen[i] {
			return errors.New("unexpected source or channel entered application capture")
		}
		if link.Info.State == "error" {
			return errors.New("PipeWire failed to link the selected application")
		}
		seen[i] = true
		linked[i] = link.Info.State == "active" || link.Info.State == "paused"
	}
	if !linked[0] || !linked[1] {
		return errLinksPending
	}
	return nil
}
