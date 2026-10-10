package robotaudio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

type Handler struct {
	Connect   func(string) (*Player, error)
	Current   func() *Player
	Encode    func(context.Context, []byte) ([]byte, error)
	mu        sync.Mutex
	encodeMu  sync.Mutex
	sequences map[string]uint64
}

func (h *Handler) Register(mux *http.ServeMux) { mux.HandleFunc("/api/soundboard/", h.ServeHTTP) }

func respond(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path == "/api/soundboard/status" && r.Method == http.MethodGet {
		status := Status{State: "idle"}
		if player := h.Current(); player != nil {
			status = player.Status()
		}
		respond(w, 200, map[string]interface{}{"ok": true, "audio": status})
		return
	}
	if r.Method != http.MethodPost {
		respond(w, 405, map[string]interface{}{"ok": false, "error": "POST requis"})
		return
	}
	if path == "/api/soundboard/encode" {
		if !h.encodeMu.TryLock() {
			respond(w, 429, map[string]interface{}{"ok": false, "error": "Un import est deja en cours"})
			return
		}
		defer h.encodeMu.Unlock()
		pcm, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxPCMBytes))
		if err != nil || len(pcm) == 0 || len(pcm)%2 != 0 {
			respond(w, 400, map[string]interface{}{"ok": false, "error": "PCM mono 16 kHz, 30 secondes maximum"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		aac, err := h.Encode(ctx, pcm)
		if err == nil {
			_, err = ParseADTS(aac)
		}
		if err != nil {
			respond(w, 502, map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "audio/aac")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(aac)
		return
	}
	if path != "/api/soundboard/play" && path != "/api/soundboard/stop" {
		respond(w, 404, map[string]interface{}{"ok": false})
		return
	}
	client := r.Header.Get("X-Sound-Client")
	seq, err := strconv.ParseUint(r.Header.Get("X-Sound-Sequence"), 10, 64)
	if err != nil || seq == 0 || len(client) == 0 || len(client) > 128 {
		respond(w, 400, map[string]interface{}{"ok": false, "error": "Identifiant de lecture invalide"})
		return
	}
	h.mu.Lock()
	if h.sequences == nil {
		h.sequences = make(map[string]uint64)
	}
	if seq <= h.sequences[client] {
		h.mu.Unlock()
		respond(w, 409, map[string]interface{}{"ok": false, "error": "Lecture remplacee"})
		return
	}
	h.sequences[client] = seq
	if path == "/api/soundboard/stop" {
		if p := h.Current(); p != nil {
			p.Stop()
		}
		h.mu.Unlock()
		respond(w, 200, map[string]interface{}{"ok": true})
		return
	}
	h.mu.Unlock()
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxAACBytes))
	if err != nil {
		respond(w, 400, map[string]interface{}{"ok": false, "error": "Son trop volumineux"})
		return
	}
	frames, err := ParseADTS(data)
	if err != nil {
		respond(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	if r.URL.Query().Get("simulation") == "true" {
		respond(w, 200, map[string]interface{}{"ok": true, "simulated": true})
		return
	}
	p, err := h.Connect(r.URL.Query().Get("robotIp"))
	if err == nil {
		err = p.WaitReady(r.Context())
	}
	if err != nil {
		respond(w, 502, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sequences[client] != seq || r.Context().Err() != nil {
		respond(w, 409, map[string]interface{}{"ok": false, "error": "Lecture remplacee"})
		return
	}
	name := r.URL.Query().Get("name")
	if len(name) > 160 {
		name = name[:160]
	}
	if err = p.Play(name, frames); err != nil {
		respond(w, 502, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	respond(w, 200, map[string]interface{}{"ok": true, "audio": p.Status()})
}

func EncodeFFmpeg(ctx context.Context, executable string, pcm []byte) ([]byte, error) {
	cmd := exec.CommandContext(ctx, executable, "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "32k", "-f", "adts", "pipe:1")
	hideProcess(cmd)
	cmd.Stdin = bytes.NewReader(pcm)
	var diagnostics bytes.Buffer
	cmd.Stderr = &diagnostics
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("conversion audio indisponible: %v", err)
	}
	return output, nil
}
