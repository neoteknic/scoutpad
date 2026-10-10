package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/aler9/goroslib"
	"github.com/aler9/goroslib/pkg/msg"
	"github.com/aler9/goroslib/pkg/msgs/geometry_msgs"
	"github.com/aler9/goroslib/pkg/msgs/std_msgs"
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
	ClientID   string  `json:"clientId"`
	CommandSeq uint64  `json:"commandSeq"`
	Action     string  `json:"action"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Turn       float64 `json:"turn"`
	DurationMs int     `json:"durationMs"`
}

type bridgeServer struct {
	node            *goroslib.Node
	pub             *goroslib.Publisher
	forcePub        *goroslib.Publisher
	cancelDetectPub *goroslib.Publisher
	docking         bool
	actionMu        sync.Mutex
	sequences       map[string]uint64
	topic           string
	startedAt       time.Time
	lastAction      string
	lastError       string
	targetX         float64
	targetY         float64
	targetTurn      float64
	targetAt        time.Time
	active          bool
	seq             uint64
	mu              sync.Mutex
	writeMu         sync.Mutex
}

func main() {
	master := flag.String("master", "192.168.0.142:11311", "ROS master host:port")
	host := flag.String("host", "", "local host/IP announced to ROS")
	topic := flag.String("topic", "/cmd_vel", "Twist command topic")
	tcprosPort := flag.Int("tcpros-port", 18112, "local TCPROS port")
	listen := flag.String("listen", "127.0.0.1:18114", "local HTTP listen address")
	flag.Parse()
	robotHost, _, err := net.SplitHostPort(*master)
	if err != nil {
		fail(err)
	}
	if ip := net.ParseIP(robotHost).To4(); ip != nil {
		net.DefaultResolver = robotResolver(ip)
	}

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
	cancelDetectPub, err := goroslib.NewPublisher(goroslib.PublisherConf{Node: n, Topic: "/AppNode/cancel_detect", Msg: &std_msgs.Int32{}})
	if err != nil {
		fail(err)
	}
	defer cancelDetectPub.Close()

	s := &bridgeServer{
		node:            n,
		pub:             pub,
		forcePub:        forcePub,
		cancelDetectPub: cancelDetectPub,
		sequences:       make(map[string]uint64),
		topic:           *topic,
		startedAt:       time.Now(),
		targetAt:        time.Now(),
	}
	homeSub, err := goroslib.NewSubscriber(goroslib.SubscriberConf{Node: n, Topic: "/CoreNode/going_home_status", Callback: func(status *std_msgs.Int32) {
		s.mu.Lock()
		defer s.mu.Unlock()
		switch status.Data {
		case 1, 2, 3, 8:
			s.docking = true
		case 4, 5, 6, 7:
			s.docking = false
		}
	}, QueueSize: 16})
	if err != nil {
		fail(err)
	}
	defer homeSub.Close()
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
	docking := s.docking
	target := map[string]float64{"x": s.targetX, "y": s.targetY, "turn": s.targetTurn}
	s.mu.Unlock()

	sendJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"topic":       s.topic,
		"startedAt":   s.startedAt.Format(time.RFC3339),
		"lastAction":  lastAction,
		"lastError":   lastError,
		"active":      active,
		"docking":     docking,
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
	s.mu.Lock()
	if req.ClientID != "" {
		if req.CommandSeq == 0 || req.CommandSeq <= s.sequences[req.ClientID] {
			s.mu.Unlock()
			sendJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "Commande ancienne"})
			return
		}
		s.sequences[req.ClientID] = req.CommandSeq
	}
	s.mu.Unlock()

	var err error
	feedback := ""
	switch req.Action {
	case "dock":
		s.actionMu.Lock()
		defer s.actionMu.Unlock()
		if !s.commandCurrent(req) {
			err = fmt.Errorf("commande remplacee")
			break
		}
		s.setMotion("stop", 0, 0, 0)
		s.mu.Lock()
		s.docking = true
		s.mu.Unlock()
		err = callGoHome(s.node)
		if err == nil {
			feedback = "dock"
		}
	case "cancelNav", "cancelDock", "undock":
		s.actionMu.Lock()
		defer s.actionMu.Unlock()
		if !s.commandCurrent(req) {
			err = fmt.Errorf("commande remplacee")
			break
		}
		s.mu.Lock()
		wasDocking := s.docking
		s.mu.Unlock()
		s.setForceMotion("stop", 0, 0, 0)
		err = s.cancelNavigation()
		if err == nil && !s.commandCurrent(req) {
			err = fmt.Errorf("commande remplacee")
		}
		if err == nil {
			s.mu.Lock()
			s.docking = false
			s.mu.Unlock()
			if req.Action == "cancelDock" || wasDocking {
				feedback = "cancelDock"
			} else if req.Action == "undock" {
				seq := s.setForceMotion("undock", 0, req.Y, 0)
				time.AfterFunc(1800*time.Millisecond, func() { s.stopIfCurrent(seq) })
			}
		}
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
	sendJSON(w, http.StatusOK, map[string]any{"ok": true, "action": req.Action, "feedback": feedback})
}

func (s *bridgeServer) commandCurrent(req commandRequest) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return req.ClientID == "" || s.sequences[req.ClientID] == req.CommandSeq
}

func (s *bridgeServer) cancelNavigation() error {
	// Stop the separate charger-search thread before cancelling path and alignment.
	for i := 0; i < 4; i++ {
		s.cancelDetectPub.Write(&std_msgs.Int32{Data: 1})
		time.Sleep(100 * time.Millisecond)
	}
	var firstError error
	for _, call := range []func(*goroslib.Node) error{callNavPathCancel, callCoreNavCancel} {
		s.cancelDetectPub.Write(&std_msgs.Int32{Data: 1})
		if err := call(s.node); err != nil {
			if firstError == nil {
				firstError = err
			}
		}
	}
	s.cancelDetectPub.Write(&std_msgs.Int32{Data: 1})
	return firstError
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
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	return cl.CallContext(ctx, &goHomeRequest{}, &goHomeResponse{})
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
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	return cl.CallContext(ctx, &navCancelRequest{}, &navCancelResponse{})
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
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	return cl.CallContext(ctx, &navCancelRequest{}, &navCancelResponse{})
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
