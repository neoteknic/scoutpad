package mobilebridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func testController(t *testing.T) *controller {
	t.Helper()
	c := newController("127.0.0.1")
	t.Cleanup(c.cancel)
	return c
}

func TestManualMotionWatchdog(t *testing.T) {
	c := testController(t)
	c.setMotion("drive", 0, 0.4, 0, false)
	c.targetAt = time.Now().Add(-300 * time.Millisecond)
	x, y, turn, publish := c.currentMotion()
	if x != 0 || y != 0 || turn != 0 || !publish || c.active {
		t.Fatal("expired manual motion must publish one stop")
	}
	if _, _, _, publish = c.currentMotion(); publish {
		t.Fatal("idle controller must not repeatedly publish stops")
	}
}

func TestAutomaticMotionHasOwnDeadline(t *testing.T) {
	c := testController(t)
	seq := c.setMotion("undock", 0, 0.4, 0, true)
	c.setAutomaticMotion(seq, 1800*time.Millisecond)
	c.targetAt = time.Now().Add(-500 * time.Millisecond)
	_, y, _, active := c.currentMotion()
	if y != 0.4 || !active {
		t.Fatal("manual watchdog interrupted automatic undock")
	}
	c.automaticUntil = time.Now().Add(-time.Millisecond)
	_, y, _, active = c.currentMotion()
	if y != 0 || !active || c.active {
		t.Fatal("automatic deadline did not publish a stop")
	}
}

func TestStopOverridesAutomaticMotion(t *testing.T) {
	c := testController(t)
	seq := c.setMotion("undock", 0, 0.4, 0, true)
	c.setMotion("stop", 0, 0, 0, true)
	c.setAutomaticMotion(seq, time.Second)
	if !c.automaticUntil.IsZero() || c.active {
		t.Fatal("old action revived after stop")
	}
}

func TestLateRequestCannotReviveMotion(t *testing.T) {
	c := testController(t)
	drive := commandRequest{ClientID: "test", CommandSeq: 1, Action: "drive"}
	stop := commandRequest{ClientID: "test", CommandSeq: 2, Action: "stop"}
	if !c.acceptCommand(&drive) || !c.acceptCommand(&stop) {
		t.Fatal("valid request rejected")
	}
	c.setCommandMotion(&stop, "stop", 0, 0, 0, true)
	if c.setCommandMotion(&drive, "drive", 0, 1, 0, false) != 0 || c.active {
		t.Fatal("late drive restarted motion after stop")
	}
	if c.acceptCommand(&drive) {
		t.Fatal("old sequence accepted")
	}
}

func TestConcurrentRequestsLeaveNewestMotion(t *testing.T) {
	c := testController(t)
	var group sync.WaitGroup
	for seq := uint64(1); seq <= 100; seq++ {
		group.Add(1)
		go func(seq uint64) {
			defer group.Done()
			req := commandRequest{ClientID: "test", CommandSeq: seq, Action: "drive"}
			if c.acceptCommand(&req) {
				c.setCommandMotion(&req, "drive", 0, float64(seq)/100, 0, false)
			}
		}(seq)
	}
	group.Wait()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.targetY != 1 {
		t.Fatalf("newest motion lost: %v", c.targetY)
	}
}

func TestSuspendedControllerRejectsMotion(t *testing.T) {
	c := testController(t)
	c.suspended = true
	drive := commandRequest{Action: "drive"}
	stop := commandRequest{Action: "stop"}
	if c.acceptCommand(&drive) || !c.acceptCommand(&stop) {
		t.Fatal("suspension gating failed")
	}
}

func TestNativeLifecycleInvalidatesOldRequest(t *testing.T) {
	c := testController(t)
	req := commandRequest{Action: "drive", ClientID: "test", CommandSeq: 1}
	c.acceptCommand(&req)
	c.inputEpoch += 2
	if c.commandCurrent(req) {
		t.Fatal("pre-suspension request survived resume")
	}
}

func TestActionCancellation(t *testing.T) {
	c := testController(t)
	first, releaseFirst := c.beginAction(context.Background())
	defer releaseFirst()
	second, releaseSecond := c.beginAction(context.Background())
	defer releaseSecond()
	if first.Err() == nil {
		t.Fatal("new action did not cancel old action")
	}
	c.cancelAction()
	if second.Err() == nil {
		t.Fatal("stop did not cancel action")
	}
}

func TestBackgroundWorkersTerminate(t *testing.T) {
	c := testController(t)
	c.workers.Add(2)
	go func() { defer c.workers.Done(); c.runPublisher() }()
	go func() { defer c.workers.Done(); c.runHealthMonitor() }()
	c.cancel()
	done := make(chan struct{})
	go func() { c.workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("backend workers leaked")
	}
}

func TestHTTPStopAndStaleDrive(t *testing.T) {
	c := testController(t)
	invoke := func(req commandRequest) *httptest.ResponseRecorder {
		body, _ := json.Marshal(req)
		r := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewReader(body))
		w := httptest.NewRecorder()
		c.handleCommand(w, r)
		return w
	}
	if invoke(commandRequest{ClientID: "test", CommandSeq: 2, Action: "stop"}).Code != http.StatusOK {
		t.Fatal("stop should work without ROS connection")
	}
	if invoke(commandRequest{ClientID: "test", CommandSeq: 1, Action: "drive", Y: -1}).Code != http.StatusConflict {
		t.Fatal("stale command was not rejected before connecting")
	}
}

func TestCameraStreamClosesWhenBackendStops(t *testing.T) {
	c := testController(t)
	c.onFrame(&frameMessage{Type: 1, Data: []byte{0xff, 0xd8, 0xff, 0xd9}})
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		c.streamCamera(w, r)
	}))
	defer server.Close()
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Content-Type") != "multipart/x-mixed-replace; boundary=scoutframe" {
		t.Fatal("invalid stream content type")
	}
	data := make([]byte, 10)
	if _, err = io.ReadFull(response.Body, data); err != nil {
		t.Fatal(err)
	}
	c.cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("stream survived backend stop")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cameraClients != 0 {
		t.Fatal("stream reader leaked")
	}
}
