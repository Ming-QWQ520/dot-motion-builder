//go:build windows

// Minimal Win32 control panel for the Windows build. The bottom row holds
// exactly two buttons: the left one starts the local server and flips to
// "stop" while it is running; the right one quits. While the server runs,
// the status line doubles as a link — clicking it re-opens the editor.
// Implemented with raw user32/kernel32 syscalls so the binary stays
// dependency-free and keeps cross-compiling with CGO_ENABLED=0.
//
// Build with `-ldflags "-H windowsgui"` to run without a console window.

package main

import (
	"fmt"
	"net"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// ---------------------------------------------------------------------------
// Win32 bindings
// ---------------------------------------------------------------------------

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")

	procGetModuleHandleW     = kernel32.NewProc("GetModuleHandleW")
	procRegisterClassExW     = user32.NewProc("RegisterClassExW")
	procCreateWindowExW      = user32.NewProc("CreateWindowExW")
	procDefWindowProcW       = user32.NewProc("DefWindowProcW")
	procGetMessageW          = user32.NewProc("GetMessageW")
	procTranslateMessage     = user32.NewProc("TranslateMessage")
	procDispatchMessageW     = user32.NewProc("DispatchMessageW")
	procPostQuitMessage      = user32.NewProc("PostQuitMessage")
	procShowWindow           = user32.NewProc("ShowWindow")
	procUpdateWindow         = user32.NewProc("UpdateWindow")
	procSetWindowTextW       = user32.NewProc("SetWindowTextW")
	procGetWindowTextW       = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW = user32.NewProc("GetWindowTextLengthW")
	procSendMessageW         = user32.NewProc("SendMessageW")
	procDestroyWindow        = user32.NewProc("DestroyWindow")
	procEnableWindow         = user32.NewProc("EnableWindow")
	procSetFocus             = user32.NewProc("SetFocus")
	procGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	procSetProcessDPIAware   = user32.NewProc("SetProcessDPIAware")
	procMessageBoxW          = user32.NewProc("MessageBoxW")
	procShellExecuteW        = shell32.NewProc("ShellExecuteW")
	procCreateFontIndirectW  = gdi32.NewProc("CreateFontIndirectW")
	procAdjustWindowRectEx   = user32.NewProc("AdjustWindowRectEx")
)

const (
	className = "DotMotionBuilderPanel"

	idPortEdit   = 101
	idBtnToggle  = 110 // 启动服务 <-> 停止服务
	idBtnExit    = 113
	idStatusLine = 120 // clickable status line (re-opens the editor)

	// Desired client area of the panel window.
	clientWidth  = 420
	clientHeight = 232

	wsOverlappedWindow = 0x00CF0000
	wsVisible          = 0x10000000
	wsChild            = 0x40000000
	wsTabStop          = 0x00010000
	wsBorder           = 0x00800000
	wsClipsiblings     = 0x04000000

	esNumber = 0x2000

	ssNotify      = 0x0001
	ssEditControl = 0x2000

	bsDefPushButton = 0x0001

	wmDestroy = 0x0002
	wmClose   = 0x0010
	wmCommand = 0x0111
	wmSetFont = 0x0030

	bnClicked = 0 // also STN_CLICKED for SS_NOTIFY statics

	swShow = 5

	smCxScreen = 0
	smCyScreen = 1

	mbIconError       = 0x00000010
	mbIconInformation = 0x00000040
	mbOK              = 0x00000000
)

type wndclassex struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type point struct {
	X, Y int32
}

type msg struct {
	Hwnd     uintptr
	Message  uint32
	_        uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       point
	LPrivate uint32
}

type rect struct {
	Left, Top, Right, Bottom int32
}

type logfontw struct {
	Height         int32
	Width          int32
	Escapement     int32
	Orientation    int32
	Weight         int32
	Italic         byte
	Underline      byte
	StrikeOut      byte
	CharSet        byte
	OutPrecision   byte
	ClipPrecision  byte
	Quality        byte
	PitchAndFamily byte
	FaceName       [32]uint16
}

func utf16Ptr(value string) *uint16 {
	pointer, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		return nil
	}
	return pointer
}

func loword(value uintptr) int { return int(value & 0xFFFF) }
func hiword(value uintptr) int { return int((value >> 16) & 0xFFFF) }

// ---------------------------------------------------------------------------
// GUI state
// ---------------------------------------------------------------------------

type guiState struct {
	app         *appServer
	host        string // host part of -addr, editable port joins at runtime
	initialPort int
	noOpen      bool
	quiet       bool

	hwndMain   uintptr
	hwndPort   uintptr
	hwndToggle uintptr
	hwndExit   uintptr
	hwndStatus uintptr
	hFont      uintptr
}

func (g *guiState) status(text string) {
	if g.hwndStatus != 0 {
		procSetWindowTextW.Call(g.hwndStatus, uintptr(unsafe.Pointer(utf16Ptr(text))))
	}
}

