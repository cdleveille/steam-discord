package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ── IPC framing ───────────────────────────────────────────────────────────────

const (
	opHandshake = 0
	opFrame     = 1
	opPing      = 3
	opPong      = 4
)

func ipcEncode(op uint32, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 8+len(body))
	binary.LittleEndian.PutUint32(buf[0:], op)
	binary.LittleEndian.PutUint32(buf[4:], uint32(len(body)))
	copy(buf[8:], body)
	return buf, nil
}

// ── Socket discovery ──────────────────────────────────────────────────────────

func findIPCSocket() string {
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDir == "" {
		runtimeDir = fmt.Sprintf("/run/user/%d", os.Getuid())
	}
	tmpdir := os.Getenv("TMPDIR")
	dirs := []string{
		runtimeDir,
		fmt.Sprintf("/run/user/%d", os.Getuid()),
		filepath.Join(runtimeDir, "app/com.discordapp.Discord"),
		tmpdir,
		"/tmp",
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for i := range 10 {
			p := filepath.Join(dir, fmt.Sprintf("discord-ipc-%d", i))
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

// ── DiscordIPC ────────────────────────────────────────────────────────────────

type discordIPC struct {
	mu    sync.Mutex
	conn  net.Conn
	appID string
	buf   []byte
	ready chan struct{}
}

func (d *discordIPC) Connected() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conn != nil
}

func (d *discordIPC) AppID() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.appID
}

func (d *discordIPC) Connect(appID string) bool {
	path := findIPCSocket()
	if path == "" {
		return false
	}
	conn, err := net.Dial("unix", path)
	if err != nil {
		return false
	}

	ready := make(chan struct{})

	d.mu.Lock()
	d.conn = conn
	d.appID = appID
	d.buf = nil
	d.ready = ready
	d.mu.Unlock()

	msg, err := ipcEncode(opHandshake, map[string]any{"v": 1, "client_id": appID})
	if err != nil {
		d.Disconnect()
		return false
	}
	if _, err := conn.Write(msg); err != nil {
		d.Disconnect()
		return false
	}

	go d.readLoop(conn)

	select {
	case <-ready:
		return true
	case <-time.After(5 * time.Second):
		d.Disconnect()
		return false
	}
}

func (d *discordIPC) readLoop(conn net.Conn) {
	tmp := make([]byte, 4096)
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			d.mu.Lock()
			if d.conn == conn {
				d.conn = nil
			}
			d.mu.Unlock()
			return
		}
		d.mu.Lock()
		d.buf = append(d.buf, tmp[:n]...)
		d.processBuffer(conn)
		d.mu.Unlock()
	}
}

// processBuffer must be called with d.mu held.
func (d *discordIPC) processBuffer(conn net.Conn) {
	for len(d.buf) >= 8 {
		op := binary.LittleEndian.Uint32(d.buf[0:])
		length := binary.LittleEndian.Uint32(d.buf[4:])
		if uint32(len(d.buf)) < 8+length {
			break
		}
		jsonBytes := d.buf[8 : 8+length]
		d.buf = d.buf[8+length:]

		if op == opPing {
			var payload any
			if json.Unmarshal(jsonBytes, &payload) == nil {
				if msg, err := ipcEncode(opPong, payload); err == nil {
					_, _ = conn.Write(msg)
				}
			}
			continue
		}
		if op == opFrame {
			var msg struct {
				Evt string `json:"evt"`
			}
			if json.Unmarshal(jsonBytes, &msg) == nil && msg.Evt == "READY" {
				if d.ready != nil {
					close(d.ready)
					d.ready = nil
				}
			}
		}
	}
}

func (d *discordIPC) send(op uint32, payload any) {
	d.mu.Lock()
	conn := d.conn
	d.mu.Unlock()
	if conn == nil {
		return
	}
	msg, err := ipcEncode(op, payload)
	if err != nil {
		return
	}
	_, _ = conn.Write(msg)
}

func (d *discordIPC) SetActivity(gameName string, startTimestamp int64, largeImage string) {
	cleanName := symbolRe.ReplaceAllString(gameName, "")
	cleanName = strings.TrimSpace(cleanName)

	activity := map[string]any{
		"name":       cleanName,
		"type":       0,
		"timestamps": map[string]any{"start": startTimestamp / 1000},
	}
	if largeImage != "" {
		activity["assets"] = map[string]any{
			"large_image": largeImage,
			"large_text":  cleanName,
		}
	}
	d.send(opFrame, map[string]any{
		"cmd":   "SET_ACTIVITY",
		"args":  map[string]any{"pid": os.Getpid(), "activity": activity},
		"nonce": randomNonce(),
	})
}

func (d *discordIPC) ClearActivity() {
	d.send(opFrame, map[string]any{
		"cmd":   "SET_ACTIVITY",
		"args":  map[string]any{"pid": os.Getpid(), "activity": nil},
		"nonce": randomNonce(),
	})
}

func (d *discordIPC) Disconnect() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.conn != nil {
		d.conn.Close()
		d.conn = nil
	}
	d.buf = nil
	d.appID = ""
	if d.ready != nil {
		close(d.ready)
		d.ready = nil
	}
}

var symbolRe = regexp.MustCompile(`[®™©℠]`)

func randomNonce() string {
	return fmt.Sprintf("%016x", rand.Uint64())
}

// ── ICO / BMP → PNG conversion ────────────────────────────────────────────────

var pngMagic = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}

