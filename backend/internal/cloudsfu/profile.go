package cloudsfu

import (
	"errors"
	"net"
	"os"
)

// This experimental media plane uses process-local leases. Keep the production
// Discord profile on the patched LiveKit admission path until crash recovery is verified.
func PrototypeEnabled(addr string, fixture bool) (bool, error) {
	switch os.Getenv("WHITERUN_MEDIA_TRANSPORT") {
	case "", "livekit":
		return false, nil
	case "cloudflare-prototype":
		host, _, err := net.SplitHostPort(addr)
		if err == nil && net.ParseIP(host).IsLoopback() && os.Getenv("WHITERUN_ENV") == "development" && os.Getenv("DISCORD_MODE") == "simulator" && fixture {
			return true, nil
		}
	}
	return false, errors.New("unsupported media transport or deployment profile")
}
