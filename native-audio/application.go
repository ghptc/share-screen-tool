package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

const graphReadTimeout = 2 * time.Second
const linkVerificationTimeout = 3 * time.Second

var errDumpTimeout = fmt.Errorf("pw-dump: %w (%s)", context.DeadlineExceeded, graphReadTimeout)
var errLinkTimeout = fmt.Errorf("waiting for stereo links: %w (%s)", context.DeadlineExceeded, linkVerificationTimeout)

func readGraph(ctx context.Context) ([]graphObject, error) {
	c, cancel := context.WithTimeoutCause(ctx, graphReadTimeout, errDumpTimeout)
	defer cancel()
	data, err := exec.CommandContext(c, "pw-dump").Output()
	// Wait can report SIGKILL when CommandContext terminates a running dump.
	// Inspect the first cancellation cause before the deferred cancel runs.
	if cause := context.Cause(c); cause != nil {
		return nil, cause
	}
	if err != nil {
		return nil, fmt.Errorf("pw-dump failed: %w", err)
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
	// Browser audio can mix games with player tabs. Never offer that ambiguous
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
	return graphObject{}, errors.New("selected application unavailable or not an eligible local playback stream; browser/player mixes and device monitors are excluded")
}
func stereoPorts(graph []graphObject, node uint64, direction string) ([2]uint64, error) {
	var ports [2]uint64
	hasPorts := false
	for _, p := range graph {
		if !strings.HasSuffix(p.Type, ":Port") || propID(p.Info.Props["node.id"]) != node {
			continue
		}
		hasPorts = true
		if p.Info.Direction != direction || p.Info.Props["port.monitor"] == true {
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
			return ports, fmt.Errorf("node has an unsupported or ambiguous %s channel layout", direction)
		}
		ports[index] = p.ID
	}
	if !hasPorts {
		return ports, errors.New("node has no ports")
	}
	if ports[0] == 0 || ports[1] == 0 {
		return ports, fmt.Errorf("node lacks a complete pair of FL/FR %s ports", direction)
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
	core               string
	sourceSerial       uint64
	sourceID           uint64
	captureName        string
	captureSerial      uint64
	captureID          uint64
	verifiedLinkStates [2]string // FL, FR in the last accepted snapshot
}

// Only these observations can be retried during initial link verification.
type pendingLinks struct {
	detail           string
	idleSourceAtInit bool
}

func (p pendingLinks) Error() string { return p.detail }

// WirePlumber resolves target.object by serial and creates both links. Observe
// the actual ports before handing any PCM to the encoder.
func (tap *applicationTap) waitForLinks(ctx context.Context, recorderStdout io.Reader) error {
	return pollStereoLinks(ctx, recorderStdout, tap.verify)
}

func pollStereoLinks(ctx context.Context, recorderStdout io.Reader, verify func(context.Context) error) error {
	wait, cancel := context.WithTimeoutCause(ctx, linkVerificationTimeout, errLinkTimeout)
	defer cancel()
	var last pendingLinks
	for {
		err := verify(wait)
		idleAtDeadline := false
		if errors.As(err, &last) {
			select {
			case <-wait.Done():
				err = context.Cause(wait)
				idleAtDeadline = err == errLinkTimeout && last.idleSourceAtInit
			case <-time.After(50 * time.Millisecond):
				continue
			}
		} else if errors.Is(err, errLinkTimeout) {
			err = fmt.Errorf("%w during pw-dump", err)
		}
		if last.detail != "" && (errors.Is(err, errLinkTimeout) || errors.Is(err, errDumpTimeout)) {
			err = fmt.Errorf("%w; last completed graph: %s", err, last)
			// TIOCINQ observes the kernel queue without consuming recorder output.
			if queued := pendingPCM(recorderStdout); queued != nil {
				err = fmt.Errorf("%w; recorder stdout queued bytes at timeout=%d", err, *queued)
				if idleAtDeadline && *queued == 0 {
					return fmt.Errorf("The selected application stream was idle. Audio sharing didn't start.\n%w", err)
				}
			}
		}
		return err
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
	var recorder *graphObject
	for i := range graph {
		n := &graph[i]
		if !strings.HasSuffix(n.Type, ":Node") || n.Info.Props["media.class"] != "Stream/Input/Audio" {
			continue
		}
		serial := propID(n.Info.Props["object.serial"])
		if tap.captureSerial == 0 && n.Info.Props["node.name"] == tap.captureName {
			if serial == 0 {
				return pendingLinks{detail: "capture node has no usable serial"}
			}
			tap.captureID, tap.captureSerial = n.ID, serial
		}
		if tap.captureSerial != 0 && n.ID == tap.captureID && serial == tap.captureSerial {
			recorder = n
			break
		}
	}
	if tap.captureSerial == 0 {
		return pendingLinks{detail: "capture node absent"}
	}
	if recorder == nil {
		return errors.New("session capture node disappeared")
	}
	outputs, err := stereoPorts(graph, source.ID, "output")
	if err != nil {
		return err
	}
	inputs, portErr := stereoPorts(graph, tap.captureID, "input")
	states := [2]string{"missing", "missing"}
	for _, link := range graph {
		if !strings.HasSuffix(link.Type, ":Link") || link.Info.InputNode != tap.captureID {
			continue
		}
		if link.Info.OutputNode != source.ID {
			return errors.New("unexpected source entered application capture")
		}
		if link.Info.State == "error" {
			return errors.New("PipeWire failed to link the selected application")
		}
		if portErr != nil {
			continue
		}
		i := 0
		if link.Info.InputPort == inputs[1] {
			i = 1
		}
		if link.Info.OutputPort != outputs[i] || link.Info.InputPort != inputs[i] || states[i] != "missing" {
			return errors.New("unexpected or duplicate channel entered application capture")
		}
		switch link.Info.State {
		case "unlinked", "init", "negotiating", "allocating", "paused", "active":
			states[i] = link.Info.State
		default:
			states[i] = "unknown"
		}
	}
	if portErr != nil {
		return pendingLinks{detail: "capture " + portErr.Error()}
	}
	if states == [2]string{"missing", "missing"} {
		return pendingLinks{detail: "capture ports have no incoming links"}
	}
	if states == [2]string{"init", "init"} {
		return pendingLinks{
			detail: fmt.Sprintf("stereo link states (FL=init, FR=init); source=%s, recorder=%s, source pulse.corked=%s",
				publicNodeState(source.Info.State), publicNodeState(recorder.Info.State), pulseCorked(source.Info.Props["pulse.corked"])),
			idleSourceAtInit: source.Info.State == "idle" && recorder.Info.State == "suspended",
		}
	}
	for _, state := range states {
		if state != "active" && state != "paused" {
			return pendingLinks{detail: fmt.Sprintf("stereo link states (FL=%s, FR=%s)", states[0], states[1])}
		}
	}
	tap.verifiedLinkStates = states
	return nil
}

// pw-dump exposes the public node state, not the internal node->active flag.
func publicNodeState(state string) string {
	switch state {
	case "error", "creating", "suspended", "idle", "running":
		return state
	default:
		return "unknown"
	}
}

func pulseCorked(value any) string {
	switch value {
	case true, "true":
		return "true"
	case false, "false":
		return "false"
	default:
		return "unknown"
	}
}
