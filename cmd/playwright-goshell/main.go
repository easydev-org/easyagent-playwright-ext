// Command playwright-goshell is the easybus half of the playwright extension.
//
// WHAT IS HERE: the NATS connection, the manifest, tool registration, permissions, config, lifecycle,
// and the blob backend. WHAT IS NOT HERE: the browser. A TypeScript sidecar beside it owns Playwright.
//
// WHY THE SPLIT FALLS HERE — the seam has to be drawn somewhere that does not leak, and there are
// exactly two things that would:
//
//  1. `page` CANNOT CROSS. `browser-run-code-unsafe` hands the caller a live Playwright page object.
//     No RPC carries that, so the CODE runs in the sidecar and only the RESULT crosses.
//  2. BYTES NEED THE AGENT'S BLOB STORE. A screenshot must become the same durable `file:<code>` a
//     generated image does, and only this process has the bus to ingest it. So bytes arrive base64
//     from the sidecar and are stored here.
//
// THE ALTERNATIVE WAS TWO IMPLEMENTATIONS OF THE PROTOCOL. Before this, the TypeScript SDK
// re-implemented subjects, KV keys, envelope rules and discovery that the Go SDK already had — and
// they drifted: this extension sat six versions behind on the wire while its own tools kept working.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"time"

	easybus "github.com/easydev-org/easybus-sdk"
	"github.com/easydev-org/easybus-sdk/bus"
	"github.com/easydev-org/easybus-sdk/extension"
	"github.com/easydev-org/easybus-sdk/manifest"
	"github.com/easydev-org/easybus-sdk/transport/nats"

	"github.com/easydev-org/easyagent-playwright-ext/internal/sidecar"
)

// manifestYAML is the SAME manifest the sidecar's tool list comes from. One file, so the tools this
// process advertises and the tools that process implements cannot disagree.
//
// READ AT STARTUP RATHER THAN go:embed-ED, because the manifest lives at the repository root where the
// sidecar's tool list reads it too. Embedding would require a second copy inside this package, and a
// second copy is how the sandbox extension ended up with two manifests that had to be kept in step by
// hand.
//
// MANIFEST_PATH can point anywhere; the default is the repository layout, and the image sets it.
func loadManifest() ([]byte, error) {
	path := envOr("MANIFEST_PATH", "manifest.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read manifest %q: %w", path, err)
	}
	return raw, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// Ingest stores bytes through the agent's file RPC and returns its `file:<code>`.
//
// THROUGH THE AGENT, NOT DIRECTLY: this process has no blob credentials and should not get any. The
// agent owns the blob backend (S3 or memory), so a screenshot lands wherever a generated image would,
// and a deployment that changes its blob backend changes it for both.
type fileIngester struct{ bus bus.Bus }

func (f *fileIngester) Put(ctx context.Context, tenant, session, name string, data []byte) (string, error) {
	code, _, err := extension.IngestFileViaAgent(ctx, f.bus, tenant, name, data, session)
	return code, err
}

func main() {
	log := slog.Default().With("svc", "playwright-ext")

	// NO NATS IS A HARD FAILURE, unlike the agent (which degrades to in-memory tools). An extension
	// with no bus cannot be discovered, so starting would only report Ready while nothing works.
	bus, err := nats.Connect(envOr("NATS_URL", "nats://127.0.0.1:4222"))
	if err != nil {
		log.Error("nats connect failed", "err", err)
		os.Exit(1)
	}

	manifestRaw, err := loadManifest()
	if err != nil {
		log.Error("manifest unavailable", "err", err)
		os.Exit(1)
	}
	m, err := manifest.ParseManifest(manifestRaw)
	if err != nil {
		log.Error("load manifest failed", "err", err)
		os.Exit(1)
	}

	sc := sidecar.New(envOr("SIDECAR_URL", "http://127.0.0.1:9222"))

	ing := &fileIngester{bus: bus}

	// ONE HANDLER PER TOOL, ALL THE SAME SHAPE. The sidecar decides what each does; this side
	// contributes the context id, the tenant and the session — the three things the sidecar cannot
	// know because it has no identity of its own.
	// The SDK binds an inline function per tool; there is no named handler type to key on.
	handlers := make(map[string]extension.ToolSpec, len(m.Tools))
	for _, t := range m.Tools {
		name := t.Name
		handlers[name] = extension.ToolSpec{
			// THE EFFECT RIDES WITH THE DECLARATION the loop is already reading: this file has no second
			// table of tool metadata, and the manifest is the one the agent validates.
			Effect: t.Effect,
			Execute: func(ctx context.Context, args map[string]any, callID, session, tenant string) (extension.ToolResultData, error) {
				// The context id rides as an ARGUMENT in the manifest, and the sidecar wants it as its
				// own field: one tool family is addressed by it, and passing it twice would let the two
				// disagree.
				contextID, _ := args["context_id"].(string)
				delete(args, "context_id")

				res, err := sc.Exec(ctx, tenant, session, contextID, name, args)
				if err != nil {
					return extension.ToolResultData{}, mapError(err)
				}

				// BYTES BECOME A file:<code> HERE, because this is the only side of the seam with a bus.
				if res.File != nil {
					code, perr := ing.Put(ctx, tenant, session, res.File.Name, res.File.Bytes)
					if perr != nil {
						return extension.ToolResultData{}, &extension.TypedError{
							Code:    easybus.ToolResultErrorCodeInternal,
							Message: "store " + res.File.Name + ": " + perr.Error(),
						}
					}
					return extension.ToolResultData{
						Content: res.Content + "\nfile:" + code,
						Data:    map[string]any{"file": "file:" + code, "mime": res.File.Mime, "name": res.File.Name},
					}, nil
				}
				return extension.ToolResultData{Content: res.Content, Data: res.Data}, nil
			}}
	}

	cfg := m.BuildConfig(manifest.Bindings{
		Handlers: handlers,
		OnLifecycle: func(ctx context.Context, ev *easybus.LifecycleEvent, tenant string) error {
			// A deleted session must not leave browser contexts holding Grid slots, and only this
			// process can tell the sidecar which session is gone.
			if easybus.LifecycleKindString(ev.Kind) == "deleted" {
				if _, err := sc.Exec(ctx, tenant, ev.SessionName, "", "browser-close-context",
					map[string]any{"all": true}); err != nil {
					log.Warn("close contexts on delete", "tenant", tenant, "session", ev.SessionName, "err", err)
				}
			}
			return nil
		},
	})
	ext := extension.New(bus, cfg)

	if err := extension.Serve(ext, extension.ServeOptions{
		// NO UI SPEC. The panel is easyagent-ext-ui-host's to serve; this binary is a backend.
		Handler: uiMux(sc, bus, envOr("SIDECAR_URL", "http://127.0.0.1:9222")),
		Run: func(ctx context.Context, _ *extension.Extension) {
			log.Info("serving", "nats", envOr("NATS_URL", ""), "sidecar", envOr("SIDECAR_URL", ""))
		},
	}); err != nil {
		log.Error("serve failed", "err", err)
		os.Exit(1)
	}
}

