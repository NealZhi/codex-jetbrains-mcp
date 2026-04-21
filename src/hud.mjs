#!/usr/bin/env node

import process from 'node:process'
import { basename, resolve } from 'node:path'
import { ClaudeJetBrainsClientBridge } from './claude-jetbrains-client.mjs'
import {
  createEmptySelectionState,
  createSelectionState,
  writeSelectionState,
} from './selection-state.mjs'

const STATE_SYNC_INTERVAL_MS = 5000

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
  const ideName = ide?.ideName ?? 'JetBrains'
  const filePath = selection.filePath
  const fileName = filePath ? basename(filePath) : '未捕获到文件'
  const range = formatSelectionRange(selection)
  const linesLabel =
    selection.lineCount > 1 ? ` (${selection.lineCount} lines)` : ''

  const connectionLabel = connected ? '已连接' : connection
  const ideLabel = `JetBrains ${ideName}`

  return `  ${ideLabel} ${connectionLabel} | ${fileName}:${range}${linesLabel}`
}

function renderFrame(text) {
  process.stdout.write('\x1b[H')
  process.stdout.write(`\x1b[2K${text}`)
  process.stdout.write('\x1b[J')
}

async function run() {
  const options = parseArgs(process.argv.slice(2))
  const bridge = new ClaudeJetBrainsClientBridge(options)
  let writeInFlight = null
  let stateTimer = null

  const queuePersist = snapshot => {
    const task = async () => {
      const state = createSelectionState(snapshot, { cwd: options.cwd })
      await writeSelectionState(state, { cwd: options.cwd })
    }

    writeInFlight = (writeInFlight ?? Promise.resolve())
      .then(task)
      .catch(error => {
        console.error(
          `[codex-jetbrains-hud] failed to persist selection state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })

    return writeInFlight
  }

  const persistEmptyState = async () => {
    const state = createEmptySelectionState({ cwd: options.cwd })
    await writeSelectionState(state, { cwd: options.cwd })
  }

  await bridge.start()
  await queuePersist(bridge.snapshot())

  const shutdown = async () => {
    if (shutdown.done) {
      return
    }
    shutdown.done = true
    if (stateTimer) {
      clearInterval(stateTimer)
      stateTimer = null
    }
    await bridge.stop()
    try {
      await persistEmptyState()
    } finally {
      process.exit(0)
    }
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
    await persistEmptyState()
    return
  }

  const timer = setInterval(() => {
    printSnapshot()
  }, options.refreshMs)
  timer.unref?.()

  stateTimer = setInterval(() => {
    void queuePersist(bridge.snapshot())
  }, STATE_SYNC_INTERVAL_MS)
  stateTimer.unref?.()
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
