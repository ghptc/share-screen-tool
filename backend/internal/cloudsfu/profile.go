package cloudsfu

import (
	"errors"
	"net"
	"os"
)

// Private pilots and the simulator both run a single loopback controller.
// The private pilot also requires a tester list validated by discord.Load.
func PrototypeEnabled(addr string, fixture bool) (bool, error) {
	switch os.Getenv("WHITERUN_MEDIA_TRANSPORT") {
	case "", "livekit":
		return false, nil
	case "cloudflare-private":
		host, _, err := net.SplitHostPort(addr)
		if err == nil && net.ParseIP(host).IsLoopback() && os.Getenv("WHITERUN_ENV") == "production" && os.Getenv("DISCORD_MODE") == "discord" && !fixture && os.Getenv("DISCORD_PILOT_USERS") != "" {
			return true, nil
		}
	case "cloudflare-prototype":
		host, _, err := net.SplitHostPort(addr)
		if err == nil && net.ParseIP(host).IsLoopback() && os.Getenv("WHITERUN_ENV") == "development" && os.Getenv("DISCORD_MODE") == "simulator" && fixture {
			return true, nil
		}
	}
	return false, errors.New("unsupported media transport or deployment profile")
}
