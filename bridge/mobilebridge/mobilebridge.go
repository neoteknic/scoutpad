package mobilebridge

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"moorebot-scout/bridge/robotaudio"

	"github.com/aler9/goroslib"
	"github.com/aler9/goroslib/pkg/msg"
	"github.com/aler9/goroslib/pkg/msgs/geometry_msgs"
	"github.com/aler9/goroslib/pkg/msgs/std_msgs"
)

const listenAddress = "127.0.0.1:18114"

type frameMessage struct {
	msg.Package     `ros:"roller_eye"`
	msg.Definitions `ros:"int8 VIDEO_STREAM_H264=0,int8 VIDEO_STREAM_JPG=1,int8 AUDIO_STREAM_AAC=2"`
	Seq             uint32
	Stamp           uint64
	Session         uint32
	Type            int8
	Oseq            uint32
	Par1            int32
	Par2            int32
	Par3            int32
	Par4            int32
	Data            []uint8
}

type emptyRequest struct{}
type emptyResponse struct{}

type goHomeService struct {
	msg.Package `ros:"/nav_low_bat"`
	Request     emptyRequest
	Response    emptyResponse
}

type coreNavCancelService struct {
	msg.Package `ros:"/CoreNode/nav_cancel"`
	Request     emptyRequest
	Response    emptyResponse
}

