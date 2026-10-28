// The browser panel.
//
// Polls two endpoints and redraws: the list every few seconds, and the selected context's screenshot
// about once a second. "Live" means refreshed on a timer, not streamed — see src/ui/server.ts for why
// a screenshot beat a screencast here.
//
// Plain JS with no build step, because the whole panel is this file plus one HTML document. The host
// serves both from the extension, so there is nothing to bundle.

/** Where this UI is mounted. Derived, so a rename of the Service cannot leave requests pointing at
 *  the old prefix. `/ext/playwright` -> `/ext/playwright/api/`. */
const API = (() => {
  const p = location.pathname.replace(/\/+$/, '')
  return `${p}/api/`
})()

/** The bearer the host stored. Same origin, so the token the host already has is the one we send. */
function token() {
  try {
    return localStorage.getItem('agent.token') ?? ''
  } catch {
    return ''
  }
}

async function getJSON(path) {
  const t = token()
  const res = await fetch(API + path, {
    headers: t ? { authorization: `Bearer ${t}` } : {},
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const b = await res.json()
      if (b && typeof b.error === 'string') msg = b.error
    } catch {
      /* keep the status */
    }
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return res.json()
}

// ---- state ----
let contexts = []
let selected = ''
let listError = ''
let frameError = ''
/** Bumped on every frame refresh so a slow response cannot overwrite a newer one. */
let frameSeq = 0
/** Object URL currently shown; revoked when replaced, or the browser holds every frame forever. */
let frameURL = ''

const LIST_MS = 5000
const FRAME_MS = 1000

async function refreshList() {
  try {
    const d = await getJSON('contexts')
    contexts = Array.isArray(d.contexts) ? d.contexts : []
    listError = ''
    // Drop a selection that no longer exists, so the page does not keep showing a dead browser.
    if (selected !== '' && !contexts.some(c => c.contextId === selected)) {
      selected = ''
      setFrameURL('')
    }
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e)
  }
  render()
}

async function refreshFrame() {
  if (selected === '') return
  const seq = ++frameSeq
  const id = selected
  try {
    const t = token()
    const res = await fetch(`${API}contexts/${encodeURIComponent(id)}/frame`, {
      headers: t ? { authorization: `Bearer ${t}` } : {},
      cache: 'no-store',
    })
    // A response for a context the reader has already left must not paint.
    if (seq !== frameSeq || id !== selected) return
    if (!res.ok) {
      // 503 means "this frame failed, the context is probably still there" — keep the old picture
      // rather than blanking, and let the next tick try again.
      frameError = res.status === 503 ? 'waiting for the page…' : `HTTP ${res.status}`
      render()
      return
    }
    const blob = await res.blob()
    if (seq !== frameSeq || id !== selected) return
    setFrameURL(URL.createObjectURL(blob))
    frameError = ''
    render()
  } catch (e) {
    if (seq !== frameSeq) return
    frameError = e instanceof Error ? e.message : String(e)
    render()
  }
}

function setFrameURL(next) {
  if (frameURL !== '') URL.revokeObjectURL(frameURL)
  frameURL = next
}

function choose(id) {
  if (selected === id) return
  selected = id
  setFrameURL('')
  frameError = ''
  // Newest sequence: any in-flight frame for the previous context is now stale.
  frameSeq++
  render()
  void refreshFrame()
}

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== null && v !== undefined) n.setAttribute(k, String(v))
  }
  for (const kid of kids) if (kid) n.append(kid)
  return n
}

function render() {
  const app = document.getElementById('app')
  if (!app) return
  app.replaceChildren()

  const narrow = matchMedia('(max-width: 640px)').matches

  // ---- rail ----
  const rail = el('aside')
  if (narrow && selected !== '') rail.classList.add('hidden')
  if (contexts.length === 0) {
    rail.append(
      el('div', {
        class: `state${listError ? ' err' : ''}`,
        text: listError || 'No open browsers.',
      }),
    )
  } else {
    for (const c of contexts) {
      const pills = []
      if (c.busy) pills.push(el('span', { class: 'pill busy', text: 'busy' }))
      if (!c.alive) pills.push(el('span', { class: 'pill dead', text: 'closed' }))
      rail.append(
        el('button', {
          class: `row${c.contextId === selected ? ' active' : ''}`,
          onclick: () => choose(c.contextId),
        }, [
          el('span', { class: 'name', text: c.title || c.contextId.slice(0, 8) }),
          el('span', { class: 'micro muted mono', text: c.contextId.slice(0, 8) }),
          // Which conversation opened it: the list spans sessions, so the reader needs to know.
          el('span', { class: 'micro muted', text: c.session || '—' }),
          pills.length ? el('span', { class: 'micro' }, pills) : null,
        ]),
      )
    }
  }

  // ---- page ----
  const main = el('main')
  if (narrow && selected === '') main.classList.add('hidden')

  if (selected === '') {
    main.append(
      el('div', { class: 'state', text: narrow ? 'Pick a browser.' : 'Pick a browser on the left.' }),
    )
  } else {
    const c = contexts.find(x => x.contextId === selected)
    const head = el('header', {}, [
      narrow
        ? el('button', { class: 'muted', text: '←', onclick: () => choose(''), title: 'back' })
        : null,
      el('span', { class: 'title', text: c ? c.title || c.url || selected : selected }),
      el('span', { class: 'micro muted', text: c ? c.session : '' }),
    ])
    main.append(head)

    const stage = el('div', { class: 'stage' })
    if (frameError && frameURL === '') {
      stage.append(el('div', { class: 'state err', text: frameError }))
    } else if (frameURL === '') {
      stage.append(el('div', { class: 'state', text: 'Loading…' }))
    } else {
      stage.append(el('img', { src: frameURL, alt: 'page' }))
    }
    main.append(stage)
  }

  app.append(rail, main)
}

// ---- theme, from the host ----
//
// An iframe has its own <html>, so the host's data-theme does not reach it. The host puts it in the
// URL for the first paint and pushes changes over postMessage.
;(() => {
  const q = new URLSearchParams(location.search).get('theme')
  const m = q === 'dark' || q === 'light' ? q : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = m
})()

window.addEventListener('message', ev => {
  const d = ev.data
  if (d && d.type === 'easyagent:theme' && (d.theme === 'dark' || d.theme === 'light')) {
    document.documentElement.dataset.theme = d.theme
  }
})

// ---- go ----
render()
void refreshList()
void refreshFrame()
setInterval(() => void refreshList(), LIST_MS)
setInterval(() => void refreshFrame(), FRAME_MS)
// The rail's layout depends on the width, so a resize redraws it.
matchMedia('(max-width: 640px)').addEventListener('change', render)
