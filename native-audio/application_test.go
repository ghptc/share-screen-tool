package main

import (
	"encoding/json"
	"errors"
	"testing"
)

func fixtureGraph(t *testing.T) []graphObject {
	t.Helper()
	var g []graphObject
	err := json.Unmarshal([]byte(`[
 {"id":10,"type":"PipeWire:Interface:Node","info":{"props":{"object.serial":100,"node.name":"game","application.name":"Game","media.class":"Stream/Output/Audio"}}},
 {"id":20,"type":"PipeWire:Interface:Node","info":{"props":{"object.serial":200,"node.name":"whiterun-capture-test","media.class":"Stream/Input/Audio"}}},
 {"id":11,"type":"PipeWire:Interface:Port","info":{"direction":"output","props":{"node.id":10,"audio.channel":"FL"}}},
 {"id":12,"type":"PipeWire:Interface:Port","info":{"direction":"output","props":{"node.id":10,"audio.channel":"FR"}}},
 {"id":21,"type":"PipeWire:Interface:Port","info":{"direction":"input","props":{"node.id":20,"audio.channel":"FL"}}},
 {"id":22,"type":"PipeWire:Interface:Port","info":{"direction":"input","props":{"node.id":20,"audio.channel":"FR"}}},
 {"id":30,"type":"PipeWire:Interface:Link","info":{"state":"active","output-node-id":10,"input-node-id":20,"output-port-id":11,"input-port-id":21}},
 {"id":31,"type":"PipeWire:Interface:Link","info":{"state":"active","output-node-id":10,"input-node-id":20,"output-port-id":12,"input-port-id":22}}
 ]`), &g)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestApplicationLinkDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name    string
		change  func([]graphObject) []graphObject
		message string
		pending bool
	}{
		{"different recorder name", func(g []graphObject) []graphObject {
			g[1].Info.Props["node.name"] = "other-recorder"
			return g
		}, "capture node absent", true},
		{"no recorder ports", func(g []graphObject) []graphObject { return g[:4] }, "capture node has no ports", true},
		{"missing FR input", func(g []graphObject) []graphObject { return g[:5] }, "capture node lacks a complete pair of FL/FR input ports", true},
		{"direction mismatch", func(g []graphObject) []graphObject {
			g[5].Info.Direction = "output"
			g[5].Info.Props["port.direction"] = "in"
			return g
		}, "capture node lacks a complete pair of FL/FR input ports", true},
		{"monitor port", func(g []graphObject) []graphObject {
			g[5].Info.Props["port.monitor"] = true
			return g
		}, "capture node lacks a complete pair of FL/FR input ports", true},
		{"unpositioned port", func(g []graphObject) []graphObject {
			g[5].Info.Props["audio.channel"] = "UNK"
			return g
		}, "capture node has an unsupported or ambiguous input channel layout", true},
		{"headset links only", func(g []graphObject) []graphObject {
			g[6].Info.InputNode, g[7].Info.InputNode = 99, 99
			return g
		}, "capture ports have no incoming links", true},
		{"foreign source", func(g []graphObject) []graphObject {
			g[7].Info.OutputNode = 99
			return g
		}, "unexpected source entered application capture", false},
		{"foreign source with incomplete ports", func(g []graphObject) []graphObject {
			g[7].Info.OutputNode = 99
			return append(g[:5], g[6:]...)
		}, "unexpected source entered application capture", false},
		{"missing FR link", func(g []graphObject) []graphObject { return g[:7] }, "stereo link states (FL=active, FR=missing)", true},
		{"both links waiting", func(g []graphObject) []graphObject {
			g[6].Info.State, g[7].Info.State = "negotiating", "allocating"
			return g
		}, "stereo link states (FL=negotiating, FR=allocating)", true},
		{"unrecognized state is redacted", func(g []graphObject) []graphObject {
			g[6].Info.State, g[7].Info.State = "paused", "private-fixture-text"
			return g
		}, "stereo link states (FL=paused, FR=unknown)", true},
		{"link error", func(g []graphObject) []graphObject {
			g[6].Info.State = "error"
			return g
		}, "PipeWire failed to link the selected application", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tap := applicationTap{sourceSerial: 100, sourceID: 10, captureName: "whiterun-capture-test"}
			err := tap.verifyGraph(tc.change(fixtureGraph(t)))
			var pending pendingLinks
			if err == nil || err.Error() != tc.message || errors.As(err, &pending) != tc.pending {
				t.Fatalf("unexpected graph diagnosis: %v", err)
			}
		})
	}
}

