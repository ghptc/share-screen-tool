package main

import (
	"errors"
	"testing"
	"time"
)

// Executable design, compiled only into the test binary. The graph validator
// is v5 code. The clock, recorder, frame boundary, lease and writer are fakes.
// A frame event has no payload. Nothing here opens a process, device or socket.
const (
	startupBudget = 30 * time.Second
	mockLeaseTTL  = 10 * time.Second
)

type startupModel struct {
	tap        applicationTap
	now        time.Duration // monotonic time since the claim request
	leaseUntil time.Duration
	setupUntil time.Duration // Cloudflare setup is bounded to 18 seconds
	phase      string
	reason     string

	route       [2]mockChannel
	routePinned bool
	verified    bool
	boundary    int // producer generation, zero means no admissible frames
	bound       bool

	starts, reaps, setups, closes, writes int
}

type mockChannel struct{ outPort, inPort, link uint64 }

func claimStartup(graph []graphObject, authorized, isolated bool) *startupModel {
	m := &startupModel{
		tap:        applicationTap{core: "9", sourceSerial: 103, sourceID: 10, captureName: "whiterun-capture-test"},
		phase:      "attaching",
		leaseUntil: mockLeaseTTL,
	}
	source, err := selectApplication(graph, m.tap.sourceSerial)
	if !authorized || !isolated || coreInstance(graph) != m.tap.core || err != nil || source.ID != m.tap.sourceID {
		m.stop("claim or selection unavailable")
		return m
	}
	if _, err := stereoPorts(graph, source.ID, "output"); err != nil {
		m.stop("unsupported source ports")
		return m
	}
	m.starts++
	return m
}

func startupGraph(t *testing.T) []graphObject {
	t.Helper()
	g := idleInitGraph(t)
	g[0].Info.Props["application.name"] = "Spotify"
	g[0].Info.Props["object.serial"] = float64(103)
	cookie := uint32(9)
	core := graphObject{Type: "PipeWire:Interface:Core"}
	core.Info.Cookie = &cookie
	return append(g, core)
}

func claimedStartup(t *testing.T) (*startupModel, []graphObject) {
	t.Helper()
	g := startupGraph(t)
	return claimStartup(g, true, true), g
}

func (m *startupModel) stop(reason string) {
	if m.phase == "stopped" {
		return
	}
	m.phase, m.reason = "stopped", reason
	m.bound, m.verified = false, false
	m.reaps += m.starts
	m.closes += m.setups
}

// Clock advancement delivers due timers even if no graph, lease or media
// callback arrives. A late callback therefore sees an absorbing terminal state.
func (m *startupModel) advanceTo(at time.Duration) {
	if at < m.now {
		panic("mock time moved backwards")
	}
	m.now = at
	if m.phase == "stopped" {
		return
	}
	deadline, reason := m.leaseUntil, "lease expired"
	if m.phase != "sharing" && startupBudget < deadline {
		deadline, reason = startupBudget, "startup timed out"
	}
	if m.phase == "attaching" && linkVerificationTimeout < deadline {
		deadline, reason = linkVerificationTimeout, "attachment timed out"
	}
	if m.phase == "connecting" && !m.bound && m.setupUntil < deadline {
		deadline, reason = m.setupUntil, "transport timed out"
	}
	if m.now >= deadline {
		m.stop(reason)
	}
}

// The mock only has one renewal outstanding at a time.
func (m *startupModel) renew(sent time.Duration) {
	if m.phase != "stopped" && sent+mockLeaseTTL > m.leaseUntil {
		m.leaseUntil = sent + mockLeaseTTL
	}
}

// Observe port/link identities from the fixture independently of the link
// states. Actual remove events are terminal even when object IDs are reused.
func mockRoute(g []graphObject, tap applicationTap) (route [2]mockChannel, complete bool) {
	out, outErr := stereoPorts(g, tap.sourceID, "output")
	in, inErr := stereoPorts(g, tap.captureID, "input")
	if outErr != nil || inErr != nil {
		return route, false
	}
	for _, l := range g {
		if l.Type != "PipeWire:Interface:Link" || l.Info.InputNode != tap.captureID {
			continue
		}
		for ch := range in {
			if l.Info.OutputNode == tap.sourceID && l.Info.OutputPort == out[ch] && l.Info.InputPort == in[ch] {
				route[ch] = mockChannel{out[ch], in[ch], l.ID}
			}
		}
	}
	return route, route[0].link != 0 && route[1].link != 0
}

