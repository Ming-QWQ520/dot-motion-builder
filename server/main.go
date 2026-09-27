// Command dot-motion-builder serves the Dot Motion Builder web editor from a
// single self-contained binary. The compiled Next.js static export is embedded
// into the executable at build time via //go:embed, so the binary has no
// runtime dependency on any external asset, Node.js, or the file system.
//
// Build (see scripts/build-binary.sh):
//
//	pnpm build                       # emits ./out (Next.js static export)
//	rsync -a out/ server/frontend/   # stage assets for embedding
//	cd server && go build .
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// frontend holds the complete Next.js static export.
//
// The "all:" prefix is required: Next.js emits hashed assets under "_next/",
// and go:embed skips files or directories whose names begin with "_" or "."
// unless the "all:" prefix is used.
//
//go:embed all:frontend
var frontend embed.FS

// appVersion is overridden at build time with:
//
//	-ldflags "-X main.appVersion=1.2.3"
var appVersion = "0.1.0"

// appName is used in logs, banners, and the version API.
const appName = "dot-motion-builder"

// startedAt records process start time for uptime reporting.
var startedAt = time.Now()

func main() {
	log.SetFlags(0)

	addr := flag.String("addr", "127.0.0.1:3000", "listen address, e.g. 127.0.0.1:3000 or :8080")
	port := flag.Int("port", 0, "override the port of -addr, e.g. -port=8080 (1-65535)")
	noOpen := flag.Bool("no-open", false, "do not open the browser on start")
	quiet := flag.Bool("quiet", false, "suppress per-request access logs")
	noGUI := flag.Bool("nogui", false, "Windows only: skip the control panel window and run in the console")
	showVer := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVer {
		fmt.Printf("%s %s (%s)\n", appName, appVersion, runtime.Version())
		return
	}

	listenAddr, err := resolveListenAddr(*addr, *port)
	if err != nil {
		log.Fatalf("[%s] %v", appName, err)
	}

	// Windows builds show a tiny control panel (start / stop / exit) unless
	// -nogui is given; every other platform runs the classic console flow.
	if runtime.GOOS == "windows" && !*noGUI {
		runGUI(guiOptions{
			listenAddr: listenAddr,
			noOpen:     *noOpen,
			quiet:      *quiet,
		})
		return
	}

	runConsole(listenAddr, *noOpen, *quiet)
}

// guiOptions carries the flag resolution into the Windows control panel.
type guiOptions struct {
	listenAddr string
	noOpen     bool
	quiet      bool
}

// runConsole is the classic terminal flow: serve until Ctrl+C / SIGTERM.
func runConsole(listenAddr string, noOpen, quiet bool) {
	app := newAppServer()

	url, err := app.start(listenAddr, quiet)
	if err != nil {
		log.Fatalf("[%s] failed to listen on %s: %v", appName, listenAddr, err)
	}

	printBanner(url)

	if !noOpen {
		if err := openBrowser(url + "editor/"); err != nil {
			log.Printf("[%s] could not open browser automatically: %v", appName, err)
		}
	}

	// Graceful shutdown on Ctrl+C / SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-app.errors():
		log.Fatalf("[%s] server error: %v", appName, err)
	case <-ctx.Done():
		log.Printf("\n[%s] shutting down...", appName)
		if err := app.stop(); err != nil {
			log.Printf("[%s] forced shutdown: %v", appName, err)
		}
		log.Printf("[%s] bye.", appName)
	}
}

// ---------------------------------------------------------------------------
// Shared server lifecycle (console + GUI)
// ---------------------------------------------------------------------------

// appServer owns the HTTP server so the console flow and the Windows control
// panel can start and stop the exact same server on demand.
type appServer struct {
	mu       sync.Mutex
	httpSrv  *http.Server
	listener net.Listener
	url      string
	errCh    chan error
}

func newAppServer() *appServer {
	return &appServer{errCh: make(chan error, 1)}
}

func (s *appServer) start(addr string, quiet bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.httpSrv != nil {
		return s.url, nil
	}

	httpSrv := &http.Server{
		Handler:           newServer(frontendRoot(), quiet),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}

	s.httpSrv = httpSrv
	s.listener = listener
	s.url = browserURL(listener)

	go func() {
		if err := httpSrv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case s.errCh <- err:
			default:
			}
		}
	}()

	return s.url, nil
}

