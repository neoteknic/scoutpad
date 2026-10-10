package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"moorebot-scout/mobilebridge"
)

func main() {
	robotIP := flag.String("robot", "192.168.0.142", "Robot IP")
	assets := flag.String("assets", "public", "Local UI directory")
	flag.Parse()
	absoluteAssets, err := filepath.Abs(*assets)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if _, err = os.Stat(filepath.Join(absoluteAssets, "index.html")); err != nil {
		fmt.Fprintln(os.Stderr, "Interface introuvable:", err)
		os.Exit(1)
	}
	if message := mobilebridge.StartDesktop(*robotIP, absoluteAssets); message != "" {
		fmt.Fprintln(os.Stderr, message)
		os.Exit(1)
	}
	fmt.Println("ScoutPad ready: http://127.0.0.1:18114/")
	defer mobilebridge.Stop()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	defer signal.Stop(stop)
	inputClosed := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			if scanner.Text() == "stop" {
				break
			}
		}
		close(inputClosed)
	}()
	select {
	case <-stop:
	case <-inputClosed:
	}
}
