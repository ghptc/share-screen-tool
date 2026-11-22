package rooms

import (
	"context"
	"net/http"

	"github.com/twitchtv/twirp"
)

func withBearer(ctx context.Context, token string) (context.Context, error) {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+token)
	return twirp.WithHTTPRequestHeaders(ctx, header)
}
