import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

/**
 * 引擎（GPT-SoVITS 运行时 + 底模 + 内置音色）的定位、下载、校验与解压。
 *
 * 发布形态：编译好的引擎被切成若干 zip 分片放在下载站，插件首次使用时按顺序拉取、
 * 校验 sha256、解压到 engineDir，之后 server.py 直接把 engineDir 当整合包根目录用。
 */

const MANIFEST_NAME = 'engine.manifest.json'
const MARKER_NAME = '.complete.json'

export function defaultEngineDir() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'dsh-gptsovits-tts', 'engine')
}

/** 引擎目录是否已经装好（有 marker 且 python 存在）。 */
export async function inspect(engineDir) {
  const out = {
    dir: engineDir,
    installed: false,
    version: null,
    pythonPath: path.join(engineDir, 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    repoPath: engineDir,
    serverScript: path.join(engineDir, 'app', 'server.py'),
    incomplete: false,
  }
  try {
    const stat = await fsp.stat(out.pythonPath)
    out.hasPython = stat.isFile()
  } catch {
    out.hasPython = false
  }
  try {
    const raw = await fsp.readFile(path.join(engineDir, MARKER_NAME), 'utf8')
    const meta = JSON.parse(raw)
    out.version = meta.version || null
    out.installed = Boolean(out.hasPython)
  } catch {
    out.incomplete = out.hasPython
  }
  return out
}

/** 下载状态（供面板轮询）。 */
export const downloadState = {
  phase: 'idle', // idle | manifest | downloading | verifying | extracting | done | error
  index: 0,
  parts: 0,
  bytesDone: 0,
  bytesTotal: 0,
  speed: 0,
  message: '',
  error: '',
}

export function resetDownloadState() {
  Object.assign(downloadState, {
    phase: 'idle', index: 0, parts: 0, bytesDone: 0, bytesTotal: 0, speed: 0, message: '', error: '',
  })
}

function setPhase(phase, message) {
  downloadState.phase = phase
  downloadState.message = message || ''
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
  if (!res.ok) throw new Error(`manifest ${res.status}`)
  return res.json()
}

async function sha256File(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', resolve)
    rs.on('error', reject)
  })
  return hash.digest('hex')
}

