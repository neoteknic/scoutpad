package robotaudio

import (
	"bytes"
	"context"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/aler9/goroslib/pkg/msgproc"
)

func packet(size int) []byte {
	b := make([]byte, size)
	copy(b, []byte{0xff, 0xf1, 0x60, byte(0x40 | size>>11), byte(size >> 3), byte((size&7)<<5 | 0x1f), 0xfc})
	return b
}
func TestADTS(t *testing.T) {
	good := packet(10)
	frames, err := ParseADTS(append(append([]byte{}, good...), good...))
	if err != nil || len(frames) != 2 {
		t.Fatalf("%v, %d", err, len(frames))
	}
	for _, b := range [][]byte{nil, good[:8], packet(1025), bytes.Repeat(good, 486), append(good, 0)} {
		if _, err := ParseADTS(b); err == nil {
			t.Fatal("accepted invalid frame")
		}
	}
	for _, index := range []int{0, 1, 2, 3, 6} {
		b := packet(10)
		b[index] ^= 3
		if _, err := ParseADTS(b); err == nil {
			t.Fatalf("accepted invalid header %d", index)
		}
	}
	typ, err := msgproc.Type(frame{})
	if err != nil || typ != "roller_eye/frame" {
		t.Fatalf("wrong ROS type: %s %v", typ, err)
	}
}
func fakePlayer() *Player {
	return &Player{command: func(int32) {}, frame: func(uint32, []byte) {}, closePublishers: func() {}}
}
func TestStopAndSuspend(t *testing.T) {
	p := fakePlayer()
	if err := p.Play("test", [][]byte{packet(10)}); err != nil {
		t.Fatal(err)
	}
	p.Stop()
	p.workers.Wait()
	if p.Status().Playing {
		t.Fatal("still playing")
	}
	p.Suspend(true)
	if p.Play("blocked", nil) == nil {
		t.Fatal("accepted suspended play")
	}
	p.Suspend(false)
	p.Close()
	if p.Play("closed", nil) == nil {
		t.Fatal("accepted closed play")
	}
}

func TestRapidReplacementDoesNotFloodSpeakerCommands(t *testing.T) {
	p := fakePlayer()
	var commands []int32
	p.command = func(value int32) { commands = append(commands, value) }
	for i := 0; i < 40; i++ {
		p.Play("rapid", [][]byte{packet(10)})
		time.Sleep(time.Millisecond)
		p.Stop()
	}
	p.workers.Wait()
	if len(commands) > 1 || (len(commands) == 1 && commands[0] != 1) {
		t.Fatalf("flooded speaker: %v", commands)
	}
	p.Close()
}

func TestReadinessFailureSendsNothing(t *testing.T) {
	p := fakePlayer()
	p.connected = func() (bool, error) { return false, nil }
	p.command = func(int32) { t.Fatal("sent a command before speaker connected") }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if p.WaitReady(ctx) == nil {
		t.Fatal("accepted disconnected speaker")
	}
	p.connected = func() (bool, error) { return true, nil }
	if err := p.WaitReady(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.Close()
}
func TestPacingAndReplacement(t *testing.T) {
	p := fakePlayer()
	var mu sync.Mutex
	var times []time.Time
	p.frame = func(uint32, []byte) { mu.Lock(); times = append(times, time.Now()); mu.Unlock() }
	if err := p.Play("old", [][]byte{packet(10)}); err != nil {
		t.Fatal(err)
	}
	if err := p.Play("new", [][]byte{packet(10), packet(10), packet(10)}); err != nil {
		t.Fatal(err)
	}
	p.workers.Wait()
	mu.Lock()
	defer mu.Unlock()
	if len(times) != 3 {
		t.Fatalf("sent %d frames", len(times))
	}
	for i := 1; i < len(times); i++ {
		if times[i].Sub(times[i-1]) < 60*time.Millisecond {
			t.Fatal("burst frames")
		}
	}
	if p.Status().Playing {
		t.Fatal("playback not finished")
	}
	p.Close()
}
func req(h *Handler, path string, seq string, data []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, bytes.NewReader(data))
	r.Header.Set("X-Sound-Client", "test")
	r.Header.Set("X-Sound-Sequence", seq)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestStopInvalidatesPendingConnect(t *testing.T) {
	p := fakePlayer()
	entered := make(chan struct{})
	release := make(chan struct{})
	h := &Handler{Current: func() *Player { return p }, Connect: func(string) (*Player, error) { close(entered); <-release; return p, nil }}
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- req(h, "/api/soundboard/play", "1", packet(10)) }()
	<-entered
	if w := req(h, "/api/soundboard/stop", "2", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	close(release)
	if w := <-done; w.Code != 409 {
		t.Fatal(w.Code)
	}
	if p.Status().Playing {
		t.Fatal("pending playback restarted after stop")
	}
	if w := req(h, "/api/soundboard/play", "1", packet(10)); w.Code != 409 {
		t.Fatal(w.Code)
	}
	p.Close()
}
func TestEncodingAndSimulation(t *testing.T) {
	h := &Handler{Current: func() *Player { return nil }, Connect: func(string) (*Player, error) { t.Fatal("simulation connected"); return nil, nil }, Encode: func(context.Context, []byte) ([]byte, error) { return packet(10), nil }}
	if w := req(h, "/api/soundboard/encode", "", []byte{0, 0}); w.Code != 200 || w.Header().Get("Content-Type") != "audio/aac" {
		t.Fatal(w.Code)
	}
	if w := req(h, "/api/soundboard/encode", "", []byte{0}); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := req(h, "/api/soundboard/play?simulation=true", "1", packet(10)); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := req(h, "/api/soundboard/play", "2", []byte{0}); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
