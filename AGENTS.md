# AGENTS.md — easyagent-playwright-ext

Working notes for agents editing this repo.

This extension drives a **remote** browser over CDP. It does not ship a browser: it dials out to a
Selenium/standalone-chrome base URL (or a raw CDP endpoint) that the deployment already runs.

**End-to-end testing follows the shared convention in
[`easybus-sdk/E2E.md`](https://github.com/easydev-org/easybus-sdk/blob/main/E2E.md).** Read that
first; this file only records what is specific to this repo.

---

## The two suites

| job | services | proves |
|---|---|---|
| `test` (matrix 22/24/26) | none | types, build, unit tests |
| `e2e` | nats + **selenium/standalone-chrome** | a real browser navigates, and a screenshot's bytes reach the object store |

## What the live suite needs, and why

```yaml
# .github/ci/compose.yaml
chrome:
  image: selenium/standalone-chrome:4.27
  ports: ["4444:4444"]     # published: the extension runs on the RUNNER
  shm_size: 2gb
```

No S3/garage: a screenshot goes through the **transient** object bucket, which is NATS by design
(in-flight hand-off, 24h TTL). Persistent bytes require S3, but nothing here writes one — and adding
a bucket would test the SDK's S3 adapter, not this extension.

## How the browser tools are driven

They are **permission-gated**, so `callTool` (which sends no grants) fails with
`permission denied: browser.read (no grant held)`. The suite uses `callToolWithGrants` with what an
operator would issue. That method was added to the SDK *because* this suite could not otherwise call
a gated tool at all.

Every browser tool also declares `required_config: [selenium-url]`, so the suite writes that into
the `cfg` KV before the first call. Without it every call is refused before the browser is touched.

## Traps in this repo specifically

### `file.ingest` is answered by the agent, so the test answers it

`ingestFile` puts the screenshot in the transient object store and then **asks the agent** to
persist it. With no agent that request has no responder:

```
no responders: easybus.<tenant>.file.ingest
```

`tests/fake-agent.ts` answers it — and **reads the object the extension actually wrote**, sniffing
the media type from those bytes. A canned reply would let a broken capture pass.

### `browser-create-context` takes NO arguments

Its `input_schema.properties` is empty; the page is loaded by `browser-navigate` afterwards. Passing
`initial_url` is silently ignored, and the following snapshot reads a blank page.

### There is no `browser-get-text`

Reading the page is `browser-snapshot`. Guessing a tool name yields `no responders`, which reads
like a broken extension. Check `manifest.yaml`.

### The first browser session can time out while Chrome boots

The suite retries a **timeout** once, and only a timeout: a permission error or a real refusal must
fail immediately, or the retry would hide what the suite exists to catch.
