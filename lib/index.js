/**
 * DSH 插件（Host 侧）：让 DSH 用本机 GPT-SoVITS 音色朗读回答。
 *
 * 分工
 * - 本插件只管“什么时候说、说什么、怎么播”：监听会话事件，取助手最终回答的正文，
 *   去 Markdown/代码块后发给本机常驻合成服务。
 * - 合成与播放由 gptsovits-tts/server.py（FastAPI，默认 127.0.0.1:9866）负责，
 *   模型只在服务进程里加载一次，播放走 winsound，不占用浏览器。
 *
 * 之所以分成两部分：DSH 的插件子进程在本机沙箱里拉不起来，且仓库在桌面上（只读），
 * 而 Python 侧需要读写工作目录、独占 GPU。让插件只做 HTTP 客户端最稳。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import * as engine from './engine.js'

export const name = 'gptsovits-tts'

/** 需要 Host 的 webServer 服务来挂同源路由。 */
export const inject = ['webServer']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  baseURL: z.string().pattern(/^https?:\/\/\S+$/iu).default('http://127.0.0.1:9866').volatile(),
  /** 音色 id；auto = 跟随右侧边栏里选中的默认音色（voices.json 的 default）。 */
  voice: z.string().default('auto').volatile(),
  speed: z.number().min(0.5).max(2).default(1).volatile(),
  /** 自动朗读助手回答。 */
  autoSpeak: z.boolean().default(true).volatile(),
  /** 等这么久没有新的助手消息才开口，避免读到中间态。 */
  debounceMs: z.number().min(0).max(5000).default(350).volatile(),
  minChars: z.number().min(1).default(2).volatile(),
  /** 单次朗读上限，超出只念前面这么多字。 */
  maxChars: z.number().min(20).max(4000).default(4000).volatile(),
  skipSubagents: z.boolean().default(true).volatile(),
  interruptOnUser: z.boolean().default(true).volatile(),
  /** 服务没起来时由插件拉起（本机进程，端口探测失败才启动）。 */
  autoStart: z.boolean().default(true).volatile(),
  /** 引擎（运行时+底模+内置音色）装在哪；空 = 默认用户数据目录。 */
  engineDir: z.string().default('').volatile(),
  /** 引擎下载根地址，多个用逗号分隔；空 = 用内置官方源。 */
  downloadBase: z.string().default('').volatile(),
  /** 首次使用自动下载引擎（关掉就只提示、等用户手动装）。 */
  autoDownload: z.boolean().default(true).volatile(),
  /** 以下三项留空即可：打包版会按引擎目录自动推导，填了则优先（旧版开发路径）。 */
  pythonPath: z.string().default('').volatile(),
  serverScript: z.string().default('').volatile(),
  repoPath: z.string().default('').volatile(),
  logPath: z.string().default('').volatile(),
})

/** 官方下载源（可在配置里覆盖/追加）。 */
const DEFAULT_DOWNLOAD_BASES = [
  'https://github.com/Nuoyi207/dsh-gptsovits-tts/releases/download/engine-v1/',
]

/** 插件自带的服务端脚本（打包后与 lib/ 同级）。 */
const PACKAGED_SERVER = fileURLToPath(new URL('./server/server.py', import.meta.url))

const DEFAULTS = {
  downloadBase: DEFAULT_DOWNLOAD_BASES.join(','),
}

function readConfig(config) {
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    // cordis 的 reactive config 每个字段是带 get() 的访问器；单测里直接 resolve 出来则是普通值
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(data.byteLength))
  res.setHeader('cache-control', 'no-store')
  res.end(data)
}

async function readJsonBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid json')
  }
}

async function readRawBody(req, limit = 64 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 从助手消息的 content 里取正文（跳过 reasoning / 工具块）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.join('\n')
}

