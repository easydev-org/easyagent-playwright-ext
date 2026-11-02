// Package sidecar is the client for the local Playwright sidecar process.
//
// THE SEAM: a TypeScript process owns the browser — Playwright's page object, the accessibility
// snapshot, the locator engine — because none of that can be expressed in Go without reimplementing
// it. This package owns the other half: it sends a tool name and its arguments over localhost HTTP
// and gets a result back.
//
// WHY ONE ENDPOINT AND NOT ONE PER TOOL. A per-tool RPC would describe each tool's semantics twice —
// once in TypeScript and once here — which is the duplication this split exists to remove. Go sends
// "browser-click with these arguments"; the sidecar decides what that means. Go's jobs are the things
// the sidecar cannot do: speak the bus, hold the manifest, enforce permissions, and store bytes.
package sidecar

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to the sidecar over its one endpoint.
type Client struct {
	base string
	http *http.Client
}

// New returns a client for the sidecar at base (e.g. "http://127.0.0.1:9222").
func New(base string) *Client {
	return &Client{
		base: base,
		http: &http.Client{
			// NO TIMEOUT HERE. The bound belongs to the tool call, which the agent already applies
			// per-call (ToolTimeout). A second, shorter timeout in this client would fire first and
			// report "sidecar did not answer" for a slow but healthy browser operation.
			Timeout: 0,
		},
	}
}

// File is bytes a tool produced.
//
// IT CROSSES AS BASE64 because JSON is the only channel this seam has, and it is decoded here rather
// than in the caller so exactly one place knows the encoding.
type File struct {
	Name  string
	Bytes []byte
	Mime  string
}

// Result is one tool call's outcome.
type Result struct {
	// Content is the natural-language text the model reads.
	Content string
	// Data is the structured value the console renders (absent when the tool produced a File).
	Data any
	// File is set when the tool produced bytes.
	File *File
	// ContextID is the context the call ran against; for browser-create-context it is the new one.
	ContextID string
}

// CallError is a failure the CALLER can act on, distinguished from this process being broken.
type CallError struct {
	Code    string // invalid_argument | not_found | permission_denied | internal
	Message string
}

func (e *CallError) Error() string { return e.Message }

// ServeError means the sidecar is unreachable — a different situation from a tool that failed, and
// one the caller should report as "the browser process is down" rather than "your call was wrong".
type ServeError struct{ Err error }

func (e *ServeError) Error() string { return "playwright sidecar: " + e.Err.Error() }
func (e *ServeError) Unwrap() error { return e.Err }

// ExecRequest is the wire shape of one call.
type execRequest struct {
	Tool      string         `json:"tool"`
	ContextID string         `json:"context_id,omitempty"`
	Tenant    string         `json:"tenant"`
	Session   string         `json:"session"`
	Args      map[string]any `json:"args,omitempty"`
}

type sidecarFile struct {
	Name  string `json:"name"`
	Bytes string `json:"bytes"`
	Mime  string `json:"mime"`
}

type sidecarResult struct {
	Content string       `json:"content"`
	Data    any          `json:"data,omitempty"`
	File    *sidecarFile `json:"file,omitempty"`
}

type execResponse struct {
	OK        bool           `json:"ok"`
	Result    *sidecarResult `json:"result,omitempty"`
	ContextID string         `json:"context_id,omitempty"`
	Error     string         `json:"error,omitempty"`
	Code      string         `json:"code,omitempty"`
}

// Exec runs one tool.
func (c *Client) Exec(ctx context.Context, tenant, session, contextID, tool string, args map[string]any) (Result, error) {
	body, err := json.Marshal(execRequest{
		Tool: tool, ContextID: contextID, Tenant: tenant, Session: session, Args: args,
	})
	if err != nil {
		return Result{}, fmt.Errorf("encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/exec", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("content-type", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		// A TRANSPORT FAILURE IS "THE SIDECAR IS DOWN", which is not the caller's fault and must not
		// be reported as a tool error the model would try to work around.
		return Result{}, &ServeError{Err: err}
	}
	defer func() { _ = res.Body.Close() }()

	// Bounded: a sidecar that answers with a runaway body should fail this call, not this process.
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return Result{}, &ServeError{Err: err}
	}

	var out execResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return Result{}, &ServeError{Err: fmt.Errorf("malformed response (HTTP %d): %w", res.StatusCode, err)}
	}
	if !out.OK {
		code := out.Code
		if code == "" {
			code = "internal"
		}
		return Result{}, &CallError{Code: code, Message: out.Error}
	}

	r := Result{Content: "", ContextID: out.ContextID}
	if out.Result != nil {
		r.Content = out.Result.Content
		r.Data = out.Result.Data
		if out.Result.File != nil {
			decoded, derr := base64.StdEncoding.DecodeString(out.Result.File.Bytes)
			if derr != nil {
				// A CORRUPT PAYLOAD IS REPORTED, not silently dropped: the alternative is a
				// `file:<code>` the model is told about and that opens to nothing.
				return Result{}, &ServeError{Err: fmt.Errorf("decode %s: %w", out.Result.File.Name, derr)}
			}
			r.File = &File{Name: out.Result.File.Name, Bytes: decoded, Mime: out.Result.File.Mime}
		}
	}
	return r, nil
}

// Health reports whether the sidecar process answers.
//
// IT TOUCHES NO BROWSER, so a wedged Chrome still reads as healthy — deliberately: the question a
// readiness probe asks is "can this pod serve", and a browser that will not start is discovered by
// the first tool call, with a message about the browser.
func (c *Client) Health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/healthz", nil)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return &ServeError{Err: err}
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return &ServeError{Err: fmt.Errorf("healthz: HTTP %d", res.StatusCode)}
	}
	return nil
}

// Context is one live browser context, as the panel lists it.
type Context struct {
	ContextID  string `json:"contextId"`
	Session    string `json:"session"`
	URL        string `json:"url"`
	Title      string `json:"title"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt int64  `json:"lastUsedAt"`
	Busy       bool   `json:"busy"`
	Alive      bool   `json:"alive"`
}

// Contexts lists one tenant's live contexts.
func (c *Client) Contexts(ctx context.Context, tenant string) ([]Context, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/contexts?tenant="+tenant, nil)
	if err != nil {
		return nil, err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, &ServeError{Err: err}
	}
	defer func() { _ = res.Body.Close() }()
	var out struct {
		Contexts []Context `json:"contexts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, &ServeError{Err: err}
	}
	return out.Contexts, nil
}
