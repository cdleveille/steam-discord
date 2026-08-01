package main

import (
	"fmt"
	"os"
	"path/filepath"
)

type config struct {
	DiscordAppID    string
	DiscordBotToken string
	SteamUserID     string
	Home            string
	SteamRoot       string
	PollMs          int
}

var Config config

func initConfig() {
	mustEnv := func(key string) string {
		v := os.Getenv(key)
		if v == "" {
			fmt.Fprintf(os.Stderr, "Missing required %s env var\n", key)
			os.Exit(1)
		}
		return v
	}

	home := os.Getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}

	Config = config{
		DiscordAppID:    mustEnv("DISCORD_APP_ID"),
		DiscordBotToken: mustEnv("DISCORD_BOT_TOKEN"),
		SteamUserID:     mustEnv("STEAM_USER_ID"),
		Home:            home,
		SteamRoot:       detectSteamRoot(home),
		PollMs:          5000,
	}
}

func detectSteamRoot(home string) string {
	candidates := []string{
		filepath.Join(home, ".local/share/Steam"),
		filepath.Join(home, ".steam/steam"),
		filepath.Join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(filepath.Join(p, "steamapps")); err == nil {
			return p
		}
	}
	return candidates[0]
}
