import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function waitPort(port: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise<boolean>(resolve => {
      const s = createConnection({ host: '127.0.0.1', port }, () => {
        s.destroy()
        resolve(true)
      })
      s.on('error', () => resolve(false))
    })
    if (ok) return true
    await delay(50)
  }
  return false
}

/** Start a real nats-server (returns null when the binary is absent). */
export async function startNats(): Promise<{ url: string; stop: () => void } | null> {
  const bin = process.env['EASYBUS_NATS_SERVER_BIN'] || 'nats-server'
  const dir = mkdtempSync(join(tmpdir(), 'playwright-ext-'))
  const port = 16200 + Math.floor(Math.random() * 800)
  let proc: ChildProcess
  try {
    proc = spawn(bin, ['-p', String(port), '-sd', dir, '-js'], { stdio: 'ignore' })
  } catch {
    return null
  }
  let spawnErr = false
  proc.on('error', () => {
    spawnErr = true
  })
  if (spawnErr || !(await waitPort(port))) {
    proc.kill()
    return null
  }
  return { url: `nats://127.0.0.1:${port}`, stop: () => proc.kill() }
}

/** Start a headless Chromium with a CDP endpoint (returns null when absent).
 *  Honors CHROME_BIN, else tries the common names on $PATH. */
export async function startChrome(): Promise<{ endpoint: string; stop: () => void } | null> {
  const candidates = process.env['CHROME_BIN']
    ? [process.env['CHROME_BIN']]
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  const port = 19400 + Math.floor(Math.random() * 500)
  for (const bin of candidates) {
    let proc: ChildProcess
    try {
      proc = spawn(
        bin as string,
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          `--remote-debugging-port=${port}`,
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${mkdtempSync(join(tmpdir(), 'chr-'))}`,
          'about:blank',
        ],
        { stdio: 'ignore' },
      )
    } catch {
      continue
    }
    let err = false
    proc.on('error', () => {
      err = true
    })
    if (!err && (await waitPort(port))) {
      return { endpoint: `http://127.0.0.1:${port}`, stop: () => proc.kill() }
    }
    proc.kill()
  }
  return null
}