func toggleButtonText(running bool) string {
	if running {
		return "停止服务"
	}
	return "启动服务"
}

func (g *guiState) refreshControls() {
	running := g.app.running()
	procSetWindowTextW.Call(g.hwndToggle, uintptr(unsafe.Pointer(utf16Ptr(toggleButtonText(running)))))
	procEnableWindow.Call(g.hwndPort, uintptr(boolTo(!running)))
}

func boolTo(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (g *guiState) portFromEdit() (int, bool) {
	length, _, _ := procGetWindowTextLengthW.Call(g.hwndPort)
	buffer := make([]uint16, length+1)
	procGetWindowTextW.Call(g.hwndPort, uintptr(unsafe.Pointer(&buffer[0])), uintptr(length+1))
	text := strings.TrimSpace(syscall.UTF16ToString(buffer))
	port, err := strconv.Atoi(text)
	if err != nil || port < 1 || port > 65535 {
		procMessageBoxW.Call(
			0,
			uintptr(unsafe.Pointer(utf16Ptr("端口必须是 1-65535 之间的数字。"))),
			uintptr(unsafe.Pointer(utf16Ptr(appName))),
			uintptr(mbOK|mbIconError))
		return 0, false
	}
	return port, true
}

func (g *guiState) toggleServer() {
	if g.app.running() {
		g.stopServer()
		return
	}
	g.startServer()
}

func (g *guiState) startServer() {
	port, ok := g.portFromEdit()
	if !ok {
		return
	}
	addr := net.JoinHostPort(g.host, strconv.Itoa(port))
	url, err := g.app.start(addr, true) // GUI mode always stays quiet
	if err != nil {
		procMessageBoxW.Call(
			0,
			uintptr(unsafe.Pointer(utf16Ptr(fmt.Sprintf("无法监听 %s：%v", addr, err)))),
			uintptr(unsafe.Pointer(utf16Ptr(appName))),
			uintptr(mbOK|mbIconError))
		return
	}
	g.status(fmt.Sprintf("状态：运行中 · %seditor/ · 点击此行可打开编辑器", url))
	g.refreshControls()
	if !g.noOpen {
		go openBrowser(url + "editor/")
	}
}

func (g *guiState) stopServer() {
	if err := g.app.stop(); err != nil {
		g.status(fmt.Sprintf("状态：停止时出现问题（%v）", err))
	} else {
		g.status("状态：已停止（可修改端口后重新启动）")
	}
	g.refreshControls()
}

func (g *guiState) openEditor() {
	url := g.app.currentURL()
	if url == "" {
		procMessageBoxW.Call(
			0,
			uintptr(unsafe.Pointer(utf16Ptr("服务尚未启动，请先点击“启动服务”。"))),
			uintptr(unsafe.Pointer(utf16Ptr(appName))),
			uintptr(mbOK|mbIconInformation))
		return
	}
	go openBrowser(url + "editor/")
}

func (g *guiState) quit() {
	if g.app.running() {
		_ = g.app.stop()
	}
	procDestroyWindow.Call(g.hwndMain)
}

func wndProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	g := guiStateInstance
	if g == nil {
		return defaultWndProc(hwnd, message, wParam, lParam)
	}

	switch message {
	case wmCommand:
		if hiword(wParam) == bnClicked {
			switch loword(wParam) {
			case idBtnToggle:
				g.toggleServer()
				return 0
			case idBtnExit:
				g.quit()
				return 0
			case idStatusLine:
				g.openEditor()
				return 0
			}
		}
	case wmClose:
		g.quit()
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}

	return defaultWndProc(hwnd, message, wParam, lParam)
}

func defaultWndProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}

var wndProcCallback = syscall.NewCallback(wndProc)
var guiStateInstance *guiState

// ---------------------------------------------------------------------------
// Control factory
// ---------------------------------------------------------------------------

var moduleInstance uintptr
var fontHandle uintptr

func createChild(class string, text string, extraStyle uintptr, id int, x, y, w, h int32, parent uintptr) uintptr {
	hwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Ptr(class))),
		uintptr(unsafe.Pointer(utf16Ptr(text))),
		uintptr(wsChild|wsVisible|wsClipsiblings|extraStyle),
		uintptr(x), uintptr(y), uintptr(w), uintptr(h),
		parent,
		uintptr(id),
		moduleInstance,
		0)
	if hwnd != 0 && fontHandle != 0 {
		procSendMessageW.Call(hwnd, wmSetFont, fontHandle, 1)
	}
	return hwnd
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