func (m *startupModel) observe(g []graphObject) {
	if m.phase == "stopped" {
		return
	}
	err := m.tap.verifyGraph(g)
	var pending pendingLinks
	if err != nil && !errors.As(err, &pending) {
		m.stop("graph rejected")
		return
	}
	route, complete := mockRoute(g, m.tap)
	if m.routePinned && (!complete || route != m.route) {
		m.stop("bound route changed")
		return
	}
	if err != nil && m.verified {
		m.stop("verified route lost")
		return
	}
	if !complete {
		return
	}
	for _, l := range g {
		if l.Type == "PipeWire:Interface:Link" && l.Info.InputNode == m.tap.captureID {
			switch l.Info.State {
			case "init", "negotiating", "allocating", "paused", "active":
			default:
				m.stop("invalid link state")
				return
			}
		}
	}
	m.route, m.routePinned = route, true
	if m.phase == "attaching" && (pending.idleSourceAtInit || err == nil) {
		m.phase = "waiting"
	}
	if !m.verified && err == nil {
		m.verified = true
		m.boundary++ // discard frames accumulated before exact verification
	}
}

func (m *startupModel) frame(boundary int) {
	if !m.verified || m.phase == "stopped" || boundary != m.boundary {
		return
	}
	switch m.phase {
	case "waiting":
		m.phase = "connecting"
		m.setups++
		m.setupUntil = m.now + 18*time.Second
	case "connecting", "sharing":
		if m.bound {
			m.writes++ // mock of a successful writer call
			m.phase = "sharing"
		}
	}
}

func (m *startupModel) mediaBound(current []graphObject) {
	if m.phase != "connecting" || m.bound {
		return
	}
	m.observe(current)
	if m.phase == "connecting" && m.verified {
		m.boundary++ // discard everything produced before the bind recheck
		m.bound = true
	}
}

func TestIdleStartupSameRecorderWakes(t *testing.T) {
	m, g := claimedStartup(t)
	m.observe(g)
	m.frame(0)
	for sec := 2; sec <= 14; sec += 2 {
		m.advanceTo(time.Duration(sec) * time.Second)
		m.renew(m.now)
		m.observe(g)
	}
	g[0].Info.State = "running"
	g[0].Info.Props["pulse.corked"] = false
	g[6].Info.State, g[7].Info.State = "negotiating", "allocating"
	m.observe(g)
	g[6].Info.State, g[7].Info.State = "active", "init"
	m.observe(g)
	m.frame(0)
	if m.phase != "waiting" || m.verified || m.setups != 0 || m.writes != 0 {
		t.Fatal("node state, queued data or a partial pair opened the gate", m)
	}

	g[6].Info.State, g[7].Info.State = "paused", "paused"
	m.observe(g)
	if !m.verified || m.phase != "waiting" || m.setups != 0 {
		t.Fatal("paused links must verify topology and still wait for data", m)
	}
	g[6].Info.State, g[7].Info.State = "active", "active"
	m.observe(g)
	m.frame(0) // queued before verification
	if m.setups != 0 {
		t.Fatal("a stale frame opened media")
	}
	verified := m.boundary
	m.frame(verified)
	m.frame(verified) // setup is still blocked
	m.mediaBound(g)
	m.frame(verified) // late delivery from before bind
	if m.phase != "connecting" || m.setups != 1 || m.writes != 0 {
		t.Fatal("media setup replayed data or announced sharing", m)
	}
	m.frame(m.boundary)
	if m.phase != "sharing" || m.starts != 1 || m.reaps != 0 || m.writes != 1 || m.tap.captureSerial != 200 {
		t.Fatal("expected first fresh write on the original recorder", m)
	}
}