func TestApplicationPausedLinksVerifyTopology(t *testing.T) {
	g := fixtureGraph(t)
	tap := applicationTap{sourceSerial: 100, sourceID: 10, captureName: "whiterun-capture-test"}
	for _, state := range []string{"paused", "active"} {
		g[6].Info.State, g[7].Info.State = state, state
		if err := tap.verifyGraph(g); err != nil || tap.verifiedLinkStates != [2]string{state, state} {
			t.Fatalf("expected two verified %s links, got %v (%v)", state, tap.verifiedLinkStates, err)
		}
	}
	// Recreating the recorder with the same name cannot inherit the tap.
	g[1].Info.Props["object.serial"] = float64(201)
	if err := tap.verifyGraph(g); err == nil || err.Error() != "session capture node disappeared" {
		t.Fatalf("recorder replacement: %v", err)
	}
}
func TestApplicationSelectionRejectsMonitorMicrophoneBrowserAndStaleSerial(t *testing.T) {
	g := fixtureGraph(t)
	if _, err := selectApplication(g, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := selectApplication(g, 10); err == nil {
		t.Fatal("transient node id accepted as serial")
	}
	for _, class := range []string{"Audio/Sink", "Audio/Source", "Stream/Input/Audio"} {
		g[0].Info.Props["media.class"] = class
		if applicationAllowed(g, g[0]) {
			t.Fatal("accepted non-application capture", class)
		}
	}
	g[0].Info.Props["media.class"] = "Stream/Output/Audio"
	for _, binary := range []string{"firefox", "chromium", "chrome", "brave", "whiterun-audio"} {
		g[0].Info.Props["application.process.binary"] = binary
		if applicationAllowed(g, g[0]) {
			t.Fatal("accepted mixed remote browser", binary)
		}
	}
}
func TestApplicationRejectsMixedClientAndFilterPlayback(t *testing.T) {
	g := fixtureGraph(t)
	client := graphObject{ID: 70, Type: "PipeWire:Interface:Client"}
	client.Info.Props = map[string]any{"pipewire.sec.flatpak.app-id": "org.mozilla.firefox"}
	g = append(g, client)
	g[0].Info.Props["client.id"] = float64(client.ID)
	if _, err := selectApplication(g, 100); err == nil {
		t.Fatal("browser client with a generic node name accepted")
	}
	delete(g[0].Info.Props, "client.id")
	for key, value := range map[string]any{"node.virtual": true, "node.link-group": "loopback", "media.role": "Communication"} {
		g[0].Info.Props[key] = value
		if _, err := selectApplication(g, 100); err == nil {
			t.Fatalf("accepted mixed stream with %s", key)
		}
		delete(g[0].Info.Props, key)
	}
}
func TestApplicationTapGraphFailsClosed(t *testing.T) {
	tap := applicationTap{sourceSerial: 100, sourceID: 10, captureSerial: 200, captureID: 20}
	if err := tap.verifyGraph(fixtureGraph(t)); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func([]graphObject) []graphObject{
		func(g []graphObject) []graphObject { g[0].Info.Props["object.serial"] = float64(101); return g },
		func(g []graphObject) []graphObject { g[1].Info.Props["object.serial"] = float64(201); return g },
		func(g []graphObject) []graphObject { g[7].Info.OutputNode = 99; return g },
		func(g []graphObject) []graphObject { g[7].Info.State = "error"; return g },
		func(g []graphObject) []graphObject { g[7].Info.OutputPort = 11; return g },
		func(g []graphObject) []graphObject { return g[:7] },
		func(g []graphObject) []graphObject { return append(g, g[7]) },
		func(g []graphObject) []graphObject { g[7] = g[6]; return g },
	} {
		if err := tap.verifyGraph(change(fixtureGraph(t))); err == nil {
			t.Fatal("changed capture graph accepted")
		}
	}
}

func TestApplicationExitRequiresNewSelection(t *testing.T) {
	graph := fixtureGraph(t)
	tap := applicationTap{sourceSerial: 100, sourceID: 10, captureSerial: 200, captureID: 20}
	if err := tap.verifyGraph(graph); err != nil {
		t.Fatal(err)
	}
	// The capture node remains, but the authorized application has exited.
	if err := tap.verifyGraph(graph[1:]); err == nil {
		t.Fatal("capture survived removal of its source")
	}
	// A new game stream reuses the node ID and ports with a different serial.
	graph[0].Info.Props["object.serial"] = float64(101)
	if err := tap.verifyGraph(graph); err == nil {
		t.Fatal("replacement application inherited authorization")
	}
}
func TestStereoPortsRejectAmbiguousOrUnsupportedLayout(t *testing.T) {
	g := fixtureGraph(t)
	ports, err := stereoPorts(g, 10, "output")
	if err != nil || ports != [2]uint64{11, 12} {
		t.Fatal(ports, err)
	}
	g[3].Info.Props["audio.channel"] = "MONO"
	if _, err := stereoPorts(g, 10, "output"); err == nil {
		t.Fatal("unsupported mono accepted")
	}
}

func TestRememberedApplicationBoundToPipeWireInstance(t *testing.T) {
	graph := fixtureGraph(t)
	instance := uint32(25)
	core := graphObject{Type: "PipeWire:Interface:Core"}
	core.Info.Cookie = &instance
	graph = append(graph, core)
	tap := applicationTap{core: "25", sourceSerial: 100, sourceID: 10, captureSerial: 200, captureID: 20}
	if err := tap.verifyGraph(graph); err != nil {
		t.Fatal(err)
	}
	instance++
	if err := tap.verifyGraph(graph); err == nil {
		t.Fatal("old selection accepted after PipeWire restart and serial reuse")
	}
}
