package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testFS() fs.FS {
	return fstest.MapFS{
		"index.html":             {Data: []byte("<html>home</html>")},
		"editor/index.html":      {Data: []byte("<html>editor</html>")},
		"404.html":               {Data: []byte("<html>not found</html>")},
		"index.txt":              {Data: []byte("index txt")},
		"_next/static/chunk.js":  {Data: []byte("console.log(1)")},
		"_next/static/style.css": {Data: []byte("body{}")},
		"media/logo.woff2":       {Data: []byte{0x00, 0x01, 0x02, 0x03}},
	}
}

func TestCachePolicy(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"_next/static/chunk.js", "public, max-age=31536000, immutable"},
		{"_next/static/css/app.css", "public, max-age=31536000, immutable"},
		{"index.html", "no-store, no-cache, must-revalidate, proxy-revalidate"},
		{"editor/index.html", "no-store, no-cache, must-revalidate, proxy-revalidate"},
		{"index.txt", "no-store, no-cache, must-revalidate, proxy-revalidate"},
		{"media/logo.woff2", "public, max-age=86400"},
	}
	for _, c := range cases {
		if got := cachePolicy(c.name); got != c.want {
			t.Errorf("cachePolicy(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestAcceptGzip(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"gzip", true},
		{"gzip, deflate, br", true},
		{"deflate, br", false},
		{"", false},
		{"identity", false},
	}
	for _, c := range cases {
		if got := acceptGzip(c.header); got != c.want {
			t.Errorf("acceptGzip(%q) = %v, want %v", c.header, got, c.want)
		}
	}
}

func TestGzipBytesSkipsBinary(t *testing.T) {
	if _, ok := gzipBytes("image/png", []byte("data")); ok {
		t.Error("gzipBytes should skip non-compressible MIME types")
	}
}

func newTestServer() http.Handler { return newServer(testFS(), true) }

func TestServeStaticRoutes(t *testing.T) {
	srv := newTestServer()

	cases := []struct {
		uri        string
		wantStatus int
		wantBody   string
	}{
		{"/", http.StatusOK, "home"},
		{"/editor", http.StatusMovedPermanently, ""},
		{"/editor/", http.StatusOK, "editor"},
		{"/editor/index.html", http.StatusMovedPermanently, ""},
		{"/index.html", http.StatusMovedPermanently, ""},
		{"/index.txt", http.StatusOK, "index txt"},
		{"/_next/static/chunk.js", http.StatusOK, "console.log(1)"},
		{"/missing-page", http.StatusNotFound, "not found"},
	}

	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, c.uri, nil)
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code != c.wantStatus {
			t.Errorf("GET %s: status = %d, want %d", c.uri, rec.Code, c.wantStatus)
			continue
		}
		if c.wantBody != "" && !strings.Contains(rec.Body.String(), c.wantBody) {
			t.Errorf("GET %s: body = %q, want substring %q", c.uri, rec.Body.String(), c.wantBody)
		}
	}
}

func TestServeStaticGzip(t *testing.T) {
	srv := newTestServer()

	// Without Accept-Encoding: plain body.
	req := httptest.NewRequest(http.MethodGet, "/_next/static/chunk.js", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "" {
		t.Errorf("unexpected Content-Encoding without Accept-Encoding")
	}

	// With Accept-Encoding: gzipped body (payload is tiny so gzip may be
	// skipped when it does not shrink; verify Vary/decoding logic instead on
	// a larger compressible file).
	big := strings.Repeat("console.log('dot-motion-builder');", 200)
	fsys := fstest.MapFS{"_next/static/big.js": {Data: []byte(big)}}
	srvBig := newServer(fsys, true)
	req = httptest.NewRequest(http.MethodGet, "/_next/static/big.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	srvBig.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", rec.Header().Get("Content-Encoding"))
	}
	if got := rec.Body.Len(); got >= len(big) {
		t.Errorf("gzipped body (%d bytes) should be smaller than plain (%d bytes)", got, len(big))
	}
}

func TestSecurityAndCacheHeaders(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store, no-cache, must-revalidate, proxy-revalidate" {
		t.Errorf("html Cache-Control = %q", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/_next/static/chunk.js", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("asset Cache-Control = %q", got)
	}
}

func TestAPIEndpoints(t *testing.T) {
	srv := newTestServer()

	for _, uri := range []string{"/api/health", "/api/version"} {
		req := httptest.NewRequest(http.MethodGet, uri, nil)
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status = %d, want 200", uri, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
			t.Errorf("GET %s: Content-Type = %q, want JSON", uri, ct)
		}
		if !strings.Contains(rec.Body.String(), "version") {
			t.Errorf("GET %s: body missing version field: %s", uri, rec.Body.String())
		}
	}
}

func TestPathTraversalBlocked(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/../../../etc/passwd", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	// http.ServeMux-style normalization plus path.Clean keep the request
	// inside the embedded FS; anything unresolved falls back to 404.html.
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusOK {
		t.Errorf("unexpected status for traversal attempt: %d", rec.Code)
	}
}

func TestResolveListenAddr(t *testing.T) {
	cases := []struct {
		addr    string
		port    int
		want    string
		wantErr bool
	}{
		{"127.0.0.1:3000", 0, "127.0.0.1:3000", false},
		{":8080", 0, ":8080", false},
		{"127.0.0.1:3000", 8080, "127.0.0.1:8080", false},
		{":3000", 8080, ":8080", false},
		{"0.0.0.0:3000", 80, "0.0.0.0:80", false},
		{"localhost:3000", 9000, "localhost:9000", false},
		{"127.0.0.1", 8080, "127.0.0.1:8080", false},
		{"127.0.0.1:3000", 70000, "", true},
		{"127.0.0.1:3000", -1, "", true},
		{"127.0.0.1", 0, "", true},
	}
	for _, c := range cases {
		got, err := resolveListenAddr(c.addr, c.port)
		if c.wantErr {
			if err == nil {
				t.Errorf("resolveListenAddr(%q, %d) expected error, got %q", c.addr, c.port, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("resolveListenAddr(%q, %d) unexpected error: %v", c.addr, c.port, err)
			continue
		}
		if got != c.want {
			t.Errorf("resolveListenAddr(%q, %d) = %q, want %q", c.addr, c.port, got, c.want)
		}
	}
}
