package main

import "testing"

func TestOnlyExplicitOutputSinks(t *testing.T) {
	nodes, err := sinks([]byte(`[{"id":1,"info":{"props":{"media.class":"Audio/Source","node.name":"mic","object.serial":10}}},{"id":2,"info":{"props":{"media.class":"Audio/Sink","node.name":"headphones","object.serial":11}}}]`))
	if err != nil || len(nodes) != 1 {
		t.Fatal(nodes, err)
	}
	if _, err := target(nodes, "mic"); err == nil {
		t.Fatal("microphone accepted")
	}
	if _, err := target(nodes, ""); err == nil {
		t.Fatal("implicit default accepted")
	}
	serial, err := target(nodes, "headphones")
	if err != nil || serial != "11" {
		t.Fatal(serial, err)
	}
	if _, err := target(nodes, "removed"); err == nil {
		t.Fatal("unavailable device accepted")
	}
}
func TestCredentialTransport(t *testing.T) {
	for _, raw := range []string{"http://example.com/api", "http://user:secret@localhost/api", "http://localhost/api?code=secret", "file:///tmp/key"} {
		if _, err := apiURL(raw); err == nil {
			t.Fatal("unsafe URL accepted", raw)
		}
	}
	for _, raw := range []string{"http://localhost:5173/api", "https://example.com/api"} {
		if _, err := apiURL(raw); err != nil {
			t.Fatal(err)
		}
	}
}