type navPathCancelService struct {
	msg.Package `ros:"/NavPathNode/nav_cancel"`
	Request     emptyRequest
	Response    emptyResponse
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

type commandRequest struct {
	RobotIP    string  `json:"robotIp"`
	ROSHost    string  `json:"rosHost"`
	Action     string  `json:"action"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Turn       float64 `json:"turn"`
	Speed      float64 `json:"speed"`
	Simulation bool    `json:"simulation"`
	ClientID   string  `json:"clientId"`
	CommandSeq uint64  `json:"commandSeq"`
	Reconnect  bool    `json:"reconnect"`
	epoch      uint64
}

type controller struct {
	mu                sync.Mutex
	connectMu         sync.Mutex
	writeMu           sync.Mutex
	actionMu          sync.Mutex
	ctx               context.Context
	cancel            context.CancelFunc
	workers           sync.WaitGroup
	node              *goroslib.Node
	pub               *goroslib.Publisher
	forcePub          *goroslib.Publisher
	cancelDetectPub   *goroslib.Publisher
	homeSub           *goroslib.Subscriber
	docking           bool
	sub               *goroslib.Subscriber
	robotIP           string
	localIP           string
	connectedAt       time.Time
	lastAction        string
	lastError         string
	lastFrame         []byte
	lastFrameAt       time.Time
	frameSeq          uint64
	frameWait         chan struct{}
	targetX           float64
	targetY           float64
	targetTurn        float64
	targetAt          time.Time
	active            bool
	motionSeq         uint64
	automaticUntil    time.Time
	forceMotion       bool
	suspended         bool
	sequences         map[string]uint64
	navCancel         context.CancelFunc
	navSeq            uint64
	cameraClients     int
	healthy           bool
	reconnectAt       time.Time
	reconnectAttempts int
	inputEpoch        uint64
	platform          string
	audio             *robotaudio.Player
	audioEncoder      SoundEncoder
	ffmpegPath        string
}

// SoundEncoder lets Android use its built-in AAC encoder without ffmpeg.
type SoundEncoder interface {
	EncodePCM(pcm []byte) ([]byte, error)
}

func SetSoundEncoder(encoder SoundEncoder) {
	appMu.Lock()
	defer appMu.Unlock()
	if appControl != nil {
		appControl.mu.Lock()
		appControl.audioEncoder = encoder
		appControl.mu.Unlock()
	}
}

var (
	appMu        sync.Mutex
	appServer    *http.Server
	appControl   *controller
	appOwners    int
	defaultIP    = "192.168.0.142"
	resolverMu   sync.RWMutex
	resolverIP   = net.ParseIP(defaultIP).To4()
	resolverOnce sync.Once
)

// Start launches the ROS backend used by the Android WebView. It returns an empty string on success.
func Start(robotIP string) string {
	return start(robotIP, "")
}

// StartDesktop serves the same controller and the local UI on Windows.
func StartDesktop(robotIP string, assetsDirectory string) string {
	return start(robotIP, assetsDirectory)
}

func start(robotIP string, assetsDirectory string) string {
	appMu.Lock()
	defer appMu.Unlock()
	if appServer != nil {
		appOwners++
		return ""
	}
	if strings.TrimSpace(robotIP) != "" {
		defaultIP = strings.TrimSpace(robotIP)
	}
	installRobotResolver(defaultIP)
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		return err.Error()
	}
	appControl = newController(defaultIP)
	appControl.platform = "android"
	if assetsDirectory != "" {
		appControl.platform = "windows"
		appControl.ffmpegPath = filepath.Join(filepath.Dir(assetsDirectory), "ffmpeg.exe")
	}
	appOwners = 1
	control := appControl
	control.workers.Add(2)
	go func() { defer control.workers.Done(); control.runPublisher() }()
	go func() { defer control.workers.Done(); control.runHealthMonitor() }()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", appControl.handleStatus)
	mux.HandleFunc("/api/ros/status", appControl.handleROSStatus)
	mux.HandleFunc("/api/ros/connect", appControl.handleConnect)
	mux.HandleFunc("/api/ros/disconnect", appControl.handleDisconnect)
	mux.HandleFunc("/api/ros/camera.mjpg", appControl.handleCamera)
	mux.HandleFunc("/api/command", appControl.handleCommand)
	audioAPI := &robotaudio.Handler{Current: control.currentAudio, Connect: control.connectAudio, Encode: control.encodeAudio}
	audioAPI.Register(mux)
	mux.HandleFunc("/api/video/status", appControl.handleVideoStatus)
	mux.HandleFunc("/api/video/start", appControl.handleVideoUnsupported)
	mux.HandleFunc("/api/video/stop", appControl.handleVideoStop)
	if assetsDirectory != "" {
		files := http.FileServer(http.Dir(assetsDirectory))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			files.ServeHTTP(w, r)
		})
	}

	appServer = &http.Server{Addr: listenAddress, Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	go func(server *http.Server) {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			control.setError(err)
		}
	}(appServer)
	return ""
}

func Stop() {
	appMu.Lock()
	defer appMu.Unlock()
	if appOwners > 1 {
		appOwners--
		return
	}
	appOwners = 0
	if appControl != nil {
		appControl.cancel()
		appControl.close()
	}
	if appServer != nil {
		_ = appServer.Close()
	}
	if appControl != nil {
		appControl.workers.Wait()
	}
	appControl = nil
	appServer = nil
}

func newController(robotIP string) *controller {
	ctx, cancel := context.WithCancel(context.Background())
	return &controller{ctx: ctx, cancel: cancel, robotIP: robotIP,
		frameWait: make(chan struct{}), targetAt: time.Now(), sequences: make(map[string]uint64)}
}

func (c *controller) currentAudio() *robotaudio.Player {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.audio
}

func (c *controller) connectAudio(robotIP string) (*robotaudio.Player, error) {
	if err := c.connect(robotIP); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.suspended || c.audio == nil {
		return nil, fmt.Errorf("application suspendue ou haut-parleur indisponible")
	}
	return c.audio, nil
}

func (c *controller) encodeAudio(ctx context.Context, pcm []byte) ([]byte, error) {
	c.mu.Lock()
	encoder, executable := c.audioEncoder, c.ffmpegPath
	c.mu.Unlock()
	if encoder != nil {
		return encoder.EncodePCM(pcm)
	}
	if executable == "" {
		return nil, fmt.Errorf("encodeur audio indisponible")
	}
	return robotaudio.EncodeFFmpeg(ctx, executable, pcm)
}

// Suspend stops motion independently of WebView timers and queued HTTP requests.
func Suspend(suspended bool) {
	appMu.Lock()
	c := appControl
	appMu.Unlock()
	if c == nil {
		return
	}
	c.mu.Lock()
	if c.audio != nil {
		c.audio.Suspend(suspended)
	}
	c.suspended = suspended
	c.inputEpoch++
	c.motionSeq++
	c.targetX, c.targetY, c.targetTurn = 0, 0, 0
	c.active = false
	c.automaticUntil = time.Time{}
	c.navSeq++
	if c.navCancel != nil {
		c.navCancel()
		c.navCancel = nil
	}
	seq := c.motionSeq
	c.mu.Unlock()
	go func() {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		c.mu.Lock()
		current := c.motionSeq == seq
		c.mu.Unlock()
		if current {
			c.publishLocked(false, 0, 0, 0)
			c.publishLocked(true, 0, 0, 0)
		}
	}()
}

func (c *controller) connect(robotIP string) error {
	c.connectMu.Lock()
	defer c.connectMu.Unlock()
	if c.ctx.Err() != nil {
		return c.ctx.Err()
	}
	robotIP = normalizeRobotIP(robotIP)
	setResolverIP(robotIP)

	c.mu.Lock()
	if c.node != nil && c.robotIP == robotIP && c.healthy {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()
	c.closeROS()

	localIP := chooseLocalIP(robotIP)
	if err := probeMaster(c.ctx, robotIP); err != nil {
		c.setError(err)
		return err
	}
	node, err := goroslib.NewNode(goroslib.NodeConf{
		Name:          "scoutpad_" + strings.ReplaceAll(localIP, ".", "_"),
		MasterAddress: robotIP + ":11311",
		Host:          localIP,
		TcprosPort:    18112,
	})
	if err != nil {
		c.setError(err)
		return err
	}

	pub, err := goroslib.NewPublisher(goroslib.PublisherConf{Node: node, Topic: "/cmd_vel", Msg: &geometry_msgs.Twist{}})
	if err != nil {
		node.Close()
		c.setError(err)
		return err
	}
	forcePub, err := goroslib.NewPublisher(goroslib.PublisherConf{Node: node, Topic: "/cmd_vel_force", Msg: &geometry_msgs.Twist{}})
	if err != nil {
		pub.Close()
		node.Close()
		c.setError(err)
		return err
	}
	sub, err := goroslib.NewSubscriber(goroslib.SubscriberConf{
		Node: node, Topic: "/CoreNode/jpg", Callback: c.onFrame, QueueSize: 1,
	})
	if err != nil {
		forcePub.Close()
		pub.Close()
		node.Close()
		c.setError(err)
		return err
	}
	cancelDetectPub, err := goroslib.NewPublisher(goroslib.PublisherConf{Node: node, Topic: "/AppNode/cancel_detect", Msg: &std_msgs.Int32{}})
	if err != nil {
		sub.Close()
		forcePub.Close()
		pub.Close()
		node.Close()
		return err
	}
	homeSub, err := goroslib.NewSubscriber(goroslib.SubscriberConf{Node: node, Topic: "/CoreNode/going_home_status", Callback: c.onHomeStatus, QueueSize: 16})
	if err != nil {
		cancelDetectPub.Close()
		sub.Close()
		forcePub.Close()
		pub.Close()
		node.Close()
		return err
	}
	audio, err := robotaudio.New(node, "/scoutpad_"+strings.ReplaceAll(localIP, ".", "_"))
	if err != nil {
		homeSub.Close()
		cancelDetectPub.Close()
		sub.Close()
		forcePub.Close()
		pub.Close()
		node.Close()
		return err
	}

	c.mu.Lock()
	c.node = node
	c.pub = pub
	c.forcePub = forcePub
	c.sub = sub
	c.cancelDetectPub = cancelDetectPub
	c.homeSub = homeSub
	c.audio = audio
	audio.Suspend(c.suspended)
	c.robotIP = robotIP
	c.localIP = localIP
	c.connectedAt = time.Now()
	c.lastError = ""
	c.healthy = true
	c.targetAt = time.Now()
	c.mu.Unlock()
	if c.ctx.Err() != nil {
		c.closeROS()
		return c.ctx.Err()
	}
	return nil
}

func (c *controller) close() {
	c.connectMu.Lock()
	defer c.connectMu.Unlock()
	c.closeROS()
}

func (c *controller) closeROS() {
	c.setMotion("stop", 0, 0, 0, true)
	c.mu.Lock()
	sub, forcePub, pub, node := c.sub, c.forcePub, c.pub, c.node
	homeSub, cancelDetectPub := c.homeSub, c.cancelDetectPub
	audio := c.audio
	c.audio = nil
	c.homeSub, c.cancelDetectPub = nil, nil
	c.sub, c.forcePub, c.pub, c.node = nil, nil, nil, nil
	c.active = false
	c.healthy = false
	c.targetX, c.targetY, c.targetTurn = 0, 0, 0
	c.automaticUntil = time.Time{}
	c.motionSeq++
	c.navSeq++
	if c.navCancel != nil {
		c.navCancel()
		c.navCancel = nil
	}
	c.lastFrame = nil
	c.lastFrameAt = time.Time{}
	close(c.frameWait)
	c.frameWait = make(chan struct{})
	c.mu.Unlock()
	if audio != nil {
		audio.Close()
	}
	if homeSub != nil {
		homeSub.Close()
	}
	if cancelDetectPub != nil {
		cancelDetectPub.Close()
	}
	if sub != nil {
		sub.Close()
	}
	if forcePub != nil {
		forcePub.Close()
	}
	if pub != nil {
		pub.Close()
	}
	if node != nil {
		node.Close()
	}
}

func (c *controller) onFrame(frame *frameMessage) {
	if frame == nil || frame.Type != 1 || len(frame.Data) == 0 {
		return
	}
	copyFrame := append([]byte(nil), frame.Data...)
	c.mu.Lock()
	c.lastFrame = copyFrame
	c.lastFrameAt = time.Now()
	c.frameSeq++
	close(c.frameWait)
	c.frameWait = make(chan struct{})
	c.mu.Unlock()
}

func (c *controller) onHomeStatus(status *std_msgs.Int32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch status.Data {
	case 1, 2, 3, 8:
		c.docking = true
	case 4, 5, 6, 7:
		c.docking = false
	}
}

func (c *controller) runPublisher() {
	ticker := time.NewTicker(55 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			c.writeMu.Lock()
			x, y, turn, active := c.currentMotion()
			c.mu.Lock()
			force := c.forceMotion
			c.mu.Unlock()
			if active {
				c.publishLocked(false, x, y, turn)
				if force {
					c.publishLocked(true, x, y, turn)
				}
			}
			c.writeMu.Unlock()
		}
	}
}

func (c *controller) currentMotion() (float64, float64, float64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.suspended || (!c.automaticUntil.IsZero() && !time.Now().Before(c.automaticUntil)) ||
		(c.automaticUntil.IsZero() && time.Since(c.targetAt) > 260*time.Millisecond) {
		if !c.active {
			return 0, 0, 0, false
		}
		c.targetX, c.targetY, c.targetTurn = 0, 0, 0
		c.active = false
		c.automaticUntil = time.Time{}
		c.lastAction = "stop"
		return 0, 0, 0, true
	}
	return c.targetX, c.targetY, c.targetTurn, c.active
}

func (c *controller) setMotion(action string, x, y, turn float64, force bool) uint64 {
	return c.setCommandMotion(nil, action, x, y, turn, force)
}

func (c *controller) setCommandMotion(req *commandRequest, action string, x, y, turn float64, force bool) uint64 {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	if req != nil && !c.commandCurrentLocked(*req) {
		c.mu.Unlock()
		return 0
	}
	if c.suspended {
		x, y, turn = 0, 0, 0
	}
	c.motionSeq++
	seq := c.motionSeq
	c.targetX, c.targetY, c.targetTurn = x, y, turn
	c.targetAt = time.Now()
	c.active = x != 0 || y != 0 || turn != 0
	c.automaticUntil = time.Time{}
	c.forceMotion = force
	c.lastAction = action
	c.mu.Unlock()
	c.publishLocked(false, x, y, turn)
	if force {
		c.publishLocked(true, x, y, turn)
	}
	return seq
}

func (c *controller) setAutomaticMotion(seq uint64, duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.motionSeq == seq && c.active && !c.suspended {
		c.automaticUntil = time.Now().Add(duration)
	}
}

func (c *controller) publish(force bool, x, y, turn float64) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.publishLocked(force, x, y, turn)
}

func (c *controller) publishLocked(force bool, x, y, turn float64) {
	c.mu.Lock()
	pub := c.pub
	if force {
		pub = c.forcePub
	}
	c.mu.Unlock()
	if pub == nil {
		return
	}
	twist := &geometry_msgs.Twist{
		Linear:  geometry_msgs.Vector3{X: x * 0.45, Y: y},
		Angular: geometry_msgs.Vector3{Z: turn * -3.2},
	}
	pub.Write(twist)
}

func (c *controller) cancelNavigation(ctx context.Context) error {
	c.mu.Lock()
	node := c.node
	pub := c.cancelDetectPub
	c.mu.Unlock()
	if node == nil || pub == nil {
		return fmt.Errorf("ROS non connecte")
	}
	return cancelNavigationSequence(ctx, func() {
		pub.Write(&std_msgs.Int32{Data: 1})
	}, c.callEmptyService)
}

// The charger search is a separate thread: nav_cancel alone never clears its flag.
func cancelNavigationSequence(ctx context.Context, signal func(), call func(context.Context, string, interface{}) error) error {
	for i := 0; i < 4; i++ {
		signal()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	var failures []string
	for _, spec := range []struct {
		name string
		srv  interface{}
	}{
		{"/NavPathNode/nav_cancel", &navPathCancelService{}},
		{"/CoreNode/nav_cancel", &coreNavCancelService{}},
	} {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		signal()
		callCtx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
		err := call(callCtx, spec.name, spec.srv)
		cancel()
		if err != nil {
			failures = append(failures, spec.name+": "+err.Error())
		}
	}
	signal()
	if len(failures) != 0 {
		return fmt.Errorf("annulation incomplete: %s", strings.Join(failures, "; "))
	}
	return nil
}

func (c *controller) goHome(ctx context.Context) error {
	return c.callEmptyService(ctx, "/nav_low_bat", &goHomeService{Request: emptyRequest{}})
}

func (c *controller) callEmptyService(ctx context.Context, name string, srv interface{}) error {
	c.mu.Lock()
	node := c.node
	c.mu.Unlock()
	if node == nil {
		return fmt.Errorf("ROS non connecte")
	}
	client, err := goroslib.NewServiceClient(goroslib.ServiceClientConf{Node: node, Name: name, Srv: srv})
	if err == nil {
		err = client.CallContext(ctx, &emptyRequest{}, &emptyResponse{})
		client.Close()
	}
	if err != nil {
		c.setError(err)
	}
	return err
}

func (c *controller) setLight(ctx context.Context, level int32) error {
	c.mu.Lock()
	node := c.node
	c.mu.Unlock()
	if node == nil {
		return fmt.Errorf("ROS non connecte")
	}
	srv := &adjustLightService{Request: adjustLightRequest{Cmd: level}}
	client, err := goroslib.NewServiceClient(goroslib.ServiceClientConf{Node: node, Name: "/CoreNode/adjust_light", Srv: srv})
	if err != nil {
		return err
	}
	defer client.Close()
	return client.CallContext(ctx, &adjustLightRequest{Cmd: level}, &adjustLightResponse{})
}

func (c *controller) handleStatus(w http.ResponseWriter, r *http.Request) {
	ros, bridge := c.statusObjects()
	robotIP := ros["robotHost"].(string)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true, "defaultRobotIp": robotIP, "ffmpegAvailable": false,
		"network": map[string]interface{}{"robotIp": robotIP, "rosMaster": probeROS(robotIP)},
		"ros":     ros, "bridge": bridge, "native": true, "android": c.platform == "android", "platform": c.platform,
	})
}

func (c *controller) handleROSStatus(w http.ResponseWriter, r *http.Request) {
	ros, bridge := c.statusObjects()
	robotIP := ros["robotHost"].(string)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true, "network": map[string]interface{}{"robotIp": robotIP, "rosMaster": probeROS(robotIP)},
		"ros": ros, "bridge": bridge, "native": true, "android": c.platform == "android", "platform": c.platform,
	})
}

func (c *controller) handleConnect(w http.ResponseWriter, r *http.Request) {
	var req commandRequest
	if r.Method != http.MethodPost {
		http.Error(w, "POST requis", http.StatusMethodNotAllowed)
		return
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	robotIP := req.RobotIP
	if robotIP == "" {
		robotIP = hostFromROS(req.ROSHost)
	}
	if req.Reconnect {
		c.setMotion("stop", 0, 0, 0, true)
		c.mu.Lock()
		c.healthy = false
		c.mu.Unlock()
	}
	if err := c.connect(robotIP); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	ros, bridge := c.statusObjects()
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "ros": ros, "bridge": bridge, "cameraUrl": "/api/ros/camera.mjpg"})
}

func (c *controller) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	c.close()
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (c *controller) handleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST requis", http.StatusMethodNotAllowed)
		return
	}
	var req commandRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	if req.Simulation {
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "simulated": true, "protocol": "ros", "responseStatus": 0})
		return
	}
	if !c.acceptCommand(&req) {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"ok": false, "error": "Commande ancienne ou application suspendue"})
		return
	}
	if req.Action == "stop" {
		c.cancelAction()
		c.setCommandMotion(&req, "stop", 0, 0, 0, true)
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "protocol": "ros", "responseStatus": 200})
		return
	}
	if err := c.connect(req.RobotIP); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	if !c.commandCurrent(req) {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"ok": false, "error": "Commande remplacee"})
		return
	}
	action := req.Action
	if action == "" {
		action = "drive"
	}
	var err error
	feedback := ""
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	switch action {
	case "dock":
		operation, release := c.beginAction(ctx)
		defer release()
		c.actionMu.Lock()
		defer c.actionMu.Unlock()
		if operation.Err() != nil || !c.commandCurrent(req) {
			err = context.Canceled
			break
		}
		c.setCommandMotion(&req, "stop", 0, 0, 0, true)
		c.mu.Lock()
		c.docking = true
		c.mu.Unlock()
		err = c.goHome(operation)
		if err == nil {
			feedback = "dock"
		}
	case "undock", "cancelDock":
		operation, release := c.beginAction(ctx)
		defer release()
		c.actionMu.Lock()
		defer c.actionMu.Unlock()
		if operation.Err() != nil || !c.commandCurrent(req) {
			err = context.Canceled
			break
		}
		c.setCommandMotion(&req, "cancelNav", 0, 0, 0, true)
		c.mu.Lock()
		wasDocking := c.docking
		c.mu.Unlock()
		err = c.cancelNavigation(operation)
		if err != nil {
			break
		}
		if operation.Err() != nil || !c.commandCurrent(req) {
			err = context.Canceled
			break
		}
		c.mu.Lock()
		c.docking = false
		c.mu.Unlock()
		if wasDocking || action == "cancelDock" {
			c.setCommandMotion(&req, "stop", 0, 0, 0, true)
			feedback = "cancelDock"
			break
		}
		if operation.Err() != nil || !c.commandCurrent(req) {
			err = context.Canceled
			break
		}
		speed := req.Speed
		if speed < 0.3 {
			speed = 0.3
		}
		seq := c.setCommandMotion(&req, "undock", 0, math.Min(speed, 1), 0, true)
		c.setAutomaticMotion(seq, 1800*time.Millisecond)
	case "stop":
		c.setMotion("stop", 0, 0, 0, true)
	case "lightLow":
		err = c.setLight(ctx, 0)
	case "lightHigh":
		err = c.setLight(ctx, 1)
	case "photo", "recordStart", "recordStop":
		err = fmt.Errorf("action non disponible: %s", action)
	case "drive":
		if c.setCommandMotion(&req, "drive", bounded(req.X), -bounded(req.Y), bounded(req.Turn), false) == 0 {
			err = fmt.Errorf("commande remplacee")
		}
	default:
		err = fmt.Errorf("action inconnue: %s", action)
	}
	if err != nil {
		c.setError(err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{"ok": false, "error": err.Error(), "responseText": err.Error()})
		return
	}
	c.mu.Lock()
	c.lastError = ""
	c.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "simulated": false, "protocol": "ros", "responseStatus": 200, "responseText": c.platform + " " + action, "feedback": feedback})
}

func (c *controller) handleCamera(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	robotIP := c.robotIP
	c.mu.Unlock()
	if err := c.connect(robotIP); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	c.streamCamera(w, r)
}

func (c *controller) streamCamera(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	c.cameraClients++
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.cameraClients--; c.mu.Unlock() }()
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=scoutframe")
	w.Header().Set("Cache-Control", "no-store")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming indisponible", http.StatusInternalServerError)
		return
	}
	var lastSeq uint64
	timer := time.NewTicker(2 * time.Second)
	defer timer.Stop()
	responseControl := http.NewResponseController(w)
	for {
		if c.ctx.Err() != nil {
			return
		}
		c.mu.Lock()
		frame := c.lastFrame
		seq := c.frameSeq
		wait := c.frameWait
		c.mu.Unlock()
		if len(frame) > 0 && seq != lastSeq {
			_ = responseControl.SetWriteDeadline(time.Now().Add(3 * time.Second))
			if _, err := fmt.Fprintf(w, "--scoutframe\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n", len(frame)); err != nil {
				return
			}
			if _, err := w.Write(frame); err != nil {
				return
			}
			if _, err := w.Write([]byte("\r\n")); err != nil {
				return
			}
			flusher.Flush()
			lastSeq = seq
		}
		select {
		case <-c.ctx.Done():
			return
		case <-r.Context().Done():
			return
		case <-wait:
		case <-timer.C:
		}
	}
}

func (c *controller) handleVideoStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "ffmpegAvailable": false, "rtspProxyRunning": false, "hlsReady": false})
}

func (c *controller) handleVideoUnsupported(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]interface{}{"ok": false, "error": "Le flux ROS MJPEG est utilise directement dans l'APK."})
}

func (c *controller) handleVideoStop(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (c *controller) statusObjects() (map[string]interface{}, map[string]interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	connected := c.node != nil && c.healthy
	lastFrameAt := int64(0)
	if !c.lastFrameAt.IsZero() {
		lastFrameAt = c.lastFrameAt.UnixMilli()
	}
	ros := map[string]interface{}{
		"connected": connected, "masterUri": "http://" + c.robotIP + ":11311/", "robotHost": c.robotIP,
		"localHost": c.localIP, "commandTopic": "/cmd_vel", "framePublishers": boolInt(connected),
		"lastFrameAt": lastFrameAt, "lastError": c.lastError,
		"reconnectAttempts": c.reconnectAttempts,
		"docking":           c.docking,
	}
	bridge := map[string]interface{}{
		"running": connected, "url": "http://" + listenAddress, "lastError": c.lastError,
		"status": map[string]interface{}{"ok": connected, "active": c.active, "lastAction": c.lastAction, "suspended": c.suspended},
	}
	return ros, bridge
}

func (c *controller) setError(err error) {
	if err == nil {
		return
	}
	c.mu.Lock()
	c.lastError = err.Error()
	c.mu.Unlock()
}

func bounded(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Max(-1, math.Min(1, value))
}

func (c *controller) acceptCommand(req *commandRequest) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctx.Err() != nil || (c.suspended && req.Action != "stop") {
		return false
	}
	if req.ClientID != "" {
		if req.CommandSeq == 0 || req.CommandSeq <= c.sequences[req.ClientID] {
			return false
		}
		c.sequences[req.ClientID] = req.CommandSeq
	}
	req.epoch = c.inputEpoch
	return true
}

func (c *controller) commandCurrentLocked(req commandRequest) bool {
	return c.ctx.Err() == nil && req.epoch == c.inputEpoch &&
		(!c.suspended || req.Action == "stop") &&
		(req.ClientID == "" || c.sequences[req.ClientID] == req.CommandSeq)
}

func (c *controller) commandCurrent(req commandRequest) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.commandCurrentLocked(req)
}

func (c *controller) cancelAction() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.navSeq++
	if c.navCancel != nil {
		c.navCancel()
		c.navCancel = nil
	}
}

func (c *controller) beginAction(parent context.Context) (context.Context, func()) {
	c.mu.Lock()
	if c.navCancel != nil {
		c.navCancel()
	}
	ctx, cancel := context.WithCancel(parent)
	c.navCancel = cancel
	c.navSeq++
	seq := c.navSeq
	c.mu.Unlock()
	return ctx, func() {
		cancel()
		c.mu.Lock()
		if c.navSeq == seq {
			c.navCancel = nil
		}
		c.mu.Unlock()
	}
}

func probeMaster(ctx context.Context, robotIP string) error {
	dialer := net.Dialer{Timeout: 700 * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(normalizeRobotIP(robotIP), "11311"))
	if err == nil {
		_ = conn.Close()
	}
	return err
}

func (c *controller) runHealthMonitor() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			c.mu.Lock()
			robotIP, connected, suspended := c.robotIP, c.node != nil || !c.connectedAt.IsZero(), c.suspended
			lastImage := c.lastFrameAt
			if lastImage.IsZero() {
				lastImage = c.connectedAt
			}
			stale := c.cameraClients > 0 && time.Since(lastImage) > 8*time.Second
			retryAllowed := !time.Now().Before(c.reconnectAt)
			c.mu.Unlock()
			if !connected || suspended {
				continue
			}
			if err := probeMaster(c.ctx, robotIP); err != nil {
				c.mu.Lock()
				c.healthy = false
				c.mu.Unlock()
				c.cancelAction()
				c.setMotion("stop", 0, 0, 0, true)
				c.setError(err)
				continue
			}
			c.mu.Lock()
			recover := stale || !c.healthy
			if recover && retryAllowed {
				c.healthy = false
				c.reconnectAttempts++
				backoff := time.Duration(math.Min(30, float64(c.reconnectAttempts)*3)) * time.Second
				c.reconnectAt = time.Now().Add(backoff)
			} else if !recover && !c.lastFrameAt.IsZero() && time.Since(c.lastFrameAt) < 3*time.Second {
				c.reconnectAttempts = 0
			}
			c.mu.Unlock()
			if recover && retryAllowed {
				c.setMotion("stop", 0, 0, 0, true)
				if err := c.connect(robotIP); err != nil {
					c.setError(err)
				}
			}
		}
	}
}

func probeROS(robotIP string) map[string]interface{} {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(normalizeRobotIP(robotIP), "11311"), 700*time.Millisecond)
	if err == nil {
		_ = conn.Close()
	}
	result := map[string]interface{}{"ok": err == nil, "latencyMs": time.Since(start).Milliseconds(), "error": ""}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func installRobotResolver(robotIP string) {
	setResolverIP(robotIP)
	resolverOnce.Do(func() {
		go serveRobotDNS()
		net.DefaultResolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "udp", "127.0.0.1:15353")
			},
		}
	})
}

func setResolverIP(robotIP string) {
	ip := net.ParseIP(normalizeRobotIP(robotIP)).To4()
	if ip == nil {
		return
	}
	resolverMu.Lock()
	resolverIP = append(net.IP(nil), ip...)
	resolverMu.Unlock()
}

func serveRobotDNS() {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 15353})
	if err != nil {
		return
	}
	defer conn.Close()
	buffer := make([]byte, 1500)
	for {
		n, remote, readErr := conn.ReadFromUDP(buffer)
		if readErr != nil {
			return
		}
		query := append([]byte(nil), buffer[:n]...)
		response := robotDNSResponse(query)
		if len(response) > 0 {
			_, _ = conn.WriteToUDP(response, remote)
		}
	}
}

func robotDNSResponse(query []byte) []byte {
	if len(query) < 17 {
		return nil
	}
	offset := 12
	for offset < len(query) && query[offset] != 0 {
		labelLength := int(query[offset])
		offset += labelLength + 1
	}
	offset++
	if offset+4 > len(query) {
		return nil
	}
	questionEnd := offset + 4
	queryType := binary.BigEndian.Uint16(query[offset : offset+2])
	hasAnswer := queryType == 1
	response := make([]byte, questionEnd)
	copy(response, query[:questionEnd])
	binary.BigEndian.PutUint16(response[2:4], 0x8180)
	binary.BigEndian.PutUint16(response[4:6], 1)
	if hasAnswer {
		binary.BigEndian.PutUint16(response[6:8], 1)
	} else {
		binary.BigEndian.PutUint16(response[6:8], 0)
	}
	binary.BigEndian.PutUint16(response[8:10], 0)
	binary.BigEndian.PutUint16(response[10:12], 0)
	if !hasAnswer {
		return response
	}

	answer := make([]byte, 16)
	binary.BigEndian.PutUint16(answer[0:2], 0xc00c)
	binary.BigEndian.PutUint16(answer[2:4], 1)
	binary.BigEndian.PutUint16(answer[4:6], 1)
	binary.BigEndian.PutUint32(answer[6:10], 30)
	binary.BigEndian.PutUint16(answer[10:12], 4)
	resolverMu.RLock()
	copy(answer[12:16], resolverIP)
	resolverMu.RUnlock()
	return append(response, answer...)
}

func chooseLocalIP(robotIP string) string {
	prefixParts := strings.Split(robotIP, ".")
	prefix := ""
	if len(prefixParts) >= 3 {
		prefix = strings.Join(prefixParts[:3], ".") + "."
	}
	addrs, _ := net.InterfaceAddrs()
	fallback := "127.0.0.1"
	for _, addr := range addrs {
		ip, _, err := net.ParseCIDR(addr.String())
		if err != nil || ip == nil || ip.IsLoopback() || ip.To4() == nil {
			continue
		}
		fallback = ip.String()
		if prefix != "" && strings.HasPrefix(ip.String(), prefix) {
			return ip.String()
		}
	}
	return fallback
}

func normalizeRobotIP(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultIP
	}
	value = strings.TrimPrefix(value, "http://")
	value = strings.TrimPrefix(value, "https://")
	return strings.Split(value, ":")[0]
}

func hostFromROS(value string) string {
	return normalizeRobotIP(value)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
