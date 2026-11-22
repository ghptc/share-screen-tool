// Linux workstation ownership journal for one Cloudflare application. Every
// session is empty until its first track mutation; persist that mutation first.
package cloudsfu

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type OwnedMedia struct {
	Media
	directory *os.File
}

type ownership struct {
	Mid         string `json:"mid"`
	Publication string `json:"publication"`
	Direction   string `json:"direction"`
}

func openOwner(root, app string, media Media) (*OwnedMedia, error) {
	if root == "" || !appID.MatchString(app) {
		return nil, errors.New("missing SFU state directory or app identity")
	}
	path := filepath.Join(root, app)
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	fd, err := syscall.Open(path, syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	dir := os.NewFile(uintptr(fd), path)
	info, err := dir.Stat()
	if err != nil || info.Mode().Perm()&0077 != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		dir.Close()
		return nil, errors.New("SFU ownership directory must be owner-only")
	}
	if syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		dir.Close()
		return nil, errors.New("SFU ownership directory is in use")
	}
	return &OwnedMedia{media, dir}, nil
}
func (o *OwnedMedia) record(id string, entry ownership) error {
	if !resourceID.MatchString(id) {
		return errResponse
	}
	tmp, err := os.CreateTemp(o.directory.Name(), ".pending-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	err = json.NewEncoder(tmp).Encode(entry)
	if err == nil {
		err = tmp.Sync()
	}
	e := tmp.Close()
	if err != nil {
		return err
	}
	if e != nil {
		return e
	}
	if err = os.Rename(tmp.Name(), filepath.Join(o.directory.Name(), id+".track")); err != nil {
		return err
	}
	return o.directory.Sync()
}
func (o *OwnedMedia) Publish(ctx context.Context, id, name, mid, offer string) (string, error) {
	if err := o.record(id, ownership{mid, name, "local"}); err != nil {
		return "", err
	}
	return o.Media.Publish(ctx, id, name, mid, offer)
}
func (o *OwnedMedia) Subscribe(ctx context.Context, id, source, name string) (string, string, error) {
	entry := ownership{"", name, "remote"}
	if err := o.record(id, entry); err != nil {
		return "", "", err
	}
	mid, sdp, err := o.Media.Subscribe(ctx, id, source, name)
	if err != nil {
		return "", "", err
	}
	entry.Mid = mid
	if err = o.record(id, entry); err != nil {
		return mid, "", err
	}
	return mid, sdp, nil
}
func (o *OwnedMedia) Close(ctx context.Context, id, mid string) error {
	if !resourceID.MatchString(id) {
		return errResponse
	}
	if err := o.Media.Close(ctx, id, mid); err != nil {
		return err
	}
	err := os.Remove(filepath.Join(o.directory.Name(), id+".track"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return o.directory.Sync()
}

// Recovery revokes every old grant. OAuth cookies or helper leases never resume.
func (o *OwnedMedia) recover(ctx context.Context) error {
	entries, err := os.ReadDir(o.directory.Name())
	if err != nil {
		return err
	}
	var result error
	for _, file := range entries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if strings.HasPrefix(file.Name(), ".pending-") {
			continue
		} // Never authorized an upstream operation.
		id, ok := strings.CutSuffix(file.Name(), ".track")
		if !ok || !resourceID.MatchString(id) || !file.Type().IsRegular() {
			return errors.New("invalid SFU ownership journal")
		}
		data, err := os.ReadFile(filepath.Join(o.directory.Name(), file.Name()))
		var entry ownership
		if err != nil || json.Unmarshal(data, &entry) != nil || (entry.Direction != "local" && entry.Direction != "remote") || !resourceID.MatchString(entry.Publication) || (entry.Mid != "" && !resourceID.MatchString(entry.Mid)) {
			result = errors.New("unreadable SFU ownership record")
			continue
		}
		if err = o.Close(ctx, id, entry.Mid); err != nil {
			result = errors.New("SFU revocation pending")
		}
	}
	return result
}

// The child shares the exclusive directory lock and sees EOF when the controller
// dies, including SIGKILL. A replacement cannot signal until cleanup completes.
type Guard struct {
	*OwnedMedia
	lifetime *os.File
	Done     chan struct{}
}

func StartGuard(ctx context.Context, root string, c *Client) (*Guard, error) {
	o, err := openOwner(root, os.Getenv("CLOUDFLARE_SFU_APP_ID"), c)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			o.directory.Close()
		}
	}()
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	ready, ack, err := os.Pipe()
	if err != nil {
		writer.Close()
		return nil, err
	}
	defer ready.Close()
	cmd := exec.Command("/proc/self/exe", "sfu-watchdog", o.directory.Name())
	cmd.Env = []string{"CLOUDFLARE_SFU_APP_ID=" + os.Getenv("CLOUDFLARE_SFU_APP_ID"), "CLOUDFLARE_SFU_APP_SECRET=" + c.secret}
	cmd.ExtraFiles = []*os.File{reader, o.directory, ack}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	err = cmd.Start()
	ack.Close()
	if err != nil {
		writer.Close()
		return nil, err
	}
	g := &Guard{o, writer, make(chan struct{})}
	go func() { _ = cmd.Wait(); close(g.Done) }()
	_ = ready.SetReadDeadline(time.Now().Add(5 * time.Second))
	var signal [1]byte
	if _, err = io.ReadFull(ready, signal[:]); err != nil || signal[0] != 1 {
		writer.Close()
		return nil, errors.New("SFU watchdog unavailable")
	}
	// Arm the independent reaper before startup recovery. If recovery times
	// out, it still retries after this controller exits without opening admission.
	if err = o.recover(ctx); err != nil {
		writer.Close()
		return nil, err
	}
	ok = true
	return g, nil
}
func (g *Guard) Stop() { g.lifetime.Close(); g.directory.Close() }

func WatchController(path string) error {
	media, err := FromEnvironment()
	if err != nil {
		return err
	}
	parent := os.NewFile(3, "controller")
	dir := os.NewFile(4, path)
	ack := os.NewFile(5, "ready")
	defer dir.Close()
	defer parent.Close()
	info, err := dir.Stat()
	if err != nil || !info.IsDir() {
		return errors.New("invalid watchdog directory")
	}
	onDisk, err := os.Stat(path)
	if err != nil || !os.SameFile(info, onDisk) {
		return errors.New("invalid watchdog path")
	}
	if _, err = ack.Write([]byte{1}); err != nil {
		return err
	}
	ack.Close()
	_, _ = io.Copy(io.Discard, parent)
	o := &OwnedMedia{media, dir}
	delay := time.Second
	for {
		if err = o.recover(context.Background()); err == nil {
			return nil
		}
		time.Sleep(delay)
		delay = min(delay*2, 30*time.Second)
	}
}