func TestIdleStartupDeadlines(t *testing.T) {
	for _, phase := range []string{"idle", "verified without frames", "blocked transport"} {
		t.Run(phase, func(t *testing.T) {
			m, g := claimedStartup(t)
			m.observe(g)
			if phase != "idle" {
				g[6].Info.State, g[7].Info.State = "paused", "active"
				m.observe(g)
			}
			for sec := 2; sec <= 28; sec += 2 {
				m.advanceTo(time.Duration(sec) * time.Second)
				m.renew(m.now)
				m.observe(g)
				if sec == 24 && phase == "blocked transport" {
					m.frame(m.boundary)
				}
			}
			m.advanceTo(startupBudget - time.Nanosecond)
			if m.phase == "stopped" {
				t.Fatal("ended before the hard deadline", m)
			}
			m.advanceTo(startupBudget)
			m.mediaBound(g)
			m.frame(m.boundary)
			if m.reason != "startup timed out" || m.starts != 1 || m.reaps != 1 || m.closes != m.setups || m.writes != 0 {
				t.Fatal("startup survived or restarted at its deadline", m)
			}
		})
	}
	t.Run("partial graph has only three seconds", func(t *testing.T) {
		m, g := claimedStartup(t)
		g[7] = graphObject{} // missing FR, core still visible
		m.observe(g)
		m.advanceTo(linkVerificationTimeout)
		if m.reason != "attachment timed out" || m.setups != 0 {
			t.Fatal(m)
		}
	})
	t.Run("transport setup has its own shorter cap", func(t *testing.T) {
		m, g := claimedStartup(t)
		g[6].Info.State, g[7].Info.State = "active", "active"
		m.observe(g)
		m.frame(m.boundary)
		for sec := 2; sec <= 18; sec += 2 {
			m.advanceTo(time.Duration(sec) * time.Second)
			m.renew(m.now)
		}
		if m.reason != "transport timed out" || m.writes != 0 || m.closes != 1 {
			t.Fatal(m)
		}
	})
}

func TestIdleStartupInvalidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func([]graphObject)
	}{
		{"application exit", func(g []graphObject) { g[0] = graphObject{} }},
		{"same name and node ID, new source serial", func(g []graphObject) { g[0].Info.Props["object.serial"] = float64(104) }},
		{"new core, same serials", func(g []graphObject) { *g[8].Info.Cookie = 10 }},
		{"same name, new recorder", func(g []graphObject) { g[1].Info.Props["object.serial"] = float64(201) }},
		{"browser", func(g []graphObject) { g[0].Info.Props["application.process.binary"] = "firefox" }},
		{"microphone", func(g []graphObject) { g[0].Info.Props["media.class"] = "Audio/Source" }},
		{"whole output monitor", func(g []graphObject) { g[0].Info.Props["media.class"] = "Audio/Sink" }},
		{"monitor port", func(g []graphObject) { g[3].Info.Props["port.monitor"] = true }},
		{"extra application input", func(g []graphObject) {
			g[9] = g[7]
			g[9].ID, g[9].Info.OutputNode = 32, 99
		}},
		{"duplicate FR", func(g []graphObject) {
			g[9] = g[7]
			g[9].ID = 32
		}},
		{"crossed channels", func(g []graphObject) { g[7].Info.OutputPort = 11 }},
		{"lost FR link", func(g []graphObject) { g[7] = graphObject{} }},
		{"replaced link", func(g []graphObject) { g[7].ID = 32 }},
		{"replaced port", func(g []graphObject) { g[5].ID, g[7].Info.InputPort = 23, 23 }},
		{"link error", func(g []graphObject) { g[7].Info.State = "error" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, g := claimedStartup(t)
			m.observe(g)
			g = append(g, graphObject{}) // room for an additional incoming link
			tc.change(g)
			m.observe(g)
			m.observe(startupGraph(t)) // catalog/snapshot sees the same name again
			m.frame(m.boundary)
			if m.phase != "stopped" || m.now != 0 || m.reaps != 1 || m.starts != 1 || m.setups != 0 || m.writes != 0 {
				t.Fatal("invalidation must win immediately and require reselection", m)
			}
		})
	}
}

func TestIdleStartupStopWinsOverLateCallbacks(t *testing.T) {
	for _, phase := range []string{"waiting", "connecting", "sharing"} {
		for _, reason := range []string{"Discord revoked", "owner stopped", "screen ended", "helper watch closed", "recorder exited", "graph observer lost", "lease expired"} {
			t.Run(phase+"/"+reason, func(t *testing.T) {
				m, g := claimedStartup(t)
				m.observe(g)
				if phase != "waiting" {
					g[6].Info.State, g[7].Info.State = "active", "active"
					m.observe(g)
					m.frame(m.boundary)
				}
				if phase == "sharing" {
					m.mediaBound(g)
					m.frame(m.boundary)
				}
				if m.phase != phase {
					t.Fatalf("fixture entered %s", m.phase)
				}
				writes := m.writes
				if reason == "lease expired" {
					m.advanceTo(mockLeaseTTL)
				} else {
					m.stop(reason)
				}
				m.renew(time.Second) // success arrives after cancellation/expiry
				m.observe(g)
				m.mediaBound(g)
				m.frame(m.boundary)
				m.stop("second notification")
				if m.reason != reason || m.leaseUntil != mockLeaseTTL || m.writes != writes || m.starts != 1 || m.reaps != 1 || m.closes != m.setups {
					t.Fatal("late callback reopened the gate or repeated teardown", m)
				}
			})
		}
	}
}

