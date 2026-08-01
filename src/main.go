package main

import (
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ── Asset cache ───────────────────────────────────────────────────────────────
// Maps "appID:sha1prefix" → Discord CDN URL / emoji URL.

var (
	assetCachePath = filepath.Join(mustHome(), ".local/share/steamd/asset-cache.json")
	assetCache     = map[string]string{}
)

func mustHome() string {
	h, _ := os.UserHomeDir()
	return h
}

func loadAssetCache() {
	data, err := os.ReadFile(assetCachePath)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &assetCache)
}

func saveAssetCache() {
	if err := os.MkdirAll(filepath.Dir(assetCachePath), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(assetCache)
	if err != nil {
		return
	}
	_ = os.WriteFile(assetCachePath, data, 0o644)
}

func uploadWithCache(appID, filePath string) string {
	fileData, err := os.ReadFile(filePath)
	if err != nil {
		return ""
	}
	h := sha1.Sum(fileData)
	versionSuffix := fmt.Sprintf("%x", h[:4]) // 8 hex chars
	cacheKey := appID + ":" + versionSuffix

	if url, ok := assetCache[cacheKey]; ok {
		return url
	}

	url, err := uploadApplicationAsset(appID, filePath, versionSuffix)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[Discord] asset upload error: %v\n", err)
		return ""
	}
	if url != "" {
		// Evict any stale entries for this appID.
		for k := range assetCache {
			if k == appID || strings.HasPrefix(k, appID+":") {
				delete(assetCache, k)
			}
		}
		assetCache[cacheKey] = url
		saveAssetCache()
	}
	return url
}

func resolveGameImage(appID string, isShortcut bool, shortcutIcon, discordIconURL string) string {
	// 1. VDF icon field / grid folder icon (any game).
	vdfIcon := ""
	if isShortcut {
		vdfIcon = shortcutIcon
	}
	if iconPath := findShortcutIconPath(appID, vdfIcon); iconPath != "" {
		if url := uploadWithCache(appID, iconPath); url != "" {
			return url
		}
	}

	// 2. Steam librarycache - upload locally so SGDBoop replacements take effect.
	if !isShortcut {
		if libPath := findSteamIconPath(appID); libPath != "" {
			if url := uploadWithCache(appID, libPath); url != "" {
				return url
			}
		}
		return discordIconURL
	}

	// 3. Fallback for shortcuts with no icon anywhere.
	if discordIconURL != "" {
		return discordIconURL
	}
	return assetCache[appID]
}

// ── Main loop ─────────────────────────────────────────────────────────────────

func main() {
	initConfig()
	loadAssetCache()

	libraryPaths, err := getLibraryPaths()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to read library paths: %v\n", err)
		os.Exit(1)
	}
	appIDMap := buildAppIDMap(libraryPaths)
	shortcuts := loadShortcuts()
	fmt.Printf("Loaded %d games + %d shortcuts from %d library path(s)\n",
		len(appIDMap), len(shortcuts), len(libraryPaths))

	ipc := &discordIPC{}
	var currentGame *runningGameResult
	var gameStartTime int64

	handleGameChange := func(game *runningGameResult) {
		if game != nil {
			fmt.Printf("[%s] Now playing: %s\n", time.Now().Format(time.RFC3339), game.Name)

			discordGame := findDiscordGame(game.Name)
			discordAppID := Config.DiscordAppID
			if discordGame != nil {
				discordAppID = discordGame.AppID
			}

			if ipc.Connected() && ipc.AppID() != discordAppID {
				ipc.Disconnect()
			}
			if !ipc.Connected() {
				if !ipc.Connect(discordAppID) {
					fmt.Fprintln(os.Stderr, "[Discord] IPC connection failed - is Discord running?")
					return
				}
			}

			sc := shortcuts[game.AppID]
			isShortcut := sc.Name != ""
			discordIconURL := ""
			if discordGame != nil {
				discordIconURL = discordGame.IconURL
			}
			largeImage := resolveGameImage(game.AppID, isShortcut, sc.Icon, discordIconURL)

			gameStartTime = time.Now().UnixMilli()
			ipc.SetActivity(game.Name, gameStartTime, largeImage)
		} else {
			fmt.Printf("[%s] Not playing anything\n", time.Now().Format(time.RFC3339))
			ipc.ClearActivity()
			ipc.Disconnect()
		}
	}

	poll := func() {
		// Fast path: one readFile instead of scanning all of /proc.
		if currentGame != nil {
			if isGameStillRunning(currentGame.PID, currentGame.AppID) {
				if !ipc.Connected() {
					handleGameChange(currentGame)
				}
				return
			}
			// Game exited - clear status immediately without waiting for the slow path.
			currentGame = nil
			handleGameChange(nil)
			return
		}

		// Slow path: full /proc scan.
		result := getRunningGame(appIDMap, shortcuts)
		if result != nil && result.Name == "" {
			// Unknown appID - reload maps and retry once.
			appIDMap = buildAppIDMap(libraryPaths)
			shortcuts = loadShortcuts()
			result = getRunningGame(appIDMap, shortcuts)
		}

		// Reload shortcuts on any game launch to pick up icon changes.
		if result != nil {
			shortcuts = loadShortcuts()
		}

		var game *runningGameResult
		if result != nil && result.Name != "" {
			game = result
		}

		prevID := ""
		if currentGame != nil {
			prevID = currentGame.AppID
		}
		newID := ""
		if game != nil {
			newID = game.AppID
		}

		if newID != prevID {
			currentGame = game
			handleGameChange(game)
		} else if currentGame != nil && !ipc.Connected() {
			handleGameChange(currentGame)
		}
	}

	poll()
	ticker := time.NewTicker(time.Duration(Config.PollMs) * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		poll()
	}
}
