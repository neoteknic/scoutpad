package main

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestRobotServiceHostname(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	addresses, err := robotResolver(net.ParseIP("192.168.0.142")).LookupIPAddr(ctx, "linaro-alip")
	if err != nil || len(addresses) != 1 || addresses[0].IP.String() != "192.168.0.142" {
		t.Fatalf("robot address: %v, %v", addresses, err)
	}
}

func TestStaleDockIsRejected(t *testing.T) {
	s := &bridgeServer{sequences: map[string]uint64{"pad": 2}}
	if s.commandCurrent(commandRequest{ClientID: "pad", CommandSeq: 1}) {
		t.Fatal("stale B can restart return after A")
	}
	if !s.commandCurrent(commandRequest{ClientID: "pad", CommandSeq: 2}) {
		t.Fatal("current cancellation rejected")
	}
}
