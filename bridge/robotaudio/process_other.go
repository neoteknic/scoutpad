//go:build !windows

package robotaudio

import "os/exec"

func hideProcess(cmd *exec.Cmd) {}
