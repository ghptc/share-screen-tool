package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Exercise the proposed direct WebRTC transport with the helper's existing
// encoder and clock. No PipeWire connection, LiveKit signaling or SFU secret.
func TestNativeOpusOverWebRTC(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	peer := func() *webrtc.PeerConnection {
		pc, err := api.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pc.Close() })
		return pc
	}
	sender, receiver := peer(), peer()
	const frames = 25
	packets := make(chan *rtp.Packet, frames)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Codec().MimeType != webrtc.MimeTypeOpus || track.Codec().Channels != 2 || track.Codec().ClockRate != 48000 {
			return
		}
		for i := 0; i < frames; i++ {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			packets <- pkt
		}
	})
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "game", "screen")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sender.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatal(err)
	}
	connected := make(chan struct{}, 1)
	sender.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	exchange := func(from, to *webrtc.PeerConnection, d webrtc.SessionDescription) {
		done := webrtc.GatheringCompletePromise(from)
		if err := from.SetLocalDescription(d); err != nil {
			t.Fatal(err)
		}
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal("ICE gathering timed out")
		}
		if err := to.SetRemoteDescription(*from.LocalDescription()); err != nil {
			t.Fatal(err)
		}
	}
	offer, err := sender.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	exchange(sender, receiver, offer)
	answer, err := receiver.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	exchange(receiver, sender, answer)
	select {
	case <-connected:
	case <-ctx.Done():
		t.Fatal("WebRTC connection timed out")
	}
	encoder, err := newOpusEncoder()
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.close()
	var payloads [][]byte
	err = pumpOpus(ctx, func() ([]byte, error) {
		if len(payloads) == frames {
			return nil, io.EOF
		}
		packet, err := encoder.encode(toneFrame(len(payloads)))
		payloads = append(payloads, bytes.Clone(packet))
		return packet, err
	}, track.WriteSample, nil)
	if !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	var previous *rtp.Packet
	for i := range frames {
		select {
		case pkt := <-packets:
			if !bytes.Equal(payloads[i], pkt.Payload) {
				t.Fatal("Opus frame changed in transport")
			}
			if previous != nil && (pkt.Timestamp-previous.Timestamp != 960 || pkt.SequenceNumber-previous.SequenceNumber != 1) {
				t.Fatal("Opus RTP discontinuity")
			}
			previous = pkt
		case <-ctx.Done():
			t.Fatalf("received %d/%d Opus frames", i, frames)
		}
	}
}