/** dsh-ui 围栏 → 能念的文字：提示框/列表/键值等读出来，表格与图/代码/JSON 跳过。 */
function uiFenceText(body) {
  let spec
  try {
    spec = JSON.parse(body)
  } catch {
    return ''
  }
  const parts = []
  const push = (value) => {
    if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value))
      return
    }
    if (typeof value !== 'string') return
    const text = value.trim()
    if (text !== '') parts.push(text)
  }
  const SKIP = new Set([
    'code', 'json', 'diff', 'mermaid', 'diagram', 'chart', 'echart', 'plot',
    'scene3d', 'file-tree', 'video', 'audio', 'image', 'divider', 'spacer',
    // 表格念出来又长又难懂，用户明确要求不读（卡片里的提示框、正文照读）。
    'table',
  ])
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object') {
      push(node)
      return
    }
    const kind = typeof node.type === 'string' ? node.type : ''
    if (kind === '') {
      if (node.items) walk(node.items)
      else {
        push(node.title)
        push(node.text)
        push(node.content)
        push(node.desc)
        push(node.label)
        push(node.value)
      }
      return
    }
    if (SKIP.has(kind)) return
    switch (kind) {
      case 'text':
        push(node.text ?? node.content)
        return
      case 'callout':
        if (node.title) push(`${node.title}：${node.content ?? ''}`)
        else push(node.content)
        return
      case 'keyvalue':
        for (const pair of node.pairs ?? []) {
          if (!pair) continue
          push(`${pair.key ?? ''}：${pair.value ?? ''}`)
        }
        return
      case 'list':
      case 'steps':
        walk(node.items ?? node.steps)
        return
      case 'stat':
        push(`${node.label ?? ''}：${node.value ?? ''}`)
        return
      case 'badge':
        push(node.label ?? node.text)
        return
      default:
        push(node.title)
        push(node.content)
        push(node.text)
    }
  }
  walk(spec.items ?? spec)
  return parts.join('。').replace(/。{2,}/g, '。').replace(/。([，、；：])/g, '$1')
}

