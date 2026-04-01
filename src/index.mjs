#!/usr/bin/env node

import process from 'node:process'
import { resolve } from 'node:path'
import { startBridgeServer } from './bridge-server.mjs'

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    pollMs: 2000,
    verbose: false,
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

    if (current === '--verbose') {
      options.verbose = true
      continue
    }

    if (current === '--help' || current === '-h') {
      console.error(
        [
          'Usage: node ./src/index.mjs [--cwd /path/to/project] [--poll-ms 2000] [--verbose]',
          '',
          'This MCP server bridges Codex to the Claude JetBrains plugin.',
        ].join('\n'),
      )
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${current}`)
  }

  return options
}

try {
  const options = parseArgs(process.argv.slice(2))
  await startBridgeServer(options)
} catch (error) {
  console.error(
    `[codex-jetbrains-mcp] fatal: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  process.exit(1)
}
