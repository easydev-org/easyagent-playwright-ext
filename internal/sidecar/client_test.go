package sidecar

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The client is one half of a seam whose other half is a TypeScript process, so these tests are about
// the CONTRACT rather than about browsers: what crosses, and how a failure is classified.
//
// A FAILURE'S CLASS IS THE POINT. The agent turns it into a tool result the model reads, and the model
// decides what to do next: "create another context" is very different advice from "the browser is
// broken, stop trying". Collapsing the two makes a model retry something that can never work.

func serve(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL)
}

func TestExecSendsTheCallAndReturnsText(t *testing.T) {
	var got execRequest
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/exec" {
			t.Errorf("path = %q, want /exec", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(execResponse{
			OK: true,
			Result: &sidecarResult{
				Content: "navigated",
				Data:    map[string]any{"url": "https://example.com"},
			},
			ContextID: "ctx-1",
		})
	})

	res, err := c.Exec(context.Background(), "t1", "s1", "ctx-1", "browser-navigate",
		map[string]any{"url": "https://example.com"})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.Content != "navigated" {
		t.Errorf("content = %q", res.Content)
	}
	if res.ContextID != "ctx-1" {
		t.Errorf("context id = %q", res.ContextID)
	}
	// THE CONTEXT ID IS SENT SEPARATELY from the args, because the sidecar routes on it: a tool that
	// received it twice could be told two different things.
	if got.ContextID != "ctx-1" || got.Tenant != "t1" || got.Session != "s1" || got.Tool != "browser-navigate" {
		t.Errorf("request = %+v", got)
	}
	if got.Args["url"] != "https://example.com" {
		t.Errorf("args = %+v", got.Args)
	}
}

func TestExecDecodesBytes(t *testing.T) {
	payload := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3}
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(execResponse{
			OK: true,
			Result: &sidecarResult{
				Content: "screenshot saved",
				File: &sidecarFile{
					Name:  "shot.png",
					Bytes: base64.StdEncoding.EncodeToString(payload),
					// EMPTY ON PURPOSE: the agent sniffs the type from the bytes.
					Mime: "",
				},
			},
		})
	})

	res, err := c.Exec(context.Background(), "t", "s", "c", "browser-take-screenshot", nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.File == nil {
		t.Fatal("no file decoded")
	}
	if string(res.File.Bytes) != string(payload) {
		t.Errorf("bytes = %v, want %v", res.File.Bytes, payload)
	}
	if res.File.Name != "shot.png" {
		t.Errorf("name = %q", res.File.Name)
	}
	// A FILE RESULT MUST NOT ALSO CARRY DATA: Go turns the bytes into a file:<code>, and a `data`
	// alongside it would describe a file the model was never given.
	if res.Data != nil {
		t.Errorf("data = %v, want nil for a file result", res.Data)
	}
}

func TestExecClassifiesCallErrors(t *testing.T) {
	for _, tc := range []struct{ wire, want string }{
		{"invalid_argument", "invalid_argument"},
		{"not_found", "not_found"},
		{"permission_denied", "permission_denied"},
		{"internal", "internal"},
		{"", "internal"}, // an empty code is a bug in the sidecar, not a new class
	} {
		t.Run(tc.wire, func(t *testing.T) {
			c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(execResponse{OK: false, Code: tc.wire, Error: "boom"})
			})
			_, err := c.Exec(context.Background(), "t", "s", "c", "tool", nil)
			var call *CallError
			if !errors.As(err, &call) {
				t.Fatalf("err = %v, want *CallError", err)
			}
			if call.Code != tc.want {
				t.Errorf("code = %q, want %q", call.Code, tc.want)
			}
			// A TOOL THAT FAILED IS NOT A TRANSPORT FAILURE. If this were a ServeError the agent
			// would report "the browser is down" for a bad argument.
			var serveErr *ServeError
			if errors.As(err, &serveErr) {
				t.Error("a call error must not be reported as a transport failure")
			}
		})
	}
}

func TestExecReportsTransportFailureAsServeError(t *testing.T) {
	// A server that closes without answering is what a stopped sidecar looks like.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("no hijacker")
		}
		conn, _, err := hijacker.Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
	defer srv.Close()

	_, err := New(srv.URL).Exec(context.Background(), "t", "s", "c", "tool", nil)
	var serveErr *ServeError
	if !errors.As(err, &serveErr) {
		t.Fatalf("err = %v, want *ServeError", err)
	}
}

func TestExecRejectsMalformedResponse(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	})
	_, err := c.Exec(context.Background(), "t", "s", "c", "tool", nil)
	var serveErr *ServeError
	if !errors.As(err, &serveErr) {
		t.Fatalf("err = %v, want *ServeError — a sidecar answering garbage is broken, not the caller", err)
	}
}

func TestExecRejectsCorruptBase64(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(execResponse{
			OK:     true,
			Result: &sidecarResult{File: &sidecarFile{Name: "x.png", Bytes: "!!!not-base64!!!"}},
		})
	})
	_, err := c.Exec(context.Background(), "t", "s", "c", "tool", nil)
	// REPORTED, NOT SILENTLY EMPTY: the alternative is a file:<code> the model is told about that
	// opens to nothing.
	if err == nil || !strings.Contains(err.Error(), "x.png") {
		t.Fatalf("err = %v, want a decode failure naming the file", err)
	}
}

func TestHealth(t *testing.T) {
	ok := serve(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	if err := ok.Health(context.Background()); err != nil {
		t.Errorf("healthy sidecar: %v", err)
	}

	bad := serve(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) })
	if err := bad.Health(context.Background()); err == nil {
		t.Error("503 must report unhealthy")
	}
}

func TestContexts(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		// THE TENANT RIDES THE QUERY STRING because the sidecar has no identity of its own — it cannot
		// read a token and must not be asked to.
		if got := r.URL.Query().Get("tenant"); got != "t1" {
			t.Errorf("tenant = %q, want t1", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contexts": []map[string]any{{"contextId": "c1", "url": "https://x", "alive": true}},
		})
	})
	list, err := c.Contexts(context.Background(), "t1")
	if err != nil {
		t.Fatalf("Contexts: %v", err)
	}
	if len(list) != 1 || list[0].ContextID != "c1" || !list[0].Alive {
		t.Fatalf("contexts = %+v", list)
	}
}
