#!/usr/bin/env node

import process from 'node:process'
import { basename, resolve } from 'node:path'
import { ClaudeJetBrainsClientBridge } from './claude-jetbrains-client.mjs'

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    pollMs: 2000,
    refreshMs: 250,
    maxChars: 160,
    verbose: false,
    once: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]

    if (current === '--cwd') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--cwd requires a value')
      }
      options.cwd = resolve(value)
      index += 1
      continue
    }

    if (current === '--poll-ms') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--poll-ms requires a positive integer')
      }
      options.pollMs = value
      index += 1
      continue
    }

    if (current === '--refresh-ms') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--refresh-ms requires a positive integer')
      }
      options.refreshMs = value
      index += 1
      continue
    }

    if (current === '--max-chars') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--max-chars requires a positive integer')
      }
      options.maxChars = value
      index += 1
      continue
    }

    if (current === '--verbose') {
      options.verbose = true
      continue
    }

    if (current === '--once') {
      options.once = true
      continue
    }

    if (current === '--help' || current === '-h') {
      console.error(
        [
          'Usage: node ./src/hud.mjs [--cwd /path/to/project] [--poll-ms 2000] [--refresh-ms 250] [--max-chars 160] [--once]',
          '',
          'This command renders a lightweight JetBrains selection HUD for Codex.',
        ].join('\n'),
      )
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${current}`)
  }

  return options
}

function formatSelectionRange(selection) {
  if (selection.lineStart === null || selection.lineEnd === null) {
    return '未选中'
  }
  if (selection.lineStart === selection.lineEnd) {
    return `${selection.lineStart}`
  }
  return `${selection.lineStart}-${selection.lineEnd}`
}

function render(snapshot) {
  const { connection, ide, selection } = snapshot
  const connected = connection === 'connected'
  const icon = connected ? '●' : connection === 'connecting' ? '◐' : '○'
  const transport = ide?.transport ?? 'none'
  const ideName = ide?.ideName ?? 'JetBrains'
  const filePath = selection.filePath
  const fileName = filePath ? basename(filePath) : '未捕获到文件'
  const range = formatSelectionRange(selection)
  const linesLabel =
    selection.lineCount > 1 ? ` (${selection.lineCount} lines)` : ''

  const line1 = `JetBrains ${icon} ${ideName} · ${transport} · ${connected ? '已连接' : connection}`
  const line2 = `Selection: ${fileName}:${range}${linesLabel}`

  return [line1, line2].join('\n')
}

function renderFrame(text) {
  const lines = text.split('\n').slice(0, 2)
  while (lines.length < 2) {
    lines.push('')
  }

  process.stdout.write('\x1b[H')
  process.stdout.write(`\x1b[2K${lines[0]}\n`)
  process.stdout.write(`\x1b[2K${lines[1]}`)
  process.stdout.write('\x1b[J')
}

async function run() {
  const options = parseArgs(process.argv.slice(2))
  const bridge = new ClaudeJetBrainsClientBridge(options)
  await bridge.start()

  const shutdown = async () => {
    if (shutdown.done) {
      return
    }
    shutdown.done = true
    await bridge.stop()
    process.exit(0)
  }
  shutdown.done = false

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })

  const printSnapshot = () => {
    const snapshot = bridge.snapshot()
    renderFrame(render(snapshot))
  }

  await bridge.refresh()
  printSnapshot()

  if (options.once) {
    await bridge.stop()
    return
  }

  const timer = setInterval(() => {
    printSnapshot()
  }, options.refreshMs)
  timer.unref?.()
}

try {
  await run()
} catch (error) {
  console.error(
    `[codex-jetbrains-hud] fatal: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  process.exit(1)
}
