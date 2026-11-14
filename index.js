// dsh-fuyu-switch —— Host 侧。
//
// 只做一件事：把「休眠 / 唤醒 / 关闭 / 状态」转给已有的 deepseek_tray.pyw --ctl。
// 进程控制逻辑（NtSuspendProcess / NtResumeProcess / psutil kill）全部复用托盘，
// 这里不重复实现；不开新端口，走 DSH 自己的 webServer；每次请求只起一个短命子进程，
// 不挂定时器、不缓存结果、不落盘。
//
// pythonw.exe 解析顺序（本机 PATH 里没有 pythonw，不能写裸名）：
//   1. 环境变量 DSH_SWITCH_PYTHONW
//   2. %LOCALAPPDATA%\Programs\Python\Python*\pythonw.exe（按版本号从高到低）
//   3. C:\Python*\pythonw.exe、D:\Python*\pythonw.exe（按版本号从高到低）
//   4. py -3 启动器报告的解释器旁边的 pythonw.exe
//   5. 最后才回退 PATH 里的裸名 pythonw.exe
// 全部失败时返回明确错误文案，不静默失败。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

export const name = 'dsh-fuyu-switch'

// 少了 inject，apply 里访问 ctx.webServer 会直接抛错，插件 fiber 变 FAILED
export const inject = ['webServer']

const API_PREFIX = '/dsh-fuyu-switch'
const ACTIONS = new Set(['status', 'sleep', 'wake', 'close'])
const CTL_TIMEOUT = 20000

let cachedPythonw = null

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// Python314 -> 3014，用于优先挑高版本
function versionOf(filePath) {
  const dir = path.basename(path.dirname(filePath))
  const m = dir.match(/Python(\d)(\d+)?/i)
  return m ? Number(m[1]) * 1000 + Number(m[2] || 0) : 0
}

function scanPythonRoot(root, exactPythonDir) {
  const found = []
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return found
  }
  for (const name of names) {
    const ok = exactPythonDir ? /^Python\d/i.test(name) : /^Python\d+(\.\d+)?$/i.test(name)
    if (!ok) continue
    const exe = path.join(root, name, 'pythonw.exe')
    if (isFile(exe)) found.push(exe)
  }
  return found.sort((a, b) => versionOf(b) - versionOf(a))
}

function fromPyLauncher() {
  try {
    const out = execFileSync('py', ['-3', '-c', 'import sys;print(sys.executable)'], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8',
    })
    const exe = String(out || '').trim().split(/\r?\n/).pop()
    if (!exe) return null
    const pyw = path.join(path.dirname(exe), 'pythonw.exe')
    return isFile(pyw) ? pyw : null
  } catch {
    return null
  }
}

// 返回 { exe, tried }；exe 为 null 表示一个都没找到
function findPythonw() {
  if (cachedPythonw) return { exe: cachedPythonw, tried: [cachedPythonw] }
  const tried = []

  const fromEnv = process.env.DSH_SWITCH_PYTHONW
  if (fromEnv) {
    tried.push(fromEnv)
    if (isFile(fromEnv)) {
      cachedPythonw = fromEnv
      return { exe: fromEnv, tried }
    }
  }

  const local = process.env.LOCALAPPDATA
  if (local) {
    const root = path.join(local, 'Programs', 'Python')
    const list = scanPythonRoot(root, true)
    tried.push(`${root}\\Python*\\pythonw.exe`)
    if (list.length) {
      cachedPythonw = list[0]
      return { exe: list[0], tried }
    }
  }

  for (const drive of ['C:', 'D:']) {
    const list = scanPythonRoot(drive + path.sep, false)
    tried.push(`${drive}\\Python*\\pythonw.exe`)
    if (list.length) {
      cachedPythonw = list[0]
      return { exe: list[0], tried }
    }
  }

  const viaPy = fromPyLauncher()
  tried.push('py -3')
  if (viaPy) {
    cachedPythonw = viaPy
    return { exe: viaPy, tried }
  }

  tried.push('PATH 里的 pythonw.exe')
  return { exe: 'pythonw.exe', tried }
}

function trayScriptPath() {
  const fromEnv = process.env.DSH_SWITCH_TRAY_PYW
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const home = process.env.USERPROFILE || os.homedir()
  const installed = path.join(home, 'DeepSeekTray', 'deepseek_tray.pyw')
  if (fs.existsSync(installed)) return installed
  return null
}

function parseCtlOutput(stdout) {
  const text = String(stdout || '').trim()
  const line = text ? text.split(/\r?\n/).pop() : ''
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function runCtl(action) {
  return new Promise((resolve) => {
    const script = trayScriptPath()
    if (!script) {
      resolve({
        ok: false,
        error:
          '未找到 deepseek_tray.pyw（已查 DSH_SWITCH_TRAY_PYW、%USERPROFILE%\\DeepSeekTray），请先运行插件目录下的 install.ps1',
      })
      return
    }

    const { exe, tried } = findPythonw()
    execFile(
      exe,
      [script, '--ctl', action],
      { windowsHide: true, timeout: CTL_TIMEOUT, encoding: 'utf8' },
      (err, stdout) => {
        const data = parseCtlOutput(stdout)
        if (data) {
          resolve(data)
          return
        }
        if (err && err.code === 'ENOENT') {
          resolve({
            ok: false,
            error: `找不到可用的 pythonw.exe（已尝试：${tried.join('、')}）。请安装 Python 3，或把环境变量 DSH_SWITCH_PYTHONW 指向 pythonw.exe 的完整路径。`,
          })
          return
        }
        resolve({
          ok: false,
          error: err ? `调用托盘脚本失败：${err.message || err}` : '托盘脚本没有返回结果（stdout 为空）',
        })
      },
    )
  })
}

// cordis 按命名导出取 apply；写成 default 会让宿主这半边静默不加载（路由也就不会注册）
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') return

  const send = (res, code, payload) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) {
      send(res, 404, { ok: false, error: 'not found' })
      return true
    }
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '')
    try {
      if (route === '/status') {
        send(res, 200, await runCtl('status'))
        return true
      }
      if (route === '/action') {
        const action = url.searchParams.get('action') || ''
        if (!ACTIONS.has(action) || action === 'status') {
          send(res, 400, { ok: false, error: '未知动作' })
          return true
        }
        send(res, 200, await runCtl(action))
        return true
      }
      send(res, 404, { ok: false, error: '未知接口' })
      return true
    } catch (e) {
      send(res, 500, { ok: false, error: e?.message || String(e) })
      return true
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        dispose?.()
      } catch {}
    })
  }
}
