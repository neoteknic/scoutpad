package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/aler9/goroslib"
	"github.com/aler9/goroslib/pkg/msg"
	"github.com/aler9/goroslib/pkg/msgs/geometry_msgs"
)

type goHomeRequest struct{}
type goHomeResponse struct{}

type goHomeService struct {
	msg.Package `ros:"/nav_low_bat"`
	Request     goHomeRequest
	Response    goHomeResponse
}

type adjustLightRequest struct {
	Cmd int32 `ros:"cmd int32"`
}

type adjustLightResponse struct{}

type adjustLightService struct {
	msg.Package `ros:"/CoreNode/adjust_light"`
	Request     adjustLightRequest
	Response    adjustLightResponse
}

type navCancelRequest struct{}
type navCancelResponse struct{}

type coreNavCancelService struct {
	msg.Package `ros:"/CoreNode/nav_cancel"`
	Request     navCancelRequest
	Response    navCancelResponse
}

type navPathCancelService struct {
	msg.Package `ros:"/NavPathNode/nav_cancel"`
	Request     navCancelRequest
	Response    navCancelResponse
}

type commandRequest struct {
	Action     string  `json:"action"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Turn       float64 `json:"turn"`
	DurationMs int     `json:"durationMs"`
}

type bridgeServer struct {
	node       *goroslib.Node
	pub        *goroslib.Publisher
	forcePub   *goroslib.Publisher
	topic      string
	startedAt  time.Time
	lastAction string
	lastError  string
	targetX    float64
	targetY    float64
	targetTurn float64
	targetAt   time.Time
	active     bool
	seq        uint64
	mu         sync.Mutex
	writeMu    sync.Mutex
}

func main() {
	master := flag.String("master", "192.168.0.142:11311", "ROS master host:port")
	host := flag.String("host", "", "local host/IP announced to ROS")
	topic := flag.String("topic", "/cmd_vel", "Twist command topic")
	tcprosPort := flag.Int("tcpros-port", 18112, "local TCPROS port")
	listen := flag.String("listen", "127.0.0.1:18114", "local HTTP listen address")
	flag.Parse()

	conf := goroslib.NodeConf{
		Name:          "scout-access",
		MasterAddress: *master,
		TcprosPort:    *tcprosPort,
	}
	if *host != "" {
		conf.Host = *host
	}

	n, err := goroslib.NewNode(conf)
	if err != nil {
		fail(err)
	}
	defer n.Close()

	pub, err := goroslib.NewPublisher(goroslib.PublisherConf{
		Node:  n,
		Topic: *topic,
		Msg:   &geometry_msgs.Twist{},
		Latch: true,
	})
	if err != nil {
		fail(err)
	}
	defer pub.Close()

	forcePub, err := goroslib.NewPublisher(goroslib.PublisherConf{
		Node:  n,
		Topic: "/cmd_vel_force",
		Msg:   &geometry_msgs.Twist{},
		Latch: true,
	})
	if err != nil {
		fail(err)
	}
	defer forcePub.Close()

	s := &bridgeServer{
		node:      n,
		pub:       pub,
		forcePub:  forcePub,
		topic:     *topic,
		startedAt: time.Now(),
		targetAt:  time.Now(),
	}
	go s.runPublisher()

	mux := http.NewServeMux()
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/command", s.handleCommand)

	fmt.Printf("scout-bridge listening on http://%s\n", *listen)
	if err := http.ListenAndServe(*listen, mux); err != nil {
		fail(err)
	}
}

func (s *bridgeServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	targetAgeMs := time.Since(s.targetAt).Milliseconds()
	lastAction := s.lastAction
	lastError := s.lastError
	active := s.active
	target := map[string]float64{"x": s.targetX, "y": s.targetY, "turn": s.targetTurn}
	s.mu.Unlock()

	sendJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"topic":       s.topic,
		"startedAt":   s.startedAt.Format(time.RFC3339),
		"lastAction":  lastAction,
		"lastError":   lastError,
		"active":      active,
		"target":      target,
		"targetAgeMs": targetAgeMs,
	})
}

func (s *bridgeServer) handleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}

	var req commandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	if req.Action == "" {
		req.Action = "drive"
	}

	var err error
	switch req.Action {
	case "dock":
		s.setMotion("stop", 0, 0, 0)
		go s.callGoHomeAsync()
	case "cancelNav":
		s.setForceMotion("stop", 0, 0, 0)
		go s.cancelNavigation()
	case "forceDrive":
		seq := s.setForceMotion("drive", req.X, req.Y, req.Turn)
		if req.DurationMs > 0 {
			time.AfterFunc(time.Duration(req.DurationMs)*time.Millisecond, func() {
				s.stopIfCurrent(seq)
				s.publishForceTwist(0, 0, 0)
			})
		}
	case "lightLow":
		err = callLight(s.node, 0)
	case "lightHigh":
		err = callLight(s.node, 1)
	case "stop":
		s.setMotion("stop", 0, 0, 0)
	default:
		seq := s.setMotion("drive", req.X, req.Y, req.Turn)
		if req.DurationMs > 0 {
			time.AfterFunc(time.Duration(req.DurationMs)*time.Millisecond, func() {
				s.stopIfCurrent(seq)
			})
		}
	}

	if err != nil {
		s.mu.Lock()
		s.lastError = err.Error()
		s.lastAction = req.Action
		s.mu.Unlock()
		sendJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.mu.Lock()
	s.lastAction = req.Action
	s.lastError = ""
	s.mu.Unlock()
	sendJSON(w, http.StatusOK, map[string]any{"ok": true, "action": req.Action})
}

func (s *bridgeServer) callGoHomeAsync() {
	if err := callGoHome(s.node); err != nil {
		s.mu.Lock()
		s.lastError = err.Error()
		s.mu.Unlock()
	}
}

func (s *bridgeServer) cancelNavigation() {
	for _, call := range []func(*goroslib.Node) error{callCoreNavCancel, callNavPathCancel} {
		if err := call(s.node); err != nil {
			s.mu.Lock()
			s.lastError = err.Error()
			s.mu.Unlock()
		}
	}
}

func (s *bridgeServer) runPublisher() {
	ticker := time.NewTicker(55 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		x, y, turn, ok := s.currentMotion()
		if ok {
			s.publishTwist(x, y, turn)
		}
	}
}

func (s *bridgeServer) currentMotion() (float64, float64, float64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if time.Since(s.targetAt) > 260*time.Millisecond {
		if !s.active {
			return 0, 0, 0, false
		}
		s.targetX = 0
		s.targetY = 0
		s.targetTurn = 0
		s.active = false
		s.lastAction = "stop"
		return 0, 0, 0, true
	}
	return s.targetX, s.targetY, s.targetTurn, s.active
}

func (s *bridgeServer) setMotion(action string, x, y, turn float64) uint64 {
	s.mu.Lock()
	s.seq++
	seq := s.seq
	s.targetX = x
	s.targetY = y
	s.targetTurn = turn
	s.targetAt = time.Now()
	s.active = x != 0 || y != 0 || turn != 0
	s.lastAction = action
	s.mu.Unlock()

	s.publishTwist(x, y, turn)
	return seq
}

func (s *bridgeServer) setForceMotion(action string, x, y, turn float64) uint64 {
	seq := s.setMotion(action, x, y, turn)
	s.publishForceTwist(x, y, turn)
	return seq
}

func (s *bridgeServer) stopIfCurrent(seq uint64) {
	s.mu.Lock()
	if s.seq != seq {
		s.mu.Unlock()
		return
	}
	s.seq++
	s.targetX = 0
	s.targetY = 0
	s.targetTurn = 0
	s.targetAt = time.Now()
	s.active = false
	s.lastAction = "stop"
	s.mu.Unlock()

	s.publishTwist(0, 0, 0)
}

func (s *bridgeServer) publishTwist(x, y, turn float64) {
	s.publishWith(s.pub, x, y, turn)
}

func (s *bridgeServer) publishForceTwist(x, y, turn float64) {
	s.publishWith(s.forcePub, x, y, turn)
}

func (s *bridgeServer) publishWith(pub *goroslib.Publisher, x, y, turn float64) {
	msg := &geometry_msgs.Twist{
		Linear: geometry_msgs.Vector3{
			X: x * 0.45,
			Y: y,
		},
		Angular: geometry_msgs.Vector3{
			Z: turn * -3.2,
		},
	}

	s.writeMu.Lock()
	pub.Write(msg)
	s.writeMu.Unlock()
}

func callGoHome(n *goroslib.Node) error {
	cl, err := goroslib.NewServiceClient(goroslib.ServiceClientConf{
		Node: n,
		Name: "/nav_low_bat",
		Srv:  &goHomeService{Request: goHomeRequest{}},
	})
	if err != nil {
		return err
	}
	defer cl.Close()
	return cl.Call(&goHomeRequest{}, &goHomeResponse{})
}

func callLight(n *goroslib.Node, cmd int32) error {
	cl, err := goroslib.NewServiceClient(goroslib.ServiceClientConf{
		Node: n,
		Name: "/CoreNode/adjust_light",
		Srv:  &adjustLightService{Request: adjustLightRequest{Cmd: cmd}},
	})
	if err != nil {
		return err
	}
	defer cl.Close()
	return cl.Call(&adjustLightRequest{Cmd: cmd}, &adjustLightResponse{})
}

func callCoreNavCancel(n *goroslib.Node) error {
	cl, err := goroslib.NewServiceClient(goroslib.ServiceClientConf{
		Node: n,
		Name: "/CoreNode/nav_cancel",
		Srv:  &coreNavCancelService{Request: navCancelRequest{}},
	})
	if err != nil {
		return err
	}
	defer cl.Close()
	return cl.Call(&navCancelRequest{}, &navCancelResponse{})
}

func callNavPathCancel(n *goroslib.Node) error {
	cl, err := goroslib.NewServiceClient(goroslib.ServiceClientConf{
		Node: n,
		Name: "/NavPathNode/nav_cancel",
		Srv:  &navPathCancelService{Request: navCancelRequest{}},
	})
	if err != nil {
		return err
	}
	defer cl.Close()
	return cl.Call(&navCancelRequest{}, &navCancelResponse{})
}

func sendJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
