package main

import (
	"errors"
	"testing"

	easybus "github.com/easydev-org/easybus-sdk"
	"github.com/easydev-org/easybus-sdk/extension"

	"github.com/easydev-org/easybus-sdk/manifest"

	"github.com/easydev-org/easyagent-playwright-ext/internal/sidecar"
)

// mapError is the whole of this process's judgement about a sidecar failure, and it decides what the
// MODEL is told. Two properties matter:
//
//   - a mesh of distinct failures must not collapse into one, because the model acts differently on
//     "the context is gone" (create another) and "the browser is broken" (stop trying)
//   - a call error must never be reported as a transport failure, because that reads as "the whole
//     extension is down" for something the caller caused

func TestMapErrorKeepsTheCallerActionableClasses(t *testing.T) {
	for _, tc := range []struct {
		code string
		want easybus.ToolResultErrorCode
	}{
		{"invalid_argument", easybus.ToolResultErrorCodeInvalidArgument},
		{"not_found", easybus.ToolResultErrorCodeNotFound},
		{"permission_denied", easybus.ToolResultErrorCodePermissionDenied},
		{"internal", easybus.ToolResultErrorCodeInternal},
	} {
		t.Run(tc.code, func(t *testing.T) {
			err := mapError(&sidecar.CallError{Code: tc.code, Message: "boom"})
			var typed *extension.TypedError
			if !errors.As(err, &typed) {
				t.Fatalf("err = %v, want *extension.TypedError", err)
			}
			if typed.Code != tc.want {
				t.Errorf("code = %v, want %v", typed.Code, tc.want)
			}
		})
	}
}

func TestMapErrorMarksATransportFailureRetryable(t *testing.T) {
	// A SIDECAR THAT IS DOWN IS RETRYABLE, not internal: the browser may come back, and a model told
	// "internal" would stop trying a tool that would work a second later.
	err := mapError(&sidecar.ServeError{Err: errors.New("connection refused")})
	var typed *extension.TypedError
	if !errors.As(err, &typed) {
		t.Fatalf("err = %v, want *extension.TypedError", err)
	}
	if typed.Code != easybus.ToolResultErrorCodeRetryable {
		t.Errorf("code = %v, want retryable", typed.Code)
	}
}

func TestMapErrorPassesThroughAnUnknownError(t *testing.T) {
	err := mapError(errors.New("something else"))
	var typed *extension.TypedError
	if !errors.As(err, &typed) {
		t.Fatalf("err = %v, want *extension.TypedError", err)
	}
	if typed.Code != easybus.ToolResultErrorCodeInternal {
		t.Errorf("code = %v, want internal", typed.Code)
	}
}

func TestLoadManifestReadsTheShippedFile(t *testing.T) {
	// THE MANIFEST IS READ, NOT EMBEDDED, so this is also the check that the image's MANIFEST_PATH is
	// where the Dockerfile puts it. A missing file must fail loudly at startup rather than leave this
	// process advertising no tools.
	//
	// The default is relative (`manifest.yaml`), which is right for the image — the shell runs with
	// WORKDIR /app beside the file. A test runs from this package's directory, so it points at the
	// repository root explicitly rather than depending on where `go test` was invoked.
	t.Setenv("MANIFEST_PATH", "../../manifest.yaml")

	raw, err := loadManifest()
	if err != nil {
		t.Fatalf("loadManifest: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("manifest is empty")
	}
	// Parsing it is the real assertion: a manifest that reads but does not parse would start a
	// process that answers discovery with nothing.
	m, err := manifest.ParseManifest(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if m.ID != "playwright" {
		t.Errorf("id = %q, want playwright", m.ID)
	}
	if len(m.Tools) == 0 {
		t.Error("manifest declares no tools")
	}
}

func TestLoadManifestReportsAMissingFile(t *testing.T) {
	t.Setenv("MANIFEST_PATH", "/nonexistent/manifest.yaml")
	if _, err := loadManifest(); err == nil {
		t.Fatal("a missing manifest must be an error, not an empty tool list")
	}
}
