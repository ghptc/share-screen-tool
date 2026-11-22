package rtc

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
)

func TestConcurrentScreens(t *testing.T) {
	var room ScreenSlots
	now := time.Now()
	winners := make(chan livekit.ParticipantID, 12)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Go(func() {
			id := livekit.ParticipantID(fmt.Sprint(i))
			if room.reserve(id, "screen", now) {
				winners <- id
			}
		})
	}
	wg.Wait()
	close(winners)
	if len(winners) != 4 {
		t.Fatalf("admitted %d screens", len(winners))
	}
	for id := range winners {
		if !room.activate(id, "screen", now) || room.reserve(id, "second", now) {
			t.Fatal("invalid active slot")
		}
	}
	if room.reserve("fifth", "test", now.Add(time.Hour)) {
		t.Fatal("expired a live screen")
	}
	var other ScreenSlots
	if !other.reserve("fifth", "test", now) {
		t.Fatal("rooms share capacity")
	}
}

func TestLateMediaAndCleanup(t *testing.T) {
	var room ScreenSlots
	now := time.Now()
	room.reserve("one", "abandoned", now)
	later := now.Add(screenReservationTTL)
	if room.activate("one", "abandoned", later) {
		t.Fatal("accepted late media")
	}
	if !room.reserve("one", "current", later) {
		t.Fatal("expired reservation still held")
	}
	room.release("one", "abandoned")
	if room.activate("one", "abandoned", later) || !room.activate("one", "current", later) {
		t.Fatal("stale request affected new track")
	}
	room.release("one", "")
	if !room.reserve("two", "after-disconnect", later) {
		t.Fatal("failed to release on departure")
	}
}
