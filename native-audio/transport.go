package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type audioCredentials struct{ Session, Lease, Token, ServerURL, Transport string }
type sampleWriter func(media.Sample) error

func openAudioTransport(ctx context.Context, cancel context.CancelFunc, base string, credentials audioCredentials, timing *timingLog) (sampleWriter, func(), error) {
	if credentials.Transport == "cloudflare" {
		return openCloudflareAudio(ctx, cancel, base, credentials)
	}
	if credentials.Transport != "" {
		return nil, nil, errors.New("unsupported audio transport")
	}
	options := []lksdk.ConnectOption{lksdk.WithAutoSubscribe(false)}
	if timing != nil {
		options = append(options, lksdk.WithInterceptors([]interceptor.Factory{timingFactory{log: timing}}), lksdk.WithIncludeDefaultInterceptors(true))
	}
	room, err := lksdk.ConnectToRoomWithToken(credentials.ServerURL, credentials.Token, &lksdk.RoomCallback{OnDisconnected: cancel}, options...)
	credentials.Token = ""
	if err != nil {
		return nil, nil, errors.New("could not connect to LiveKit")
	}

	var startupExpired atomic.Bool
	startup := time.AfterFunc(8*time.Second, func() { startupExpired.Store(true); cancel() })
	defer startup.Stop()
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, lksdk.WithRTCPHandler(func(packet rtcp.Packet) {
		if report, ok := packet.(*rtcp.ReceiverReport); ok {
			for _, r := range report.Reports {
				timing.emit("rtcp_receiver_report", map[string]any{"ssrc": r.SSRC, "fractionLost": r.FractionLost, "totalLost": r.TotalLost, "jitterSamples": r.Jitter, "lastSequence": r.LastSequenceNumber})
			}
		}
	}))
	if err != nil {
		room.Disconnect()
		return nil, nil, errors.New("Opus publisher did not initialize")
	}
	var streamOnce sync.Once
	bound := make(chan struct{})
	track.OnBind(func() {
		timing.emit("publication_bound", map[string]any{})
		streamOnce.Do(func() { close(bound) })
	})
	track.OnUnbind(func() { timing.emit("publication_unbound", map[string]any{}) })

	pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "PipeWire selected audio", Source: livekit.TrackSource_SCREEN_SHARE_AUDIO})
	if err != nil {
		track.Close()
		room.Disconnect()
		return nil, nil, errors.New("audio publication rejected")
	}
	closeMedia := func() { room.LocalParticipant.UnpublishTrack(pub.SID()); track.Close(); room.Disconnect() }
	// Do not queue old desktop audio in an unread pipe during SDP/ICE negotiation.
	select {
	case <-bound:
	case <-ctx.Done():
		closeMedia()
		if startupExpired.Load() {
			return nil, nil, errors.New("audio publication did not bind within eight seconds")
		}
		return nil, nil, ctx.Err()
	}
	startup.Stop()

	return func(s media.Sample) error { return track.WriteSample(s, nil) }, closeMedia, nil
}

func openCloudflareAudio(ctx context.Context, cancel context.CancelFunc, base string, cred audioCredentials) (sampleWriter, func(), error) {
	codec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1"}
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: codec, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, nil, err
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine)).NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}})
	if err != nil {
		return nil, nil, errors.New("audio peer unavailable")
	}
	success := false
	defer func() {
		if !success {
			pc.Close()
		}
	}()
	setup, stop := context.WithTimeout(ctx, 18*time.Second)
	defer stop()
	path := "/native-audio/" + cred.Session
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-setup.Done():
				return
			case <-tick.C:
				if post(setup, base, path+"/lease", cred.Lease, struct{}{}, nil) != nil && setup.Err() == nil {
					cancel()
					return
				}
			}
		}
	}()
	connected := make(chan struct{})
	var once sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateConnected:
			once.Do(func() { close(connected) })
		case webrtc.PeerConnectionStateFailed:
			cancel()
		}
	})
	track, err := webrtc.NewTrackLocalStaticSample(codec, "game", "screen-audio")
	if err != nil {
		return nil, nil, err
	}
	tx, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return nil, nil, err
	}
	go func() {
		for {
			if _, _, e := tx.Sender().ReadRTCP(); e != nil {
				return
			}
		}
	}()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return nil, nil, errors.New("audio offer failed")
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		return nil, nil, errors.New("audio offer failed")
	}
	select {
	case <-gathered:
	case <-setup.Done():
		return nil, nil, errors.New("audio ICE gathering ended")
	}
	var out struct{ SDP string }
	if err = post(setup, base, path+"/publish", cred.Lease, map[string]string{"sdp": pc.LocalDescription().SDP, "mid": tx.Mid()}, &out); err != nil {
		return nil, nil, err
	}
	if pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: out.SDP}) != nil {
		return nil, nil, errors.New("audio answer unavailable")
	}
	select {
	case <-connected:
	case <-setup.Done():
		return nil, nil, errors.New("audio connection ended")
	}
	if err = post(setup, base, path+"/ready", cred.Lease, struct{}{}, nil); err != nil {
		return nil, nil, err
	}
	success = true
	return track.WriteSample, func() { pc.Close() }, nil
}