func (s *appServer) stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.httpSrv == nil {
		return nil
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := s.httpSrv.Shutdown(shutdownCtx)
	s.httpSrv = nil
	s.listener = nil
	s.url = ""
	return err
}

func (s *appServer) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.httpSrv != nil
}

func (s *appServer) currentURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.url
}

func (s *appServer) errors() <-chan error {
	return s.errCh
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// server serves the embedded static export plus a small JSON API.
type server struct {
	fsys  fs.FS // rooted at the embedded frontend directory
	quiet bool
}

func newServer(fsys fs.FS, quiet bool) http.Handler {
	return &server{fsys: fsys, quiet: quiet}
}

// frontendRoot returns the embedded FS re-rooted at "frontend/".
func frontendRoot() fs.FS {
	sub, err := fs.Sub(frontend, "frontend")
	if err != nil {
		log.Fatalf("[%s] embedded frontend missing: %v (run scripts/build-binary.sh)", appName, err)
	}
	return sub
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.quiet {
		log.Printf("%s %s %s", r.Method, r.URL.RequestURI(), r.RemoteAddr)
	}

	// Security headers applied to every response.
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "SAMEORIGIN")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")

	// Tiny JSON API.
	switch r.URL.Path {
	case "/api/health":
		writeJSON(w, r, http.StatusOK, map[string]any{
			"status":  "ok",
			"version": appVersion,
			"uptime":  time.Since(startedAt).Round(time.Second).String(),
		})
		return
	case "/api/version":
		writeJSON(w, r, http.StatusOK, map[string]any{
			"app":     appName,
			"version": appVersion,
			"go":      runtime.Version(),
		})
		return
	}

	s.serveStatic(w, r)
}

// serveStatic resolves a request path inside the embedded export and serves
// the matching file with appropriate cache headers, gzip compression, and
// 404.html fallback rendering.
func (s *server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/") // guards against "../" traversal

	// "/" maps to the root document.
	if name == "" || name == "." {
		s.serveFile(w, r, "index.html", http.StatusOK)
		return
	}
	// Canonicalize "/index.html" and "/editor/index.html" to their clean URLs
	// so relative asset references keep resolving.
	if name == "index.html" || name == "editor/index.html" {
		localRedirect(w, r, "./")
		return
	}

	// Exact file match (top-level files such as "index.txt", "404.html").
	if isFile(s.fsys, name) {
		s.serveFile(w, r, name, http.StatusOK)
		return
	}

	// Directory match: "/editor" → "/editor/" redirect, then "editor/index.html".
	if isDir(s.fsys, name) {
		if !strings.HasSuffix(r.URL.Path, "/") {
			localRedirect(w, r, path.Base(r.URL.Path)+"/")
			return
		}
		if isFile(s.fsys, path.Join(name, "index.html")) {
			s.serveFile(w, r, path.Join(name, "index.html"), http.StatusOK)
			return
		}
	}

	// Unknown path: render the export's own 404 page.
	if isFile(s.fsys, "404.html") {
		s.serveFile(w, r, "404.html", http.StatusNotFound)
		return
	}
	http.NotFound(w, r)
}

// serveFile writes one embedded file. HTML documents are never cached so a
// re-shipped binary immediately replaces stale markup, while content-hashed
// assets under _next/static/ are marked immutable.
func (s *server) serveFile(w http.ResponseWriter, r *http.Request, name string, status int) {
	data, err := fs.ReadFile(s.fsys, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	ctype := contentType(name, data)
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", cachePolicy(name))

	body := data
	if acceptGzip(r.Header.Get("Accept-Encoding")) && len(data) >= 512 {
		if gz, ok := gzipBytes(ctype, data); ok {
			body = gz
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
		}
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))

	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}

// cachePolicy replicates the original deployment intent: editor markup is
// always revalidated, hashed build assets are immutable for a year.
func cachePolicy(name string) string {
	switch {
	case strings.HasPrefix(name, "_next/static/"):
		return "public, max-age=31536000, immutable"
	case strings.HasPrefix(name, "_next/"):
		return "public, max-age=0, must-revalidate"
	}
	switch path.Ext(name) {
	case ".html", ".txt", "":
		return "no-store, no-cache, must-revalidate, proxy-revalidate"
	default:
		// Fonts, images, and other stable public assets.
		return "public, max-age=86400"
	}
}

