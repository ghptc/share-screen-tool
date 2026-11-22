package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

type device struct {
	ID   uint64 `json:"id"`
	Info struct {
		Props map[string]any `json:"props"`
	} `json:"info"`
}

func sinks(data []byte) ([]device, error) {
	var nodes []device
	if err := json.Unmarshal(data, &nodes); err != nil {
		return nil, err
	}
	var result []device
	for _, n := range nodes {
		if n.Info.Props["media.class"] == "Audio/Sink" {
			result = append(result, n)
		}
	}
	return result, nil
}
func target(nodes []device, name string) (string, error) {
	for _, n := range nodes {
		if n.Info.Props["node.name"] == name {
			if serial, ok := n.Info.Props["object.serial"].(float64); ok {
				return fmt.Sprintf("%.0f", serial), nil
			}
		}
	}
	return "", fmt.Errorf("selected output sink is unavailable; run --list again (microphone sources are not accepted)")
}
func apiURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
		return "", errors.New("invalid API URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return "", errors.New("API must use HTTPS or loopback HTTP")
	}
	return strings.TrimRight(raw, "/"), nil
}
