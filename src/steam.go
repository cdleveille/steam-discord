package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ── Text VDF ──────────────────────────────────────────────────────────────────

var vdfPairRe = regexp.MustCompile(`(?m)^\s+"(\w+)"\s+"([^"]*?)"`)

func parseVdfPairs(content string) map[string]string {
	result := map[string]string{}
	for _, m := range vdfPairRe.FindAllStringSubmatch(content, -1) {
		result[strings.ToLower(m[1])] = m[2]
	}
	return result
}

var vdfPathRe = regexp.MustCompile(`"path"\s+"([^"]+)"`)

func getLibraryPaths() ([]string, error) {
	vdfPath := filepath.Join(Config.SteamRoot, "steamapps/libraryfolders.vdf")
	data, err := os.ReadFile(vdfPath)
	if err != nil {
		return nil, err
	}
	content := string(data)
	paths := []string{filepath.Join(Config.SteamRoot, "steamapps")}
	for _, m := range vdfPathRe.FindAllStringSubmatch(content, -1) {
		paths = append(paths, filepath.Join(m[1], "steamapps"))
	}
	return uniqueStrings(paths), nil
}

func buildAppIDMap(libraryPaths []string) map[string]string {
	m := map[string]string{}
	for _, libPath := range libraryPaths {
		entries, err := os.ReadDir(libPath)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if !strings.HasPrefix(name, "appmanifest_") || !strings.HasSuffix(name, ".acf") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(libPath, name))
			if err != nil {
				continue
			}
			vals := parseVdfPairs(string(data))
			if vals["appid"] != "" && vals["name"] != "" {
				m[vals["appid"]] = vals["name"]
			}
		}
	}
	return m
}

// ── Binary shortcuts.vdf ──────────────────────────────────────────────────────

type shortcutInfo struct {
	Name string
	Icon string // may be empty
}

func parseShortcutsVdf(buf []byte) map[string]shortcutInfo {
	pos := 0
	result := map[string]shortcutInfo{}

	readCStr := func() string {
		start := pos
		for pos < len(buf) && buf[pos] != 0 {
			pos++
		}
		s := string(buf[start:pos])
		pos++ // consume null terminator
		return s
	}

	readU32 := func() uint32 {
		if pos+4 > len(buf) {
			return 0
		}
		v := binary.LittleEndian.Uint32(buf[pos:])
		pos += 4
		return v
	}

	var skip func(t byte)
	skip = func(t byte) {
		switch t {
		case 0x01:
			readCStr()
		case 0x02:
			pos += 4
		case 0x00:
			for pos < len(buf) && buf[pos] != 0x08 {
				t2 := buf[pos]
				pos++
				readCStr()
				skip(t2)
			}
			pos++ // consume 0x08
		}
	}

	if pos >= len(buf) || buf[pos] != 0x00 {
		return result
	}
	pos++
	readCStr() // "shortcuts"

	for pos < len(buf) && buf[pos] != 0x08 {
		t := buf[pos]
		pos++
		readCStr() // index "0", "1", …

		if t != 0x00 {
			skip(t)
			continue
		}

		var appID uint32
		var hasAppID bool
		var appName, icon string

		for pos < len(buf) && buf[pos] != 0x08 {
			ft := buf[pos]
			pos++
			field := strings.ToLower(readCStr())
			switch {
			case ft == 0x02 && field == "appid":
				appID = readU32()
				hasAppID = true
			case ft == 0x01 && field == "appname":
				appName = readCStr()
			case ft == 0x01 && field == "icon":
				icon = readCStr()
			default:
				skip(ft)
			}
		}
		pos++ // consume 0x08

		if hasAppID && appName != "" {
			result[fmt.Sprintf("%d", appID)] = shortcutInfo{Name: appName, Icon: icon}
		}
	}
	return result
}

func loadShortcuts() map[string]shortcutInfo {
	if Config.SteamUserID == "" {
		return map[string]shortcutInfo{}
	}
	accountID := steamAccountID(Config.SteamUserID)
	path := filepath.Join(Config.SteamRoot, fmt.Sprintf("userdata/%d/config/shortcuts.vdf", accountID))
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]shortcutInfo{}
	}
	return parseShortcutsVdf(data)
}

// steamAccountID extracts the lower 32 bits of a 64-bit Steam ID string.
func steamAccountID(steamID64 string) uint32 {
	var id uint64
	_, _ = fmt.Sscanf(steamID64, "%d", &id)
	return uint32(id & 0xffffffff)
}

// ── Process detection ─────────────────────────────────────────────────────────

var digitRe = regexp.MustCompile(`^\d+$`)

type runningGameResult struct {
	Name  string // empty = found but unknown
	AppID string
	PID   string
}

func isGameStillRunning(pid, appID string) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%s/environ", pid))
	if err != nil {
		return false
	}
	target := "SteamAppId=" + appID
	for _, v := range strings.Split(string(data), "\x00") {
		if v == target {
			return true
		}
	}
	return false
}