func TestIdleStartupRechecksAtBind(t *testing.T) {
	m, g := claimedStartup(t)
	g[6].Info.State, g[7].Info.State = "active", "active"
	m.observe(g)
	m.frame(m.boundary)
	g[7].Info.OutputNode = 99
	m.mediaBound(g)
	m.frame(m.boundary)
	if m.phase != "stopped" || m.writes != 0 || m.closes != 1 || m.reaps != 1 {
		t.Fatal("foreign input raced transport setup", m)
	}
}

func TestIdleStartupRechecksSelectionAfterClaim(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		authorized, isolated bool
		serial               int
	}{
		{"owner or Discord authorization lost", false, true, 103},
		{"input isolation unavailable", true, false, 103},
		{"stream replaced while pairing", true, true, 104},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := startupGraph(t)
			g[0].Info.Props["object.serial"] = float64(tc.serial)
			m := claimStartup(g, tc.authorized, tc.isolated)
			m.observe(startupGraph(t))
			m.frame(0)
			if m.phase != "stopped" || m.starts != 0 || m.setups != 0 || m.writes != 0 {
				t.Fatal("recorder must require the original eligible, authorized selection", m)
			}
		})
	}
}

func TestIdleStartupDelayedLeaseReply(t *testing.T) {
	m, g := claimedStartup(t)
	m.observe(g)
	m.advanceTo(9 * time.Second)
	m.renew(2 * time.Second) // reply took seven seconds to arrive
	m.advanceTo(12*time.Second - time.Nanosecond)
	if m.phase != "waiting" {
		t.Fatal("expected a valid, conservatively timed lease", m)
	}
	m.advanceTo(12 * time.Second)
	if m.reason != "lease expired" || m.setups != 0 || m.reaps != 1 {
		t.Fatal("network delay extended the lease", m)
	}
}

// Proposed owner-watch consumer. A fresh user action creates a new view
// bound to a new session. Heartbeats and catalog refreshes cannot do so.
type mockOwnerView struct {
	session, phase, reason string
	sequence               int
	deadline               time.Duration
}

func (v *mockOwnerView) status(session string, sequence int, model *startupModel) {
	if session != v.session || sequence <= v.sequence || v.phase == "stopped" {
		return
	}
	v.sequence, v.phase, v.reason = sequence, model.phase, model.reason
}

func TestIdleStartupOwnerStatus(t *testing.T) {
	m, g := claimedStartup(t)
	view := mockOwnerView{session: "attempt-a", deadline: startupBudget}
	m.observe(g)
	m.advanceTo(6 * time.Second)
	view.status("attempt-a", 1, m)
	if view.phase != "waiting" || view.deadline-m.now != 24*time.Second {
		t.Fatal("the owner needs a waiting state with the remaining budget", view)
	}
	g[6].Info.State, g[7].Info.State = "active", "active"
	m.observe(g)
	m.frame(m.boundary)
	m.mediaBound(g)
	view.status("attempt-a", 2, m)
	if view.phase != "connecting" {
		t.Fatal("bind alone announced sharing", view)
	}
	m.frame(m.boundary)
	view.status("attempt-a", 1, m)
	if view.phase != "connecting" {
		t.Fatal("an out-of-order event changed status", view)
	}
	view.status("attempt-a", 3, m)
	if view.phase != "sharing" {
		t.Fatal("first successful sample write should announce sharing", view)
	}
	delayed := *m
	m.stop("owner stopped")
	view.status("attempt-a", 4, m)
	view.status("attempt-a", 5, &delayed)
	view.status("another-screen", 6, &delayed)
	if view.phase != "stopped" || view.reason != "owner stopped" || view.sequence != 4 {
		t.Fatal("a late sharing event replaced the terminal message", view)
	}
}