// extractBestIcoFrame returns the raw PNG bytes of the largest frame in an ICO file.
func extractBestIcoFrame(data []byte) []byte {
	if len(data) < 6 {
		return nil
	}
	count := int(binary.LittleEndian.Uint16(data[4:]))
	if count == 0 {
		return nil
	}

	bestIndex, bestArea := 0, -1
	for i := range count {
		base := 6 + i*16
		if base+16 > len(data) {
			break
		}
		w, h := int(data[base]), int(data[base+1])
		if w == 0 {
			w = 256
		}
		if h == 0 {
			h = 256
		}
		if w*h > bestArea {
			bestArea = w * h
			bestIndex = i
		}
	}

	base := 6 + bestIndex*16
	w, h := int(data[base]), int(data[base+1])
	if w == 0 {
		w = 256
	}
	if h == 0 {
		h = 256
	}
	imgSize := int(binary.LittleEndian.Uint32(data[base+8:]))
	imgOffset := int(binary.LittleEndian.Uint32(data[base+12:]))
	if imgOffset+imgSize > len(data) {
		return nil
	}
	imgData := data[imgOffset : imgOffset+imgSize]

	// Embedded PNG - most common for modern ICO files.
	if len(imgData) >= 8 && bytes.Equal(imgData[:8], pngMagic) {
		return imgData
	}

	// 32-bit BMP DIB - convert to PNG.
	if result := icoFrameBmpToPng(imgData, w, h); result != nil {
		return result
	}

	// Fallback: scan all entries for any embedded PNG.
	for i := range count {
		b := 6 + i*16
		if b+16 > len(data) {
			break
		}
		sz := int(binary.LittleEndian.Uint32(data[b+8:]))
		off := int(binary.LittleEndian.Uint32(data[b+12:]))
		if off+sz > len(data) {
			continue
		}
		candidate := data[off : off+sz]
		if len(candidate) >= 8 && bytes.Equal(candidate[:8], pngMagic) {
			return candidate
		}
	}
	return nil
}

// icoFrameBmpToPng converts a 32-bit BGRA BMP DIB (bottom-up) to a PNG buffer.
func icoFrameBmpToPng(bmpData []byte, width, height int) []byte {
	if len(bmpData) < 40 {
		return nil
	}
	headerSize := int(binary.LittleEndian.Uint32(bmpData[0:]))
	bitCount := binary.LittleEndian.Uint16(bmpData[14:])
	if bitCount != 32 {
		return nil
	}

	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	rowSize := width * 4
	for y := range height {
		srcRow := headerSize + (height-1-y)*rowSize
		for x := range width {
			s := srcRow + x*4
			if s+4 > len(bmpData) {
				break
			}
			img.SetNRGBA(x, y, color.NRGBA{
				R: bmpData[s+2],
				G: bmpData[s+1],
				B: bmpData[s],
				A: bmpData[s+3],
			})
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

// ── Asset upload ──────────────────────────────────────────────────────────────

func uploadApplicationAsset(appID, filePath, versionSuffix string) (string, error) {
	if Config.DiscordBotToken == "" {
		return "", nil
	}

	ext := strings.ToLower(filepath.Ext(filePath))
	if len(ext) > 0 {
		ext = ext[1:] // strip leading dot
	}

	emojiName := "app" + appID
	if versionSuffix != "" {
		emojiName += "_" + versionSuffix
	}
	authHeader := "Bot " + Config.DiscordBotToken
	listURL := fmt.Sprintf("https://discord.com/api/v10/applications/%s/emojis", Config.DiscordAppID)

	// Check for an existing emoji with the same name.
	req, _ := http.NewRequest("GET", listURL, nil)
	req.Header.Set("Authorization", authHeader)
	listResp, err := http.DefaultClient.Do(req)
	if err == nil && listResp.StatusCode == 200 {
		var body struct {
			Items []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"items"`
		}
		if json.NewDecoder(listResp.Body).Decode(&body) == nil {
			for _, item := range body.Items {
				if item.Name == emojiName {
					listResp.Body.Close()
					return fmt.Sprintf("https://cdn.discordapp.com/emojis/%s.png", item.ID), nil
				}
			}
		}
		listResp.Body.Close()
	}

	imageData, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}

	var uploadData []byte
	var mime string
	if ext == "ico" {
		frame := extractBestIcoFrame(imageData)
		if frame == nil {
			return "", fmt.Errorf("no usable frame in ICO file")
		}
		uploadData = frame
		mime = "image/png"
	} else {
		uploadData = imageData
		if ext == "jpg" || ext == "jpeg" {
			mime = "image/jpeg"
		} else {
			mime = "image/png"
		}
	}

	dataURL := fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(uploadData))
	body, _ := json.Marshal(map[string]string{"name": emojiName, "image": dataURL})

	req, _ = http.NewRequest("POST", listURL, bytes.NewReader(body))
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("Content-Type", "application/json")
	uploadResp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer uploadResp.Body.Close()
	if uploadResp.StatusCode != 200 && uploadResp.StatusCode != 201 {
		respBody, _ := io.ReadAll(uploadResp.Body)
		return "", fmt.Errorf("emoji upload failed (%d): %s", uploadResp.StatusCode, respBody)
	}
	var result struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(uploadResp.Body).Decode(&result); err != nil {
		return "", err
	}
	return fmt.Sprintf("https://cdn.discordapp.com/emojis/%s.png", result.ID), nil
}