function runCapture(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exit ${code}: ${stderr.slice(-400)}`))))
  })
}

/** 解压：Windows/Linux 用 tar（bsdtar 支持 zip），拿不到时退回 unzip。 */
export async function extractZip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true })
  try {
    await runCapture('tar', ['-xf', zipPath, '-C', destDir])
    return 'tar'
  } catch (err) {
    if (process.platform !== 'win32') {
      await runCapture('unzip', ['-q', '-o', zipPath, '-d', destDir])
      return 'unzip'
    }
    throw err
  }
}

async function downloadPart(url, file, part, baseOffset) {
  const expected = part.bytes
  let have = 0
  try {
    const st = await fsp.stat(file)
    have = st.size
  } catch { have = 0 }
  if (have > expected) { await fsp.rm(file, { force: true }); have = 0 }

  const res = await fetch(url, { headers: have > 0 ? { range: `bytes=${have}-` } : {} })
  if (!res.ok || (have > 0 && res.status !== 206)) {
    if (res.status === 416) {
      // 本地比远端还长：重下
      await fsp.rm(file, { force: true })
      return downloadPart(url, file, part, baseOffset)
    }
    throw new Error(`HTTP ${res.status}`)
  }
  const fd = fs.openSync(file, have > 0 ? 'r+' : 'w')
  const start = Date.now()
  let written = have
  let lastTick = start
  let lastBytes = written
  try {
    fs.ftruncateSync(fd, have > 0 ? have : 0)
    for await (const chunk of res.body) {
      fs.writeSync(fd, chunk, 0, chunk.length, written)
      written += chunk.length
      downloadState.bytesDone = baseOffset + written
      const now = Date.now()
      if (now - lastTick > 400) {
        downloadState.speed = Math.round(((written - lastBytes) / (now - lastTick)) * 1000)
        lastTick = now
        lastBytes = written
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  if (written !== expected) throw new Error(`size mismatch ${written}/${expected}`)
}

/**
 * 下载并安装引擎。bases 是候选下载根（依次尝试）。
 * 返回 {dir, version}。
 */
export async function install({ engineDir, bases, onPhase }) {
  const dir = engineDir || defaultEngineDir()
  resetDownloadState()
  const tmpDir = path.join(dir, '.download')
  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    let manifest = null
    let base = ''
    setPhase('manifest', '获取安装清单…')
    for (const candidate of bases) {
      try {
        manifest = await fetchJson(new URL(MANIFEST_NAME, candidate).toString())
        base = candidate.endsWith('/') ? candidate : candidate + '/'
        break
      } catch (err) {
        onPhase && onPhase('manifest-fail', String(err.message || err))
      }
    }
    if (!manifest) throw new Error('拿不到安装清单（所有下载源都失败）')
    downloadState.parts = manifest.parts.length
    downloadState.bytesTotal = manifest.total_bytes || manifest.parts.reduce((s, p) => s + p.bytes, 0)
    downloadState.bytesDone = 0

    const archiveDir = path.join(tmpDir, 'parts')
    await fsp.mkdir(archiveDir, { recursive: true })

    // 边下边解：峰值占用 ≈ 最大分片 + 解压后总量，而不是「全部分片 + 解压后总量」
    const needBytes = downloadState.bytesTotal
    try {
      const stats = await fsp.statfs(dir)
      const freeBytes = Number(stats.bavail) * Number(stats.bsize)
      downloadState.freeBytes = freeBytes
      if (freeBytes > 0 && freeBytes < needBytes * 1.1) {
        throw new Error(
          `磁盘空间不够：需要约 ${(needBytes * 1.1 / 1073741824).toFixed(1)} GB，` +
          `可用 ${(freeBytes / 1073741824).toFixed(1)} GB（目标目录 ${dir}）`,
        )
      }
    } catch (err) {
      if (/磁盘空间不够/u.test(String(err && err.message))) throw err
      // statfs 不可用就跳过这项检查
    }

    for (let i = 0; i < manifest.parts.length; i += 1) {
      const part = manifest.parts[i]
      downloadState.index = i + 1
      const file = path.join(archiveDir, part.name)
      setPhase('downloading', `下载 ${i + 1}/${manifest.parts.length}：${part.name}`)
      await downloadPart(new URL(part.name, base).toString(), file, part, downloadState.bytesDone)
      setPhase('verifying', `校验 ${part.name}`)
      const digest = await sha256File(file)
      if (part.sha256 && digest !== part.sha256) {
        await fsp.rm(file, { force: true })
        throw new Error(`${part.name} 校验失败（sha256 不一致），已删除，请重试`)
      }
      setPhase('extracting', `解压 ${i + 1}/${manifest.parts.length}：${part.name}`)
      await extractZip(file, dir)
      await fsp.rm(file, { force: true })
      onPhase && onPhase('extracted', part.name)
    }
    downloadState.index = manifest.parts.length
    await fsp.writeFile(path.join(dir, MARKER_NAME), JSON.stringify({
      version: manifest.version, installedAt: new Date().toISOString(), parts: manifest.parts.length,
    }, null, 2), 'utf8')
    setPhase('done', '引擎安装完成')
    return { dir, version: manifest.version }
  } catch (err) {
    downloadState.error = String(err && err.message ? err.message : err)
    setPhase('error', downloadState.error)
    throw err
  }
}

/** 已装引擎占用的磁盘空间（面板里显示用）。 */
export async function diskUsage(dir) {
  let total = 0
  async function walk(current) {
    let entries = []
    try { entries = await fsp.readdir(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        try { total += (await fsp.stat(full)).size } catch { /* ignore */ }
      }
    }
  }
  await walk(dir)
  return total
}
