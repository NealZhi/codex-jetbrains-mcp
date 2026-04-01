import { homedir, platform } from 'node:os'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep as pathSeparator } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createConnection } from 'node:net'

const execFileAsync = promisify(execFile)

function isWSL() {
  return process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME)
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function getWindowsUserProfile() {
  if (process.env.USERPROFILE) {
    return process.env.USERPROFILE
  }

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$env:USERPROFILE',
    ])

    const value = stdout.trim()
    return value || undefined
  } catch {
    return undefined
  }
}

function windowsPathToWslPath(inputPath) {
  const normalized = inputPath.replaceAll('\\', '/')
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (!match) {
    return inputPath
  }

  const drive = match[1].toLowerCase()
  const rest = match[2]
  return `/mnt/${drive}/${rest}`
}

export async function getIdeLockfileDirectories() {
  const directories = [join(homedir(), '.claude', 'ide')]

  if (!isWSL()) {
    return directories
  }

  const windowsHome = await getWindowsUserProfile()
  if (windowsHome) {
    directories.push(join(windowsPathToWslPath(windowsHome), '.claude', 'ide'))
  }

  try {
    const users = await readdir('/mnt/c/Users', { withFileTypes: true })
    for (const user of users) {
      if (!user.isDirectory()) {
        continue
      }
      if (
        user.name === 'Public' ||
        user.name === 'Default' ||
        user.name === 'Default User' ||
        user.name === 'All Users'
      ) {
        continue
      }
      directories.push(join('/mnt/c/Users', user.name, '.claude', 'ide'))
    }
  } catch {
    return directories
  }

  return Array.from(new Set(directories))
}

async function readLockfile(lockfilePath) {
  try {
    const content = await readFile(lockfilePath, 'utf8')
    const parsed = JSON.parse(content)
    const filename = lockfilePath.split(pathSeparator).pop()
    const port = Number(filename?.replace(/\.lock$/, ''))

    if (!Number.isFinite(port)) {
      return null
    }

    return {
      lockfilePath,
      port,
      workspaceFolders: Array.isArray(parsed.workspaceFolders)
        ? parsed.workspaceFolders.filter(Boolean)
        : [],
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      ideName:
        typeof parsed.ideName === 'string' && parsed.ideName.trim()
          ? parsed.ideName.trim()
          : 'JetBrains IDE',
      transport: parsed.transport === 'ws' ? 'ws' : 'sse',
      runningInWindows: parsed.runningInWindows === true,
      authToken:
        typeof parsed.authToken === 'string' && parsed.authToken
          ? parsed.authToken
          : undefined,
    }
  } catch {
    return null
  }
}

async function detectHost(instance) {
  if (process.env.CLAUDE_CODE_IDE_HOST_OVERRIDE) {
    return process.env.CLAUDE_CODE_IDE_HOST_OVERRIDE
  }

  if (!isWSL() || !instance.runningInWindows) {
    return '127.0.0.1'
  }

  try {
    const { stdout } = await execFileAsync('sh', [
      '-lc',
      'ip route show | grep -i default',
    ])
    const match = stdout.match(/default via (\d+\.\d+\.\d+\.\d+)/)
    if (match?.[1]) {
      const gateway = match[1]
      const reachable = await checkPort(gateway, instance.port, 300)
      if (reachable) {
        return gateway
      }
    }
  } catch {
    return '127.0.0.1'
  }

  return '127.0.0.1'
}

function normalizePathForCompare(inputPath) {
  const normalized = resolve(inputPath).normalize('NFC')
  if (platform() === 'win32') {
    return normalized.replace(/^[a-z]:/, match => match.toUpperCase())
  }
  return normalized
}

function maybeConvertWorkspacePath(instance, workspacePath) {
  if (isWSL() && instance.runningInWindows) {
    return windowsPathToWslPath(workspacePath)
  }
  return workspacePath
}

function cwdMatchesWorkspace(cwd, instance) {
  const normalizedCwd = normalizePathForCompare(cwd)

  return instance.workspaceFolders.some(workspacePath => {
    const localPath = normalizePathForCompare(
      maybeConvertWorkspacePath(instance, workspacePath),
    )
    return (
      normalizedCwd === localPath ||
      normalizedCwd.startsWith(`${localPath}${pathSeparator}`)
    )
  })
}

export async function discoverJetBrainsInstances({ cwd }) {
  const directories = await getIdeLockfileDirectories()
  const lockfiles = []

  for (const directory of directories) {
    if (!(await pathExists(directory))) {
      continue
    }

    let entries = []
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.lock')) {
        continue
      }
      const lockfilePath = join(directory, entry.name)
      const fileStat = await stat(lockfilePath)
      lockfiles.push({
        lockfilePath,
        mtimeMs: fileStat.mtimeMs,
      })
    }
  }

  lockfiles.sort((left, right) => right.mtimeMs - left.mtimeMs)

  const instances = []
  for (const candidate of lockfiles) {
    const parsed = await readLockfile(candidate.lockfilePath)
    if (!parsed) {
      continue
    }
    const host = await detectHost(parsed)
    const url =
      parsed.transport === 'ws'
        ? `ws://${host}:${parsed.port}`
        : `http://${host}:${parsed.port}/sse`

    instances.push({
      ...parsed,
      host,
      url,
      matched: cwdMatchesWorkspace(cwd, parsed),
      mtimeMs: candidate.mtimeMs,
    })
  }

  return instances
}

export async function discoverBestJetBrainsInstance({ cwd }) {
  const instances = await discoverJetBrainsInstances({ cwd })
  return {
    instances,
    match: instances.find(instance => instance.matched) ?? null,
  }
}

export async function checkPort(host, port, timeout = 500) {
  try {
    return await new Promise(resolve => {
      const socket = createConnection({ host, port, timeout })
      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => {
        resolve(false)
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
  } catch {
    return false
  }
}
