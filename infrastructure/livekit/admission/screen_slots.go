// Part of the Screen Share overlay for the pinned LiveKit server.
package rtc

import (
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
)

const screenReservationTTL = 15 * time.Second

type screenReservation struct {
	track string
	until time.Time // zero once media has arrived
}

// One of these belongs to each SFU Room. Only a new screen uses a slot.
// Additional simulcast encodings keep the original track ID.
type ScreenSlots struct {
	mu            sync.Mutex
	byParticipant map[livekit.ParticipantID]screenReservation
}

func (s *ScreenSlots) reserve(owner livekit.ParticipantID, track string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byParticipant == nil {
		s.byParticipant = make(map[livekit.ParticipantID]screenReservation)
	}
	for id, slot := range s.byParticipant {
		if !slot.until.IsZero() && !now.Before(slot.until) {
			delete(s.byParticipant, id)
		}
	}
	if _, exists := s.byParticipant[owner]; exists || len(s.byParticipant) >= 4 {
		return false
	}
	s.byParticipant[owner] = screenReservation{track: track, until: now.Add(screenReservationTTL)}
	return true
}

func (s *ScreenSlots) activate(owner livekit.ParticipantID, track string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	slot, ok := s.byParticipant[owner]
	if !ok || slot.track != track || slot.until.IsZero() || !now.Before(slot.until) {
		return false
	}
	s.byParticipant[owner] = screenReservation{track: track}
	return true
}

func (s *ScreenSlots) release(owner livekit.ParticipantID, track string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if slot, ok := s.byParticipant[owner]; ok && (track == "" || slot.track == track) {
		delete(s.byParticipant, owner)
	}
}