func getRunningGame(appIDMap map[string]string, shortcuts map[string]shortcutInfo) *runningGameResult {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	for _, e := range entries {
		pid := e.Name()
		if !digitRe.MatchString(pid) {
			continue
		}
		data, err := os.ReadFile(fmt.Sprintf("/proc/%s/environ", pid))
		if err != nil {
			continue
		}
		var appID string
		for _, v := range strings.Split(string(data), "\x00") {
			if strings.HasPrefix(v, "SteamAppId=") {
				appID = strings.TrimPrefix(v, "SteamAppId=")
				break
			}
		}
		if appID == "" || appID == "0" {
			continue
		}
		name := appIDMap[appID]
		if name == "" {
			if sc, ok := shortcuts[appID]; ok {
				name = sc.Name
			}
		}
		return &runningGameResult{Name: name, AppID: appID, PID: pid}
	}
	return nil
}

// ── Icon resolution ───────────────────────────────────────────────────────────

var hashJpgRe = regexp.MustCompile(`^[0-9a-f]{40}\.jpg$`)

func findSteamIconPath(appID string) string {
	dir := filepath.Join(Config.SteamRoot, "appcache/librarycache", appID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if hashJpgRe.MatchString(e.Name()) {
			return filepath.Join(dir, e.Name())
		}
	}
	return ""
}

func findShortcutIconPath(appID, vdfIconPath string) string {
	// VDF icon field - exactly what Steam displays in the sidebar.
	if vdfIconPath != "" {
		if _, err := os.Stat(vdfIconPath); err == nil {
			return vdfIconPath
		}
	}
	if Config.SteamUserID == "" {
		return ""
	}
	accountID := steamAccountID(Config.SteamUserID)
	base := filepath.Join(Config.SteamRoot, fmt.Sprintf("userdata/%d/config/grid", accountID))
	for _, ext := range []string{"png", "jpg", "ico"} {
		p := filepath.Join(base, fmt.Sprintf("%s_icon.%s", appID, ext))
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// ── Discord detectable games ──────────────────────────────────────────────────

type detectableGameInfo struct {
	AppID   string `json:"appId"`
	IconURL string `json:"iconUrl"` // may be empty
}

type detectableCache struct {
	Version   int                           `json:"version"`
	Timestamp int64                         `json:"timestamp"`
	Entries   map[string]detectableGameInfo `json:"entries"`
}

const detectableCacheVersion = 2
const detectableTTL = 7 * 24 * time.Hour

var detectableMap map[string]detectableGameInfo // keyed by lowercase name/alias

func loadDetectableMap() map[string]detectableGameInfo {
	if detectableMap != nil {
		return detectableMap
	}

	cachePath := filepath.Join(Config.Home, ".local/share/steamd/detectable-cache.json")

	// Try on-disk cache first.
	if data, err := os.ReadFile(cachePath); err == nil {
		var c detectableCache
		if json.Unmarshal(data, &c) == nil &&
			c.Version == detectableCacheVersion &&
			time.Since(time.UnixMilli(c.Timestamp)) < detectableTTL {
			detectableMap = c.Entries
			return detectableMap
		}
	}

	// Fetch from Discord's public endpoint.
	resp, err := http.Get("https://discord.com/api/v10/applications/detectable")
	if err != nil || resp.StatusCode != 200 {
		fmt.Fprintln(os.Stderr, "[Discord] Could not fetch detectable games list - voice icon may show '?'")
		detectableMap = map[string]detectableGameInfo{}
		return detectableMap
	}
	defer resp.Body.Close()

	var list []struct {
		ID             string   `json:"id"`
		Name           string   `json:"name"`
		IconHash       string   `json:"icon_hash"`
		CoverImageHash string   `json:"cover_image_hash"`
		Aliases        []string `json:"aliases"`
	}
	if json.NewDecoder(resp.Body).Decode(&list) != nil {
		detectableMap = map[string]detectableGameInfo{}
		return detectableMap
	}

	detectableMap = make(map[string]detectableGameInfo, len(list))
	for _, g := range list {
		imageHash := g.CoverImageHash
		if imageHash == "" {
			imageHash = g.IconHash
		}
		info := detectableGameInfo{AppID: g.ID}
		if imageHash != "" {
			info.IconURL = fmt.Sprintf("https://cdn.discordapp.com/app-icons/%s/%s.png?size=512", g.ID, imageHash)
		}
		detectableMap[strings.ToLower(g.Name)] = info
		for _, alias := range g.Aliases {
			detectableMap[strings.ToLower(alias)] = info
		}
	}

	// Persist cache.
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err == nil {
		c := detectableCache{
			Version:   detectableCacheVersion,
			Timestamp: time.Now().UnixMilli(),
			Entries:   detectableMap,
		}
		if data, err := json.Marshal(c); err == nil {
			_ = os.WriteFile(cachePath, data, 0o644)
		}
	}
	return detectableMap
}

func findDiscordGame(gameName string) *detectableGameInfo {
	m := loadDetectableMap()
	if info, ok := m[strings.ToLower(gameName)]; ok {
		return &info
	}
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