// mapError turns a sidecar failure into the protocol error the agent expects.
//
// THE DISTINCTION MATTERS TO THE MODEL: `not_found` (the context was reaped — create another) is
// actionable, while `internal` ("the browser process is broken") is not, and collapsing them makes a
// model retry something that will never work.
func mapError(err error) error {
	var call *sidecar.CallError
	if errors.As(err, &call) {
		code := easybus.ToolResultErrorCodeInternal
		switch call.Code {
		case "invalid_argument":
			code = easybus.ToolResultErrorCodeInvalidArgument
		case "not_found":
			code = easybus.ToolResultErrorCodeNotFound
		case "permission_denied":
			code = easybus.ToolResultErrorCodePermissionDenied
		}
		return &extension.TypedError{Code: code, Message: call.Message}
	}
	var serve *sidecar.ServeError
	if errors.As(err, &serve) {
		return &extension.TypedError{
			Code:    easybus.ToolResultErrorCodeRetryable,
			Message: "the browser process is not answering: " + serve.Err.Error(),
		}
	}
	return &extension.TypedError{Code: easybus.ToolResultErrorCodeInternal, Message: err.Error()}
}

// uiMux serves the panel's data API and the health probes.
//
// THE PATHS ARE ABSOLUTE (`/ext/playwright/api/...`) because a different process forwards exactly
// those here — nothing strips a prefix.
func uiMux(sc *sidecar.Client, b bus.Bus, sidecarBase string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		// THE SIDECAR IS PART OF THIS PROCESS'S HEALTH. Reporting ok while the browser half is down
		// would keep a broken pod in the Service and send every call into a connection error.
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := sc.Health(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": "playwright"})
	})

	mux.HandleFunc("/ext/playwright/api/v1/contexts", func(w http.ResponseWriter, r *http.Request) {
		tenant := r.URL.Query().Get("tenant")
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		list, err := sc.Contexts(ctx, tenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"contexts": list})
	})

	/**
	 * THE REST OF THE PANEL'S API IS A PASS-THROUGH.
	 *
	 * The panel's Connect service lives in the sidecar — it needs the live contexts, which only that
	 * process has — and it is reachable only on loopback. So the pod's published port forwards it,
	 * which is also what keeps the panel SAME-ORIGIN with the console: the browser talks to one origin
	 * and never learns that two processes are behind it.
	 *
	 * A plain ReverseProxy rather than hand-rolled copying: it handles streaming, trailers and the
	 * header rules that a Connect server relies on, and reimplementing those is how a proxy works for
	 * unary calls and hangs on streams.
	 */
	sidecarURL, _ := url.Parse(sidecarBase)
	mux.Handle("/ext/playwright/api/", httputil.NewSingleHostReverseProxy(sidecarURL))

	/**
	 * `/file` IS THE ONE DIRECTION THE SIDECAR CANNOT DO ALONE.
	 *
	 * `browser-file-upload` and `browser-drop` are given a `file:<code>` and must put its bytes into
	 * the page. Only this process has the bus to fetch them, so the sidecar calls back here.
	 *
	 * IT IS BOUND TO THE POD, NOT PUBLISHED: the Service exposes 8080, and this handler is reachable
	 * only from the sibling container on loopback. That is why it can take a tenant from a query
	 * parameter — there is no untrusted caller to spoof it.
	 */
	mux.HandleFunc("/file", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		tenant := r.URL.Query().Get("tenant")
		if code == "" || tenant == "" {
			http.Error(w, "code and tenant are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		meta, data, err := extension.GetFileViaAgent(ctx, b, tenant, code)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"bytes": base64.StdEncoding.EncodeToString(data),
			"name":  meta.Name,
			"mime":  meta.Mime,
		})
	})
	return mux
}
