package mobilebridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/aler9/goroslib"
	"github.com/aler9/goroslib/pkg/msgs/geometry_msgs"
	"github.com/aler9/goroslib/pkg/msgs/std_msgs"
)

func TestCancelNavigationStopsSearchBeforeBothServices(t *testing.T) {
	var events []string
	err := cancelNavigationSequence(context.Background(), func() { events = append(events, "signal") },
		func(_ context.Context, name string, _ interface{}) error { events = append(events, name); return nil })
	if err != nil || len(events) != 9 || events[5] != "/NavPathNode/nav_cancel" || events[7] != "/CoreNode/nav_cancel" {
		t.Fatalf("incomplete cancellation sequence: %v, %v", events, err)
	}
}

func TestCancelNavigationRejectsPartialSuccess(t *testing.T) {
	for _, failed := range []string{"/NavPathNode/nav_cancel", "/CoreNode/nav_cancel"} {
		err := cancelNavigationSequence(context.Background(), func() {}, func(_ context.Context, name string, _ interface{}) error {
			if name == failed {
				return fmt.Errorf("unavailable")
			}
			return nil
		})
		if err == nil {
			t.Fatal("partial cancellation must not report success")
		}
	}
}

func TestCancelNavigationRespectsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := cancelNavigationSequence(ctx, func() {}, func(context.Context, string, interface{}) error {
		t.Fatal("called service after cancellation")
		return nil
	})
	if err != context.Canceled {
		t.Fatal(err)
	}
}

func TestHomeStatusTracksAllReturnPhases(t *testing.T) {
	c := testController(t)
	for _, status := range []int32{1, 2, 3, 8, 4, 5, 6, 7} {
		c.onHomeStatus(&std_msgs.Int32{Data: status})
		want := status < 4 || status == 8
		if c.docking != want {
			t.Fatalf("status %d: docking=%v", status, c.docking)
		}
	}
}

// Opt-in hardware test: starts a short return and cancels it, then watches for resumed motion.
func TestRobotReturnCancellation(t *testing.T) {
	ip := os.Getenv("SCOUT_TEST_ROBOT")
	if ip == "" {
		t.Skip("requires explicit permission and SCOUT_TEST_ROBOT")
	}
	installRobotResolver(ip)
	c := newController(ip)
	defer c.cancel()
	node, err := goroslib.NewNode(goroslib.NodeConf{Name: "scoutpad_cancel_test", MasterAddress: ip + ":11311", Host: chooseLocalIP(ip), TcprosPort: 18116})
	if err != nil {
		t.Fatal(err)
	}
	defer node.Close()
	pub, err := goroslib.NewPublisher(goroslib.PublisherConf{Node: node, Topic: "/AppNode/cancel_detect", Msg: &std_msgs.Int32{}})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	c.node, c.cancelDetectPub, c.healthy = node, pub, true
	home, err := goroslib.NewSubscriber(goroslib.SubscriberConf{Node: node, Topic: "/CoreNode/going_home_status", Callback: func(s *std_msgs.Int32) { t.Logf("robot return status: %d", s.Data); c.onHomeStatus(s) }})
	if err != nil {
		t.Fatal(err)
	}
	defer home.Close()
	var motionMu sync.Mutex
	var lastMoving time.Time
	motion, err := goroslib.NewSubscriber(goroslib.SubscriberConf{Node: node, Topic: "/cmd_vel", Callback: func(v *geometry_msgs.Twist) {
		if v.Linear.X != 0 || v.Linear.Y != 0 || v.Angular.Z != 0 {
			motionMu.Lock()
			lastMoving = time.Now()
			motionMu.Unlock()
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer motion.Close()
	time.Sleep(time.Second)
	baseline, stopBaseline := context.WithTimeout(context.Background(), 4*time.Second)
	err = c.cancelNavigation(baseline)
	stopBaseline()
	if err != nil {
		t.Fatal("initial safe cancellation: ", err)
	}
	time.Sleep(time.Second)
	invoke := func(action string, seq uint64) map[string]interface{} {
		body, _ := json.Marshal(commandRequest{RobotIP: ip, Action: action, ClientID: "hardware-test", CommandSeq: seq})
		response := httptest.NewRecorder()
		c.handleCommand(response, httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewReader(body)))
		var result map[string]interface{}
		json.Unmarshal(response.Body.Bytes(), &result)
		if response.Code != 200 {
			t.Fatalf("%s failed: %s", action, response.Body.String())
		}
		return result
	}
	// Always try cancellation, even if an assertion after docking fails.
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		c.cancelNavigation(ctx)
	}()
	if result := invoke("dock", 1); result["feedback"] != "dock" {
		t.Fatal(result)
	}
	time.Sleep(2 * time.Second)
	if result := invoke("cancelDock", 2); result["feedback"] != "cancelDock" {
		t.Fatal(result)
	}
	if c.active {
		t.Fatal("cancellation started an undock motion")
	}
	settled := time.Now().Add(time.Second)
	time.Sleep(11 * time.Second)
	motionMu.Lock()
	movingAt := lastMoving
	motionMu.Unlock()
	if movingAt.After(settled) {
		t.Fatalf("robot resumed motion after cancellation at %v", movingAt)
	}
	t.Log("no autonomous motion during the 10-second observation after cancellation")
}

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