/** 去掉不该念的东西：代码块、dsh-ui 围栏里的图形/表格、表格行、链接、标记符号；行内代码与卡片里的提示文字保留。 */
function sanitize(text) {
  let out = String(text ?? '')
  out = out.replace(/```dsh-ui\s*\r?\n([\s\S]*?)```/g, (_match, body) => '\n' + uiFenceText(body) + '\n')
  out = out.replace(/```[\s\S]*?```/g, '\n')
  out = out.replace(/~~~[\s\S]*?~~~/g, '\n')
  // 行内代码只脱反引号、内容照念：`client.js: lastSync is not defined` 这种不能吞掉
  out = out.replace(/`([^`\n]*)`/g, ' $1 ')
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/https?:\/\/\S+/g, '')
  out = out.replace(/^\s*\|.*\|\s*$/gm, '')
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, '')
  out = out.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, '')
  out = out.replace(/<[^>]+>/g, '')
  // 只处理星号/波浪号强调，下划线留着（`GSV_CUDNN_BENCH` 这类标识符不能被拆）
  out = out.replace(/[*~]{1,3}([^*~]+)[*~]{1,3}/g, '$1')
  out = out.replace(/[ \t]{2,}/g, ' ')
  out = out.replace(/[ \t]+([，。！？；：、）」』】…])/g, '$1')
  out = out.replace(/([（「『【])[ \t]+/g, '$1')
  out = out.replace(/\n{2,}/g, '\n')
  return out.trim()
}

/** 便于单测：正文清洗与截断。 */
export { chunkForSpeech, sanitize, textOfContent, uiFenceText }

function chunkForSpeech(text, maxChars) {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'))
  return cut > maxChars * 0.5 ? head.slice(0, cut + 1) : head
}

// 插件被停用/DSH 退出时会销毁 ctx.effect：给 8s 宽限期再收服务，
// 这样「重启插件」不会把服务杀掉重来；真被杀掉则由服务端心跳超时兜底。
let disposeTimer = null

export function apply(ctx, config) {
  if (disposeTimer !== null) {
    clearTimeout(disposeTimer)
    disposeTimer = null
  }

  const current = () => readConfig(config)
  const spokenIds = new Set()
  const timers = new Map()
  let starting = null
  let serverReady = false
  let installTask = null
  let lastText = ''
  let defaultVoice = null

  const configPath = (key) => current()[key] || DEFAULTS[key]

  // ── 引擎/路径解析 ───────────────────────────────────────────────
  // 三种形态：
  //   engine : 引擎按发布包安装好（<engineDir>/runtime/python.exe + app/server.py）
  //   dev    : 老式开发布局（桌面整合包 runtime + 工作区 server.py），路径写在 paths.json
  //   missing: 还没装，面板要给下载向导
  let resolved = null

  const dataRoot = () => path.dirname(String(current().engineDir || '').trim() || engine.defaultEngineDir())

  async function readPathsFile() {
    try {
      return JSON.parse(await fs.readFile(path.join(dataRoot(), 'paths.json'), 'utf8'))
    } catch {
      return {}
    }
  }

  async function writePathsFile(patch) {
    const current2 = await readPathsFile()
    const merged = { ...current2, ...patch }
    await fs.mkdir(dataRoot(), { recursive: true })
    await fs.writeFile(path.join(dataRoot(), 'paths.json'), JSON.stringify(merged, null, 2), 'utf8')
    resolved = null
    return merged
  }

  async function resolvePaths(force = false) {
    if (resolved && !force) return resolved
    const cfg = current()
    const saved = await readPathsFile()
    const engineDir = String(cfg.engineDir || saved.engineDir || '').trim()

    // 1) 引擎包
    const engineInfo = await engine.inspect(engineDir || engine.defaultEngineDir())
    if (engineInfo.installed) {
      resolved = {
        mode: 'engine',
        engineDir: engineInfo.dir,
        pythonPath: engineInfo.pythonPath,
        repoPath: engineInfo.repoPath,
        serverScript: engineInfo.serverScript,
        logPath: cfg.logPath || saved.logPath || path.join(dataRoot(), 'server.log'),
        version: engineInfo.version,
      }
      return resolved
    }

    // 2) 开发布局（整合包 + 工作区脚本）
    const devPython = String(cfg.pythonPath || saved.pythonPath || '').trim()
    const devRepo = String(cfg.repoPath || saved.repoPath || '').trim()
    if (devPython && devRepo) {
      resolved = {
        mode: 'dev',
        engineDir: devRepo,
        pythonPath: devPython,
        repoPath: devRepo,
        serverScript: String(cfg.serverScript || saved.serverScript || PACKAGED_SERVER).trim(),
        logPath: cfg.logPath || saved.logPath || path.join(dataRoot(), 'server.log'),
        version: null,
      }
      return resolved
    }

    // 3) 未安装
    resolved = {
      mode: 'missing',
      engineDir: engineInfo.dir,
      pythonPath: engineInfo.pythonPath,
      repoPath: engineInfo.repoPath,
      serverScript: PACKAGED_SERVER,
      logPath: path.join(dataRoot(), 'server.log'),
      version: null,
    }
    return resolved
  }

  const downloadBases = () => {
    const raw = String(current().downloadBase || DEFAULTS.downloadBase || '')
    return raw.split(',').map((item) => item.trim()).filter(Boolean)
  }

  // 把上游（合成服务）的非 2xx 变成一个带状态的错误：面板要看到「正在训练音色」这类原文，
  // 而不是 `service 409: {"detail":"..."}` 这种拼串，也不能一律塌成 500。
  function upstreamError(status, text) {
    let detail = String(text || '').slice(0, 300)
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.detail === 'string' && parsed.detail) detail = parsed.detail
      else if (parsed && typeof parsed.error === 'string' && parsed.error) detail = parsed.error
    } catch {
      // 不是 JSON 就用原文本
    }
    const error = new Error(detail || `service ${status}`)
    error.status = status
    error.detail = detail || `service ${status}`
    return error
  }

  async function callServer(path, { method = 'POST', body, timeoutMs = 15000 } = {}) {
    const url = new URL(path, current().baseURL)
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) throw upstreamError(response.status, text)
    return text ? JSON.parse(text) : {}
  }

  async function callServerRaw(path, buffer, { timeoutMs = 180000 } = {}) {
    const url = new URL(path, current().baseURL)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: buffer,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) throw upstreamError(response.status, text)
    return text ? JSON.parse(text) : {}
  }

  async function probe(timeoutMs = 1200) {
    try {
      await callServer('/health', { method: 'GET', timeoutMs })
      serverReady = true
      return true
    } catch {
      serverReady = false
      return false
    }
  }

  /** auto 时跟随 voices.json 的 default：侧边栏换音色后自动朗读立刻跟着换。 */
  async function resolveVoice() {
    const wanted = String(current().voice || '').trim()
    if (wanted !== '' && wanted !== 'auto') return wanted
    if (defaultVoice !== null) return defaultVoice
    try {
      const data = await callServer('/voices', { method: 'GET', timeoutMs: 5000 })
      defaultVoice = typeof data.default === 'string' ? data.default : ''
    } catch {
      defaultVoice = ''
    }
    return defaultVoice
  }

  /** 参考音频转文字：借本机已在跑的 SenseVoice 服务（dsh-voice 的 sherpa 服务，6006）。 */
  async function transcribe(file) {
    const target = String(file ?? '').trim().replace(/^"(.*)"$/u, '$1')
    if (target === '') throw new Error('缺少参考音频路径')
    let bytes
    try {
      bytes = await fs.readFile(target)
    } catch {
      throw new Error(`读不到参考音频：${target}`)
    }
    const form = new FormData()
    const filename = target.split(/[\\/]/u).pop() || 'ref.wav'
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), filename)
    let response
    try {
      response = await fetch('http://127.0.0.1:6006/api/v1/asr', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60000),
      })
    } catch {
      throw new Error('本机语音识别服务没在跑（127.0.0.1:6006），可先在 dsh-voice 设置里启动')
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`识别失败：${text.slice(0, 200)}`)
    let parsed = {}
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = {}
    }
    const out = parsed.text ?? parsed.result ?? parsed.transcript ?? ''
    return typeof out === 'string' ? out.trim() : ''
  }

  async function spawnServer() {
    const paths = await resolvePaths()
    if (paths.mode === 'missing') throw new Error('引擎还没安装：请先在「语音模型」面板里下载')
    const child = spawn(paths.pythonPath, ['-u', paths.serverScript], {
      cwd: paths.repoPath,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        GSV_REPO: paths.repoPath,
        GSV_LOG: paths.logPath,
        // 音色配置 / 参考音频 / 训练产物放用户数据目录，跟着用户走、不随引擎重装丢失
        GSV_DATA_ROOT: path.join(dataRoot(), 'data'),
        GSV_PORT: String(new URL(current().baseURL).port || '9866'),
        // auto 不是一个音色 id：交给服务自己用 voices.json 的 default 预热
        GSV_VOICE: current().voice === 'auto' ? '' : current().voice || '',
      },
    })
    child.unref()
    // 必须挂 error 监听：python 路径写错时 spawn 会异步抛 'error'，未处理会掀掉整个 Host 进程
    child.on('error', (error) => console.error('[gptsovits-tts] 合成服务进程启动失败', error))
    return child.pid
  }

  async function ensureServer() {
    if (await probe()) return true
    const cfg = current()
    const paths = await resolvePaths()
    if (paths.mode === 'missing') {
      // 引擎没装：允许自动安装时就后台拉一次，本次请求仍按“服务不可用”返回
      if (cfg.autoDownload && !installTask) {
        const state = engine.downloadState
        if (state.phase === 'idle' || state.phase === 'error') {
          installTask = engine
            .install({ engineDir: String(current().engineDir || '').trim() || engine.defaultEngineDir(), bases: downloadBases() })
            .then(() => resolvePaths(true))
            .catch((error) => console.error('[gptsovits-tts] 引擎自动安装失败', error))
            .finally(() => { installTask = null })
          console.log('[gptsovits-tts] 引擎未安装，已开始自动下载')
        }
      }
      return false
    }
    if (!cfg.autoStart) return false
    if (starting !== null) return starting
    starting = (async () => {
      try {
        const pid = spawnServer()
        console.log(`[gptsovits-tts] 拉起合成服务 pid=${pid}`)
      } catch (error) {
        console.error('[gptsovits-tts] 启动合成服务失败', error)
        return false
      }
      for (let i = 0; i < 120; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (await probe(800)) {
          console.log('[gptsovits-tts] 合成服务就绪')
          return true
        }
      }
      return false
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  async function speak(text) {
    const cfg = current()
    if (!cfg.enabled || !cfg.autoSpeak) return { ok: false, skipped: 'disabled' }
    const clean = chunkForSpeech(sanitize(text), cfg.maxChars)
    if (clean.length < cfg.minChars) return { ok: false, skipped: 'too-short' }
    if (!(await ensureServer())) return { ok: false, skipped: 'service-down' }
    lastText = clean
    const voice = await resolveVoice()
    const result = await callServer('/speak', {
      body: { text: clean, voice, speed: cfg.speed },
      timeoutMs: 20000,
    })
    return { ok: true, ...result, chars: clean.length }
  }

  async function stopPlayback() {
    try {
      await callServer('/stop', { timeoutMs: 3000 })
    } catch {
      /* 服务没起来就没什么可停的 */
    }
  }

  function clearTimer(sessionId) {
    const timer = timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
  }

  ctx.on('session/event', (session, event) => {
    const cfg = current()
    if (!cfg.enabled) return
    const sessionId = String(session.id)

    if (event.type === 'user/message') {
      const source = event.data?.source?.kind
      if (source !== 'user') return
      clearTimer(sessionId)
      if (cfg.interruptOnUser) void stopPlayback()
      return
    }

    if (event.type !== 'assistant/message') return
    if (cfg.skipSubagents && session.header?.parentSession !== undefined) return

    const message = event.data?.message
    const text = sanitize(textOfContent(message?.content))
    if (text.length < cfg.minChars) return
    const messageId = typeof message?.id === 'string' ? message.id : ''
    if (messageId !== '' && spokenIds.has(messageId)) return

    clearTimer(sessionId)
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      if (messageId !== '') spokenIds.add(messageId)
      speak(text).catch((error) => console.error('[gptsovits-tts] 朗读失败', error))
    }, cfg.debounceMs)
    timers.set(sessionId, timer)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/gptsovits',
    async handler(req, res) {
      // 前缀路由可能把前缀剥掉再交给 handler，两种形式都认
      const parsedUrl = new URL(req.url ?? '/', 'http://localhost')
      const raw = parsedUrl.pathname
      const pathname = raw.startsWith('/gptsovits') ? raw : `/gptsovits${raw}`
      // 除健康检查外都要有服务：没起来先拉起（冷启动约 20s，前端有 loading）
      const needsService =
        pathname !== '/gptsovits/health' &&
        pathname !== '/gptsovits/last' &&
        pathname !== '/gptsovits/service' &&
        pathname !== '/gptsovits/engine' &&
        pathname !== '/gptsovits/engine/status' &&
        pathname !== '/gptsovits/engine/install' &&
        pathname !== '/gptsovits/engine/use-dir'
      try {
        if (needsService && !(await ensureServer())) {
          json(res, 503, { error: 'service-down' })
          return
        }
        if (pathname === '/gptsovits/health' && req.method === 'GET') {
          const ready = await probe(1000)
          json(res, 200, { plugin: name, service: ready, baseURL: current().baseURL, autoSpeak: current().autoSpeak })
          return
        }
        if (pathname === '/gptsovits/engine' && req.method === 'GET') {
          const paths = await resolvePaths(true)
          json(res, 200, {
            mode: paths.mode,
            installed: paths.mode !== 'missing',
            version: paths.version,
            dir: paths.mode === 'missing' ? engine.defaultEngineDir() : paths.engineDir,
            pythonPath: paths.mode === 'missing' ? '' : paths.pythonPath,
            download: { ...engine.downloadState },
            bases: downloadBases(),
            autoDownload: current().autoDownload,
          })
          return
        }
        if (pathname === '/gptsovits/engine/status' && req.method === 'GET') {
          json(res, 200, { ...engine.downloadState })
          return
        }
        if (pathname === '/gptsovits/engine/install' && req.method === 'POST') {
          const state = engine.downloadState
          if (state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'error') {
            json(res, 200, { ok: true, already: true, ...state })
            return
          }
          const body = await readJsonBody(req).catch(() => ({}))
          const bases = Array.isArray(body.bases) && body.bases.length > 0 ? body.bases : downloadBases()
          installTask = engine
            .install({ engineDir: String(current().engineDir || '').trim() || engine.defaultEngineDir(), bases })
            .then(async () => {
              await resolvePaths(true)
              return true
            })
            .catch((error) => {
              console.error('[gptsovits-tts] 引擎安装失败', error)
              return false
            })
            .finally(() => { installTask = null })
          json(res, 200, { ok: true, started: true })
          return
        }
        if (pathname === '/gptsovits/engine/use-dir' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const dir = String(body.dir ?? '').trim()
          if (!dir) {
            json(res, 400, { error: 'empty-dir' })
            return
          }
          const info = await engine.inspect(dir)
          if (!info.hasPython) {
            json(res, 400, { error: 'not-an-engine', detail: `这个目录里没有 runtime 里的 python：${dir}` })
            return
          }
          await writePathsFile({ engineDir: dir })
          const paths = await resolvePaths(true)
          json(res, 200, { ok: true, mode: paths.mode, dir, version: info.version })
          return
        }
        if (pathname === '/gptsovits/voices' && req.method === 'GET') {
          const data = await callServer('/voices', { method: 'GET', timeoutMs: 5000 })
          json(res, 200, data)
          return
        }
        if (pathname === '/gptsovits/voice' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const result = await callServer('/voice', {
            body: { id: String(body.id ?? '') },
            timeoutMs: 180000,
          })
          defaultVoice = null
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/preview' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const result = await callServer('/preview', {
            body: { voice: String(body.voice ?? ''), text: String(body.text ?? '') },
            timeoutMs: 30000,
          })
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/voices/add' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const result = await callServer('/voices/add', { body, timeoutMs: 180000 })
          defaultVoice = null
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/voices/update' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const result = await callServer('/voices/update', { body, timeoutMs: 180000 })
          defaultVoice = null
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/voices/remove' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const result = await callServer('/voices/remove', {
            body: { id: String(body.id ?? '') },
            timeoutMs: 30000,
          })
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/weights' && req.method === 'GET') {
          json(res, 200, await callServer('/weights', { method: 'GET', timeoutMs: 30000 }))
          return
        }
        if (pathname === '/gptsovits/train/start' && req.method === 'POST') {
          const body = await readJsonBody(req, 4 << 20)
          const payload = {
            name: String(body.name ?? ''),
            tier: String(body.tier ?? 'standard'),
            files: Array.isArray(body.files) ? body.files.map(String) : [],
            separate: typeof body.separate === 'boolean' ? body.separate : null,
            // 下面这些是面板可选参数，必须原样透给服务端，否则设置两个滑轨/强制训练都不生效
            force: body.force === true,
            s2_epochs: Number(body.s2_epochs ?? 0) || 0,
            s1_epochs: Number(body.s1_epochs ?? 0) || 0,
            save_every_s2: Number(body.save_every_s2 ?? 0) || 0,
            save_every_s1: Number(body.save_every_s1 ?? 0) || 0,
            epochs: Number(body.epochs ?? 0) || 0,
          }
          json(res, 200, await callServer('/train/start', { body: payload, timeoutMs: 30000 }))
          return
        }
        if (pathname === '/gptsovits/train/status' && req.method === 'GET') {
          json(res, 200, await callServer('/train/status', { method: 'GET', timeoutMs: 8000 }))
          return
        }
        if (pathname === '/gptsovits/train/log' && req.method === 'GET') {
          const offset = Math.max(0, Number(parsedUrl.searchParams.get('offset') ?? '0') || 0)
          const limit = Math.min(2000, Math.max(1, Number(parsedUrl.searchParams.get('limit') ?? '400') || 400))
          const data = await callServer(`/train/log?offset=${offset}&limit=${limit}`, {
            method: 'GET',
            timeoutMs: 10000,
          })
          json(res, 200, data)
          return
        }
        if (pathname === '/gptsovits/audio/duration' && req.method === 'POST') {
          const payload = await readJsonBody(req)
          json(res, 200, await callServer('/audio/duration', { body: payload, timeoutMs: 60000 }))
          return
        }
        if (pathname === '/gptsovits/train/cancel' && req.method === 'POST') {
          json(res, 200, await callServer('/train/cancel', { body: {}, timeoutMs: 15000 }))
          return
        }
        if (pathname === '/gptsovits/upload' && req.method === 'POST') {
          const name = parsedUrl.searchParams.get('name') || 'record.webm'
          const buffer = await readRawBody(req)
          if (buffer.length === 0) {
            json(res, 400, { error: 'empty-body' })
            return
          }
          const result = await callServerRaw(`/upload?name=${encodeURIComponent(name)}`, buffer)
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/browse' && req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const target = url.searchParams.get('path') ?? ''
          const data = await callServer(`/browse?path=${encodeURIComponent(target)}`, {
            method: 'GET',
            timeoutMs: 30000,
          })
          json(res, 200, data)
          return
        }
        if (pathname === '/gptsovits/asr' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const text = await transcribe(body.path)
          json(res, 200, { text })
          return
        }
        if (pathname === '/gptsovits/speak' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const clean = sanitize(body.text ?? '')
          if (clean === '') {
            json(res, 400, { error: 'empty-text' })
            return
          }
          if (!(await ensureServer())) {
            json(res, 503, { error: 'service-down' })
            return
          }
          const cfg = current()
          const result = await callServer('/speak', {
            body: {
              text: chunkForSpeech(clean, cfg.maxChars),
              voice: body.voice || (await resolveVoice()),
              speed: body.speed ?? cfg.speed,
            },
            timeoutMs: 20000,
          })
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/service' && req.method === 'GET') {
          if (!(await probe(1000))) {
            json(res, 200, { ok: true, service: false, loaded: false, autoStart: current().autoStart })
            return
          }
          try {
            const data = await callServer('/service', { method: 'GET', timeoutMs: 5000 })
            json(res, 200, { ...data, service: true })
          } catch {
            json(res, 200, { ok: true, service: false, loaded: false, autoStart: current().autoStart })
          }
          return
        }
        if (pathname === '/gptsovits/service/restart' && req.method === 'POST') {
          const result = await callServer('/restart', { timeoutMs: 180000 })
          defaultVoice = null
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/service/unload' && req.method === 'POST') {
          json(res, 200, await callServer('/unload', { timeoutMs: 60000 }))
          return
        }
        if (pathname === '/gptsovits/service/stop' && req.method === 'POST') {
          // 服务会自己退出；进程退出前可能来不及回包，所以失败也算成功
          try {
            await callServer('/shutdown', { timeoutMs: 5000 })
          } catch {
            /* 已经停了 */
          }
          serverReady = false
          json(res, 200, { ok: true, service: false })
          return
        }
        if (pathname === '/gptsovits/config' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const result = await callServer('/config', {
            body: { idle_unload_sec: Number(body.idle_unload_sec ?? -1) },
            timeoutMs: 10000,
          })
          json(res, 200, result)
          return
        }
        if (pathname === '/gptsovits/stop' && req.method === 'POST') {
          await stopPlayback()
          json(res, 200, { ok: true })
          return
        }
        if (pathname === '/gptsovits/pause' && req.method === 'POST') {
          json(res, 200, await callServer('/pause', { timeoutMs: 5000 }))
          return
        }
        if (pathname === '/gptsovits/resume' && req.method === 'POST') {
          json(res, 200, await callServer('/resume', { timeoutMs: 5000 }))
          return
        }
        if (pathname === '/gptsovits/status' && req.method === 'GET') {
          try {
            json(res, 200, await callServer('/status', { method: 'GET', timeoutMs: 5000 }))
          } catch {
            json(res, 200, { state: 'idle', offline: true })
          }
          return
        }
        if (pathname === '/gptsovits/last' && req.method === 'GET') {
          json(res, 200, { text: lastText })
          return
        }
        json(res, 404, { error: 'not-found' })
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500
        json(res, status, { error: String(error?.detail ?? error?.message ?? error) })
      }
    },
  }), 'gptsovits-tts: routes')

  // 启动时预热一次：服务没起就拉起来，顺手把模型和参考音频特征加载进显存
  ctx.effect(() => {
    let disposed = false
    void (async () => {
      const cfg = current()
      if (!cfg.enabled) return
      const ready = await ensureServer()
      if (!ready || disposed) return
      try {
        await callServer('/warmup', { timeoutMs: 180000 })
        console.log('[gptsovits-tts] 预热完成')
      } catch (error) {
        console.warn('[gptsovits-tts] 预热失败', error)
      }
    })()
    return () => {
      disposed = true
      for (const sessionId of [...timers.keys()]) clearTimer(sessionId)
    }
  }, 'gptsovits-tts: warmup')

  // 心跳：DSH 后台被强杀时没人发心跳，服务端 30s 后自己退出，不留孤儿进程占显存。
  // 正常关闭（关 DSH / 停用插件）走 dispose：8s 后主动让服务退出。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void callServer('/heartbeat', { timeoutMs: 4000 }).catch(() => {})
    }, 5000)
    // unref：心跳不该把进程钉在事件循环上（Host 退出时也就不用等它）。
    timer.unref?.()
    return () => {
      clearInterval(timer)
      if (disposeTimer !== null) clearTimeout(disposeTimer)
      disposeTimer = setTimeout(() => {
        disposeTimer = null
        void callServer('/shutdown', { timeoutMs: 2000 }).catch(() => {})
      }, 8000)
      disposeTimer.unref?.()
    }
  }, 'gptsovits-tts: heartbeat')
}
