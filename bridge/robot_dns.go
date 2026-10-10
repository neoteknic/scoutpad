package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"

	"golang.org/x/net/dns/dnsmessage"
)

// Scout advertises ROS services as linaro-alip, which is not resolvable on the LAN.
func robotResolver(ip net.IP) *net.Resolver {
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			var length uint16
			if binary.Read(server, binary.BigEndian, &length) != nil {
				return
			}
			query := make([]byte, length)
			if _, err := io.ReadFull(server, query); err != nil {
				return
			}
			var request dnsmessage.Message
			if request.Unpack(query) != nil || len(request.Questions) != 1 {
				return
			}
			question := request.Questions[0]
			response := dnsmessage.Message{Header: dnsmessage.Header{ID: request.ID, Response: true, RecursionAvailable: true}, Questions: request.Questions}
			name := strings.TrimSuffix(strings.ToLower(question.Name.String()), ".")
			if name != "linaro-alip" && !strings.HasPrefix(name, "linaro-alip.") {
				response.RCode = dnsmessage.RCodeNameError
			} else if question.Type == dnsmessage.TypeA {
				var robotIP [4]byte
				copy(robotIP[:], ip.To4())
				response.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 30}, Body: &dnsmessage.AResource{A: robotIP}}}
			}
			packet, err := response.Pack()
			if err != nil {
				return
			}
			if binary.Write(server, binary.BigEndian, uint16(len(packet))) != nil {
				return
			}
			server.Write(packet)
		}()
		return client, nil
	}}
}
