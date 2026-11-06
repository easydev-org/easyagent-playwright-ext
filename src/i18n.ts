import type { PlaywrightDeps } from './deps.js'

/**
 * A LOCAL catalogue lookup, because this process no longer links the SDK.
 *
 * It was `defineI18n` from @easydev-org/easybus-sdk — the same three lines of "find the locale's
 * string, else the base locale, then substitute {placeholders}". Copying them here is what lets the
 * sdk drop out of this package entirely; the alternative was keeping a bus dependency for a string
 * table.
 */

/** The locale every lookup falls back to. */
const BASE_LOCALE = 'en'

interface Catalog {
  [key: string]: Record<string, string>
}

/**
 * The language subtag: `zh-CN` -> `zh`, `en-GB` -> `en`.
 *
 * A REGION-QUALIFIED TAG MUST FIND ITS LANGUAGE'S STRING. Without this `zh-CN` falls through to the
 * fallback and a Chinese reader gets English — which is not a crash, so nothing reports it, and it
 * stays wrong until somebody reads the transcript in the wrong language.
 */
function baseLang(locale: string): string {
  const i = locale.indexOf('-')
  return i > 0 ? locale.slice(0, i) : locale
}

function translate(
  catalog: Catalog,
  key: string,
  locale: string,
  params: Record<string, string | number> | undefined,
  fallback: string,
): string {
  const row = catalog[key]
  // A MISSING KEY IS A BUG IN THIS FILE, not a runtime condition: return the key so it is visible in
  // the transcript rather than a blank string nobody can trace.
  if (row === undefined) return key
  // EXACT TAG FIRST, THEN ITS LANGUAGE, THEN THE FALLBACK — the same order the SDK used, so a
  // `zh-CN` session and a `zh` session read the same string.
  for (const cand of [locale, baseLang(locale), fallback, baseLang(fallback)]) {
    const tpl = row[cand]
    if (tpl !== undefined) return interpolate(tpl, params)
  }
  const any = Object.values(row)[0]
  return any !== undefined ? interpolate(any, params) : key
}

function interpolate(text: string, params: Record<string, string | number> | undefined): string {
  let out = text
  for (const [k, v] of Object.entries(params ?? {})) {
    out = out.split(`{${k}}`).join(String(v))
  }
  return out
}

type Translate = (locale: string, key: string, params?: Record<string, string | number>) => string

function defineI18n(catalog: Catalog): { t: Translate } {
  return { t: (locale, key, params) => translate(catalog, key, locale, params, BASE_LOCALE) }
}

/**
 * Playwright-extension message catalog for RUNTIME tool text (content + error)
 * that reaches the model. (Tool DESCRIPTIONS are internal English constants —
 * the extension's localisation convention is the description/manifest path.)
 *
 * The locale set is an OPEN map — add a language by adding a column. New keys
 * are type-checked, so a typo in `t(locale, '...')` fails to compile.
 */
