package robotaudio

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aler9/goroslib"
	"github.com/aler9/goroslib/pkg/msg"
	"github.com/aler9/goroslib/pkg/msgs/std_msgs"
)

const MaxPCMBytes = 16000 * 2 * 30
const MaxAACBytes = 256 * 1024
const frameDuration = 64 * time.Millisecond

type frame struct {
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

// ParseADTS rejects anything the Scout's fixed 16 kHz mono decoder cannot accept.
func ParseADTS(data []byte) ([][]byte, error) {
	if len(data) == 0 || len(data) > MaxAACBytes {
		return nil, fmt.Errorf("son vide ou trop volumineux")
	}
	var frames [][]byte
	for offset := 0; offset < len(data); {
		b := data[offset:]
		if len(b) < 7 || b[0] != 0xff || b[1]&0xf6 != 0xf0 {
			return nil, fmt.Errorf("fichier AAC ADTS invalide")
		}
		length := int(b[3]&3)<<11 | int(b[4])<<3 | int(b[5]>>5)
		header := 7
		if b[1]&1 == 0 {
			header = 9
		}
		channels := int(b[2]&1)<<2 | int(b[3]>>6)
		if b[2]>>6 != 1 || (b[2]>>2)&15 != 8 || channels != 1 || b[6]&3 != 0 {
			return nil, fmt.Errorf("AAC-LC mono 16000 Hz requis")
		}
		if length <= header || length > 1024 || length > len(b) {
			return nil, fmt.Errorf("trame AAC invalide ou trop grande pour le robot")
		}
		frames = append(frames, append([]byte(nil), b[:length]...))
		if len(frames) > 485 {
			return nil, fmt.Errorf("son limite a 30 secondes")
		}
		offset += length
	}
	return frames, nil
}

type Status struct {
	Playing  bool    `json:"playing"`
	State    string  `json:"state"`
	Name     string  `json:"name"`
	Position float64 `json:"position"`
	Duration float64 `json:"duration"`
}

type Player struct {
	mu              sync.Mutex
	workers         sync.WaitGroup
	cancel          context.CancelFunc
	seq             uint64
	closed          bool
	suspended       bool
	status          Status
	commandKnown    bool
	lastCommand     int32
	commandReadyAt  time.Time
	command         func(int32)
	frame           func(uint32, []byte)
	closePublishers func()
	connected       func() (bool, error)
}

func New(node *goroslib.Node, nodeName string) (*Player, error) {
	cmd, err := goroslib.NewPublisher(goroslib.PublisherConf{Node: node, Topic: "/speaker_cmd", Msg: &std_msgs.Int32{}})
	if err != nil {
		return nil, err
	}
	audio, err := goroslib.NewPublisher(goroslib.PublisherConf{Node: node, Topic: "/net_audio_frame", Msg: &frame{}})
	if err != nil {
		cmd.Close()
		return nil, err
	}
	return &Player{status: Status{State: "idle"},
		command: func(value int32) { cmd.Write(&std_msgs.Int32{Data: value}) },
		frame: func(seq uint32, data []byte) {
			audio.Write(&frame{Seq: seq, Stamp: uint64(time.Now().UnixMicro()), Type: 2, Par1: 16000, Par2: 16, Par3: 1, Data: data})
		},
		closePublishers: func() { audio.Close(); cmd.Close() },
		connected: func() (bool, error) {
			connections, err := node.NodeGetConns(nodeName)
			if err != nil {
				return false, err
			}
			var commandReady, audioReady bool
			for _, connection := range connections {
				if connection.Connected && connection.Direction == 'o' {
					commandReady = commandReady || connection.Topic == "/speaker_cmd"
					audioReady = audioReady || connection.Topic == "/net_audio_frame"
				}
			}
			return commandReady && audioReady, nil
		},
	}, nil
}

func (p *Player) WaitReady(ctx context.Context) error {
	if p.connected == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		if ctx.Err() != nil {
			return fmt.Errorf("haut-parleur inaccessible : verifier le reseau et le pare-feu ROS")
		}
		ok, err := p.connected()
		if err != nil {
			return fmt.Errorf("connexion haut-parleur : %v", err)
		}
		if ok {
			return nil
		}
		if !wait(ctx, 150*time.Millisecond) {
			return fmt.Errorf("haut-parleur inaccessible : verifier le reseau et le pare-feu ROS")
		}
	}
}

func (p *Player) Play(name string, frames [][]byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.suspended {
		return fmt.Errorf("haut-parleur deconnecte ou application suspendue")
	}
	if p.cancel != nil {
		p.cancel()
	}
	p.seq++
	seq := p.seq
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.status = Status{Playing: true, State: "starting", Name: name, Duration: float64(len(frames)) * 0.064}
	p.workers.Add(1)
	go p.run(ctx, seq, frames)
	return nil
}

func wait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// SpeakerNode sleeps in each command callback. Space commands globally, even
// across replaced playbacks, so rapid button presses cannot fill its queue.
func (p *Player) sendCommand(value int32) {
	if p.commandKnown && p.lastCommand == value {
		return
	}
	p.command(value)
	p.commandKnown = true
	p.lastCommand = value
	ready := time.Now()
	if p.commandReadyAt.After(ready) {
		ready = p.commandReadyAt
	}
	p.commandReadyAt = ready.Add(1100 * time.Millisecond)
}

func (p *Player) prepare(ctx context.Context, seq uint64, value int32) bool {
	for {
		p.mu.Lock()
		if seq != p.seq || p.closed {
			p.mu.Unlock()
			return false
		}
		delay := time.Until(p.commandReadyAt)
		if delay <= 0 {
			p.sendCommand(value)
			delay = time.Until(p.commandReadyAt)
			p.mu.Unlock()
			return wait(ctx, delay)
		}
		p.mu.Unlock()
		if !wait(ctx, delay) {
			return false
		}
	}
}

func (p *Player) run(ctx context.Context, seq uint64, frames [][]byte) {
	defer p.workers.Done()
	defer func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if seq == p.seq && !p.closed {
			p.sendCommand(1)
			p.status = Status{State: "idle"}
			p.cancel = nil
		}
	}()
	// Stop flushes the robot's tiny AAC queue. Both robot commands sleep for 1 s.
	for _, command := range []int32{1, 0} {
		if !p.prepare(ctx, seq, command) {
			return
		}
	}
	for index, data := range frames {
		p.mu.Lock()
		if seq != p.seq || p.closed {
			p.mu.Unlock()
			return
		}
		p.status.State = "playing"
		p.status.Position = float64(index) * 0.064
		p.frame(uint32(index), data)
		p.mu.Unlock()
		// Never burst delayed frames into the five-frame queue.
		if !wait(ctx, frameDuration) {
			return
		}
	}
	wait(ctx, 300*time.Millisecond)
}

func (p *Player) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq++
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
		p.sendCommand(1)
	}
	p.status = Status{State: "idle"}
}

func (p *Player) Status() Status { p.mu.Lock(); defer p.mu.Unlock(); return p.status }

func (p *Player) Suspend(value bool) {
	p.mu.Lock()
	p.suspended = value
	if value {
		p.seq++
		if p.cancel != nil {
			p.cancel()
			p.cancel = nil
			p.sendCommand(1)
		}
		p.status = Status{State: "idle"}
	}
	p.mu.Unlock()
}

func (p *Player) Close() {
	p.mu.Lock()
	p.closed = true
	p.seq++
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
		p.sendCommand(1)
	}
	p.status = Status{State: "idle"}
	p.mu.Unlock()
	p.workers.Wait()
	p.closePublishers()
}
