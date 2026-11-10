/**
 * dsh-session-status-colors —— 桌面红绿灯（Host 半）。
 *
 * 职责只有一件事：把页面算好的三个状态计数转交给一个独立的原生窗口进程。
 *
 *   Client（页面）                 Host（本文件）                桌面
 *   ─────────────                 ──────────────               ────
 *   读 ui-session 每会话快照   →   收 POST /state           →   overlay.ps1
 *   红/黄/绿各几个                 写 overlay-state.json        （WPF 置顶窗口）
 *   三个灯的颜色                   拉起 / 关掉子进程             每 400ms 读一次
 *
 * 为什么要有这一跳：DSH 的 Host 是纯 Node 进程，没有创建系统窗口的能力；而
 * 「完成但未查看」这个状态只存在于页面侧的进程内投影里。两边各缺一半，所以
 * 由页面算、Host 转、独立进程画。
 *
 * 通道：Host 自己监听一个 127.0.0.1 的随机端口（不经过 DSH 的 webServer 鉴权），
 * 只接收三个整数与三个颜色。页面通过同源的只读路由查到端口号。
 *
 * 副作用边界：监听一个回环端口、写两个 JSON 文件、按需拉起一个 PowerShell 进程。
 * 插件卸载或页面关闭时，子进程被杀、文件被删、端口被关。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 需要 webServer 才能把回环端口号告诉页面。 */
export const inject = ['webServer']

/** 本插件在日志里的名字。 */
const PLUGIN = 'dsh-session-status-colors'

/** 页面用来查回环端口号的只读路由。 */
const ROUTE = '/dsh-session-status-colors/bridge.json'

/** 桌面窗口脚本。 */
const SCRIPT = fileURLToPath(new URL('./overlay.ps1', import.meta.url))

/** 单次请求体上限：只有三个整数和三个颜色。 */
const MAX_BODY = 64 * 1024

/** 子进程异常退出后的重试次数上限。 */
const MAX_RESTARTS = 4

/** 重试间隔（毫秒）。 */
const RESTART_DELAY_MS = 2500

/** 状态超过这个时长没有更新，子进程会自己退出（这里也据此决定是否重启）。 */
const FRESH_MS = 12000

/** 默认灯色，页面没给颜色时的兜底。 */
const FALLBACK_COLORS = ['#E5484D', '#D9A300', '#2F9E44']

/** 十六进制颜色。 */
const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * 存放状态与位置文件的目录。
 * @returns {string} 绝对目录路径。
 */
function stateDirectory() {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? tmpdir()
  return join(base, 'dsh-session-status-colors')
}

/**
 * 把一个计数规整成非负整数。
 * @param {unknown} value - 不受信任的输入。
 * @returns {number} 0 或正整数。
 */
function toCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(9999, Math.trunc(number))
}

/**
 * 规整页面发来的状态，任何不合法字段都退回默认值。
 * @param {unknown} raw - 请求体解析出的对象。
 * @returns {{ enabled: boolean, counts: number[], colors: string[], ts: number } | null}
 */
function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const counts = Array.isArray(raw.counts) ? raw.counts : []
  const colors = Array.isArray(raw.colors) ? raw.colors : []
  return {
    enabled: raw.enabled === true,
    counts: [0, 1, 2].map((index) => toCount(counts[index])),
    colors: [0, 1, 2].map((index) => {
      const value = colors[index]
      return typeof value === 'string' && HEX.test(value) ? value.toUpperCase() : FALLBACK_COLORS[index]
    }),
    // 时间戳由 Host 盖，避免页面与 Host 的时钟差异被当成“状态过期”。
    ts: Date.now(),
  }
}

/**
 * 挂载插件：回环通道 + 状态文件 + 窗口进程生命周期。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 上下文。
 */