export const CATALOG = {
  contextIdRequired: {
    en: 'context_id is required — call browser-create-context first',
    zh: '缺少 context_id —— 请先调用 browser-create-context。',
  },
  contextIdRequiredUnlessAll: {
    en: 'context_id is required unless all=true',
    zh: '除非 all=true，否则必须提供 context_id。',
  },
  navigated: { en: 'Navigated to {url}', zh: '已导航至 {url}' },
  wentBack: { en: 'Went back to {url}', zh: '已后退至 {url}' },
  clicked: { en: 'Clicked {target}', zh: '已点击 {target}' },
  typed: { en: 'Typed into {target}', zh: '已在 {target} 输入' },
  hovered: { en: 'Hovered {target}', zh: '已悬停 {target}' },
  selected: { en: 'Selected {values}', zh: '已选择 {values}' },
  pressed: { en: 'Pressed {key}', zh: '已按下 {key}' },
  resized: { en: 'Resized to {w}x{h}', zh: '已调整为 {w}x{h}' },
  openedTab: { en: 'Opened tab {index}', zh: '已打开标签页 {index}' },
  selectedTab: { en: 'Selected tab {index}', zh: '已选择标签页 {index}' },
  invalidTabIndex: {
    en: 'invalid tab index {index}',
    zh: '无效的标签页索引 {index}',
  },
  unknownTabsAction: {
    en: 'unknown tabs action: {action}',
    zh: '未知的 tabs 操作：{action}',
  },
  filled: { en: 'Filled: {fields}', zh: '已填写：{fields}' },
  nextDialog: {
    en: 'Next dialog will be {state}',
    zh: '下一个对话框将被{state}',
  },
  dialogAccepted: { en: 'accepted', zh: '接受' },
  dialogDismissed: { en: 'dismissed', zh: '关闭' },
  provideTextOrRegex: {
    en: 'provide either text or regex',
    zh: '请提供 text 或 regex。',
  },
  noRequestAtIndex: {
    en: 'no request at index {index}',
    zh: '索引 {index} 处没有请求。',
  },
  screenshotSaved: {
    en: 'Screenshot saved as file:{code} ({mime}, {bytes} bytes)',
    zh: '截图已保存为 file:{code}（{mime}，{bytes} 字节）',
  },
  pdfSaved: {
    en: 'PDF saved as file:{code} ({mime}, {bytes} bytes)',
    zh: 'PDF 已保存为 file:{code}（{mime}，{bytes} 字节）',
  },
  pdfHeadlessOnly: {
    en: 'pdf failed (PDF is only supported in headless Chromium): {detail}',
    zh: 'pdf 失败（仅无头 Chromium 支持 PDF）：{detail}',
  },
  codesRequired: { en: 'codes is required', zh: '缺少 codes。' },
  uploadedFiles: { en: 'Uploaded {n} file(s)', zh: '已上传 {n} 个文件' },
  dropped: { en: 'Dropped onto {target}', zh: '已拖放到 {target}' },
  storageStateSaved: {
    en: 'Storage state saved as file:{code} ({bytes} bytes)',
    zh: '存储状态已保存为 file:{code}（{bytes} 字节）',
  },
  storageStateRestored: {
    en: 'Storage state restored from file:{code}',
    zh: '已从 file:{code} 恢复存储状态',
  },
  createdContext: {
    en: 'Created browser context. context_id: {id}',
    zh: '已创建浏览器上下文。context_id：{id}',
  },
  closedContexts: {
    en: 'Closed {n} browser context(s)',
    zh: '已关闭 {n} 个浏览器上下文',
  },
  closedContext: {
    en: 'Closed browser context {id}',
    zh: '已关闭浏览器上下文 {id}',
  },
  closedTab: { en: 'Closed tab', zh: '已关闭标签页' },
  waitCompleted: { en: 'Wait completed', zh: '等待完成' },
  dragged: { en: 'Dragged element', zh: '已拖拽元素' },
  noMatches: { en: 'No matches.', zh: '没有匹配项。' },
  noConsoleMessages: { en: 'No console messages.', zh: '没有控制台消息。' },
  noNetworkRequests: { en: 'No network requests.', zh: '没有网络请求。' },
  noBrowserTarget: {
    en: 'no browser target configured',
    zh: '未配置浏览器目标。',
  },
} satisfies Catalog

export type MessageKey = keyof typeof CATALOG

const { t } = defineI18n(CATALOG)

/** Translate a playwright message into `locale`. */
export function tr(
  locale: string,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  return t(locale, key, params)
}

/** Read the session's effective locale (agent-projected), fallback `en`. */
export async function localeOf(
  deps: PlaywrightDeps,
  tenant: string,
  session: string,
): Promise<string> {
  if (session === '') return BASE_LOCALE
  const v = await deps.getSessionVariable(tenant, 'agent', session, 'locale').catch(() => '')
  return v === '' ? BASE_LOCALE : v
}
