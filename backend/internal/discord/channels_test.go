package discord

import (
	"strings"
	"testing"
)

func TestChannelRoomMapping(t *testing.T) {
	key := strings.Repeat("a", 32)
	d, err := NewDirectory(key, "123/456,123/457,124/456")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := NewDirectory(key, "124/456,123/457,123/456")
	seen := map[string]bool{}
	for _, ch := range []Channel{{"123", "456"}, {"124", "456"}, {"123", "457"}} {
		ref, ok := d.Reference(ch)
		restored, _ := again.Reference(ch)
		reverse, _ := d.Lookup(ref)
		if !ok || len(ref) != 32 || seen[ref] || ref != restored || reverse != ch {
			t.Fatal("room mapping is not stable and isolated")
		}
		seen[ref] = true
	}
	if _, ok := d.Reference(Channel{"999", "456"}); ok {
		t.Fatal("unsupported channel accepted")
	}
}