// contentType resolves the MIME type from the extension, falling back to
// sniffing the leading bytes like net/http does.
func contentType(name string, data []byte) string {
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		return ct
	}
	if len(data) > 0 {
		return http.DetectContentType(data[:min(len(data), 512)])
	}
	return "application/octet-stream"
}

// acceptGzip reports whether the client advertised gzip support.
func acceptGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.TrimSpace(strings.SplitN(part, ";", 2)[0]) == "gzip" {
			return true
		}
	}
	return false
}

// gzipBytes compresses compressible payloads (text, SVG, fonts, JSON) at the
// default level; binary formats with poor ratios are skipped.
func gzipBytes(ctype string, data []byte) ([]byte, bool) {
	mt, _, _ := mime.ParseMediaType(ctype)
	switch {
	case strings.HasPrefix(mt, "text/"),
		mt == "application/javascript",
		mt == "application/json",
		mt == "image/svg+xml",
		strings.HasPrefix(mt, "font/"),
		strings.HasSuffix(mt, "+json"):
	default:
		return nil, false
	}

	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		return nil, false
	}
	if err := zw.Close(); err != nil {
		return nil, false
	}
	gz := buf.Bytes()
	// Only ship compression when it actually helps.
	if len(gz) >= len(data) {
		return nil, false
	}
	return gz, true
}

// localRedirect issues a 301 redirect to a path relative to the current one,
// mirroring net/http's directory redirect behaviour.
func localRedirect(w http.ResponseWriter, r *http.Request, newPath string) {
	if q := r.URL.RawQuery; q != "" {
		newPath += "?" + q
	}
	w.Header().Set("Location", newPath)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusMovedPermanently)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if acceptGzip(r.Header.Get("Accept-Encoding")) {
		if gz, ok := gzipBytes("application/json", body); ok {
			body = gz
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
		}
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

func isFile(fsys fs.FS, name string) bool {
	st, err := fs.Stat(fsys, name)
	return err == nil && !st.IsDir()
}

func isDir(fsys fs.FS, name string) bool {
	st, err := fs.Stat(fsys, name)
	return err == nil && st.IsDir()
}

// ---------------------------------------------------------------------------
// Startup helpers
// ---------------------------------------------------------------------------

// resolveListenAddr combines the -addr host with the -port override. A zero
// port keeps the address untouched; a non-zero port replaces the address
// port (or supplies one when -addr carries none).
func resolveListenAddr(addr string, port int) (string, error) {
	if port == 0 {
		if _, _, err := net.SplitHostPort(addr); err != nil {
			return "", fmt.Errorf("invalid -addr %q: use host:port", addr)
		}
		return addr, nil
	}
	if port < 1 || port > 65535 {
		return "", fmt.Errorf("invalid -port %d: must be 1-65535", port)
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		// -addr without a port part: reuse it verbatim as the host.
		host = strings.TrimSuffix(strings.TrimSuffix(addr, ":"), "/")
		if host == "" {
			host = "127.0.0.1"
		}
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

// browserURL converts the listener address into a URL a browser can open.
func browserURL(ln net.Listener) string {
	addr := ln.Addr().String()
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr + "/"
	}
	if host == "" || host == "::" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%s/", host, port)
}

// openBrowser launches the system browser cross-platform; failures are
// non-fatal because the URL is always printed to the console.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		if _, err := exec.LookPath("x-www-browser"); err == nil {
			cmd = exec.Command("x-www-browser", url)
		} else {
			cmd = exec.Command("xdg-open", url)
		}
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reap the launcher process without blocking startup.
	go func() { _ = cmd.Wait() }()
	return nil
}

func printBanner(url string) {
	sep := strings.Repeat("-", 50)
	log.Printf("%s", sep)
	log.Printf("  Dot Motion Builder  %s", appVersion)
	log.Printf("  Home:    %s", url)
	log.Printf("  Editor:  %seditor/", url)
	log.Printf("  Health:  %sapi/health", url)
	log.Printf("  Press Ctrl+C to stop.")
	log.Printf("%s", sep)
}