export function apply(ctx) {
  let disposed = false
  let port = 0
  let latest = null
  let child = null
  let restarts = 0
  let restartTimer = null

  const warn = (message, error) => {
    try {
      const detail = error === undefined ? '' : `: ${String(error && error.message ? error.message : error)}`
      ctx.logger?.warn?.(`${PLUGIN}: ${message}${detail}`)
    } catch {
      /* 日志本身失败不能影响主流程。 */
    }
  }

  const directory = stateDirectory()
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    warn('cannot create the state directory', error)
  }
  const statePath = join(directory, 'overlay-state.json')
  const positionPath = join(directory, 'overlay-position.json')

  /**
   * 杀掉一个进程树；用来收掉自己拉起的窗口，以及上一次 Host 留下的孤儿窗口。
   * @param {number} pid - 目标进程。
   */
  const killTree = (pid) => {
    if (typeof pid !== 'number' || pid <= 0) return
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      warn('cannot stop a process', error)
    }
  }

  // 插件重载（例如升级）会留下上一次的窗口进程：状态文件里记着它的 pid 就顺手收掉。
  try {
    const previous = JSON.parse(readFileSync(statePath, 'utf8'))
    if (previous !== null && typeof previous === 'object' && typeof previous.overlayPid === 'number') {
      killTree(previous.overlayPid)
    }
  } catch {
    /* 没有旧状态文件，或者内容不可解析。 */
  }

  /**
   * 原子地写出状态文件（先写临时文件再改名），窗口不会读到半个 JSON。
   * 除页面发来的字段外，还记下当前窗口进程的 pid，供下次启动清理孤儿。
   */
  const writeState = () => {
    if (latest === null) return
    const payload = { ...latest, overlayPid: child === null ? 0 : child.pid }
    const temp = `${statePath}.tmp`
    writeFileSync(temp, JSON.stringify(payload))
    renameSync(temp, statePath)
  }

  /** 杀掉窗口进程（连同它的子进程）。 */
  const stopOverlay = () => {
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (child === null) return
    const pid = child.pid
    child = null
    killTree(pid)
    try {
      // 记下的 pid 已失效，别让下次启动去杀一个被复用的 pid。
      writeState()
    } catch (error) {
      /* 文件写不进去不影响关窗口。 */
    }
  }

  /** 子进程异常退出后的有上限重试。 */
  const scheduleRestart = () => {
    if (disposed || latest === null || latest.enabled !== true) return
    if (Date.now() - latest.ts > FRESH_MS) return
    if (restarts >= MAX_RESTARTS) {
      warn('the overlay keeps exiting; giving up until the state changes', undefined)
      return
    }
    restarts += 1
    restartTimer = setTimeout(() => {
      restartTimer = null
      syncOverlay()
    }, RESTART_DELAY_MS)
  }

  /** 拉起窗口进程。 */
  const startOverlay = () => {
    if (process.platform !== 'win32') {
      warn('the desktop overlay is Windows-only', undefined)
      return
    }
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, statePath, positionPath],
        { windowsHide: true, stdio: 'ignore' },
      )
    } catch (error) {
      warn('cannot start the overlay process', error)
      child = null
      return
    }
    child.on('error', (error) => {
      child = null
      warn('the overlay process failed', error)
      scheduleRestart()
    })
    child.on('exit', () => {
      child = null
      try {
        writeState()
      } catch (error) {
        /* 记不上就等下次覆盖。 */
      }
      scheduleRestart()
    })
    // 把新进程的 pid 记进状态文件，供下一次 Host 启动时清理孤儿。
    try {
      writeState()
    } catch (error) {
      warn('cannot record the overlay pid', error)
    }
  }

  /** 按最新状态决定窗口应有的存在状态。 */
  const syncOverlay = () => {
    if (disposed) return
    if (latest === null || latest.enabled !== true) {
      stopOverlay()
      return
    }
    if (child !== null || restartTimer !== null) return
    startOverlay()
  }

  /**
   * 收下页面发来的一次状态更新。
   * @param {unknown} raw - 请求体解析结果。
   */
  const accept = (raw) => {
    if (disposed) return
    const next = normalizeState(raw)
    if (next === null) return
    latest = next
    if (next.enabled) restarts = 0
    try {
      writeState()
    } catch (error) {
      warn('cannot write the overlay state', error)
    }
    syncOverlay()
  }

  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'content-type')
    response.setHeader('Cache-Control', 'no-store')

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('dsh-session-status-colors')
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end()
      return
    }

    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (size > MAX_BODY) return
      try {
        accept(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        response.writeHead(204)
        response.end()
      } catch (error) {
        response.writeHead(400)
        response.end()
      }
    })
    request.on('error', () => {
      /* 页面中途取消（发送后立即卸载）时会走到这里，不需要处理。 */
    })
  })

  ctx.effect(() => {
    server.on('error', (error) => {
      warn('the overlay bridge cannot listen', error)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = typeof address === 'object' && address !== null ? address.port : 0
    })
    return () => {
      disposed = true
      stopOverlay()
      try {
        server.close()
      } catch (error) {
        /* 已经关闭。 */
      }
      try {
        rmSync(statePath, { force: true })
      } catch (error) {
        /* 删不掉就留给下次覆盖。 */
      }
    }
  }, `${PLUGIN}: overlay bridge`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(JSON.stringify({ ok: true, port }))
    },
  }), `${PLUGIN}: bridge port route`)
}