func runGUI(options guiOptions) {
	runtime.LockOSThread()

	// Best-effort DPI awareness so the panel stays sharp on scaled displays.
	if procSetProcessDPIAware.Find() == nil {
		procSetProcessDPIAware.Call()
	}

	moduleInstance, _, _ = procGetModuleHandleW.Call(0)

	host, _, err := net.SplitHostPort(options.listenAddr)
	if err != nil || host == "" {
		host = "127.0.0.1"
	}
	initialPort := 3000
	if _, portStr, err := net.SplitHostPort(options.listenAddr); err == nil {
		if value, err := strconv.Atoi(portStr); err == nil {
			initialPort = value
		}
	}

	g := &guiState{
		app:         newAppServer(),
		host:        host,
		initialPort: initialPort,
		noOpen:      options.noOpen,
		quiet:       options.quiet,
	}
	guiStateInstance = g

	// UI font: Segoe UI; Chinese glyphs arrive through automatic font linking.
	lf := &logfontw{Height: -15, Weight: 400, CharSet: 1}
	copy(lf.FaceName[:], syscall.StringToUTF16("Segoe UI"))
	fontHandle, _, _ = procCreateFontIndirectW.Call(uintptr(unsafe.Pointer(lf)))

	// Fixed-size window (no thick frame, no maximize box).
	windowStyle := wsOverlappedWindow &^ 0x00050000

	// Convert the desired client area into the outer window size so no
	// control is ever clipped by the non-client frame.
	frame := rect{Left: 0, Top: 0, Right: clientWidth, Bottom: clientHeight}
	procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&frame)), uintptr(windowStyle), 0, 0)
	windowWidth := frame.Right - frame.Left
	windowHeight := frame.Bottom - frame.Top

	screenWidth, _, _ := procGetSystemMetrics.Call(smCxScreen)
	screenHeight, _, _ := procGetSystemMetrics.Call(smCyScreen)
	posX := (int32(screenWidth) - windowWidth) / 2
	posY := (int32(screenHeight) - windowHeight) / 2
	if posX < 0 {
		posX = 0
	}
	if posY < 0 {
		posY = 0
	}

	class := &wndclassex{
		Size:       uint32(unsafe.Sizeof(wndclassex{})),
		WndProc:    wndProcCallback,
		Instance:   moduleInstance,
		Background: 5, // COLOR_WINDOW brush
		ClassName:  utf16Ptr(className),
	}
	atom, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(class)))
	if atom == 0 {
		procMessageBoxW.Call(
			0,
			uintptr(unsafe.Pointer(utf16Ptr("窗口类注册失败，无法启动控制面板。"))),
			uintptr(unsafe.Pointer(utf16Ptr(appName))),
			uintptr(mbOK|mbIconError))
		return
	}

	title := utf16Ptr("Dot Motion Builder · 控制面板")
	hwndMain, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Ptr(className))),
		uintptr(unsafe.Pointer(title)),
		uintptr(windowStyle),
		uintptr(posX), uintptr(posY), uintptr(windowWidth), uintptr(windowHeight),
		0, 0, moduleInstance, 0)
	if hwndMain == 0 {
		return
	}
	g.hwndMain = hwndMain

	boldFont := uintptr(0)
	lfTitle := &logfontw{Height: -19, Weight: 700, CharSet: 1}
	copy(lfTitle.FaceName[:], syscall.StringToUTF16("Segoe UI"))
	boldFont, _, _ = procCreateFontIndirectW.Call(uintptr(unsafe.Pointer(lfTitle)))

	titleLabel := createChild("STATIC", fmt.Sprintf("Dot Motion Builder  v%s", appVersion), 0, 0, 24, 14, 372, 28, hwndMain)
	if titleLabel != 0 && boldFont != 0 {
		procSendMessageW.Call(titleLabel, wmSetFont, boldFont, 1)
	}
	createChild("STATIC", "点阵动画构建器 · 单文件本地版", 0, 0, 24, 44, 372, 20, hwndMain)

	createChild("STATIC", "端口", 0, 0, 24, 79, 40, 24, hwndMain)
	g.hwndPort = createChild("EDIT", strconv.Itoa(g.initialPort), wsTabStop|wsBorder|uintptr(esNumber), idPortEdit, 70, 76, 104, 28, hwndMain)

	g.hwndStatus = createChild("STATIC", "状态：未启动（可先修改端口）", uintptr(ssNotify|ssEditControl), idStatusLine, 24, 112, 372, 40, hwndMain)

	// Bottom row: exactly two buttons — toggle (left) and exit (right).
	g.hwndToggle = createChild("BUTTON", "启动服务", wsTabStop|uintptr(bsDefPushButton), idBtnToggle, 24, 164, 178, 44, hwndMain)
	g.hwndExit = createChild("BUTTON", "退出", wsTabStop, idBtnExit, 218, 164, 178, 44, hwndMain)

	g.refreshControls()
	procSetFocus.Call(g.hwndToggle)

	procShowWindow.Call(hwndMain, swShow)
	procUpdateWindow.Call(hwndMain)

	var message msg
	for {
		result, _, _ := procGetMessageW.Call(
			uintptr(unsafe.Pointer(&message)),
			0, 0, 0)
		if int32(result) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}

	guiStateInstance = nil
}
