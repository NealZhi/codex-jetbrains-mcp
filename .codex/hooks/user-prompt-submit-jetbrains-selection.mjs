#!/usr/bin/env node

import process from 'node:process'
import {
  isSelectionStateFresh,
  readSelectionState,
} from './selection-state.mjs'

const DEFAULT_MAX_AGE_MS = 20000

async function readStdin() {
  const chunks = []

  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8').trim()
}

function getMaxAgeMs() {
  const value = Number(process.env.CODEX_JB_HOOK_MAX_AGE_MS)
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_AGE_MS
  }
  return value
}

function formatAdditionalContext(selection) {
  if (!selection?.filePath) {
    return null
  }

  if (selection.hasSelection) {
    const lines =
      selection.lineStart === selection.lineEnd
        ? `${selection.lineStart}`
        : `${selection.lineStart}-${selection.lineEnd}`

    return [
      `JetBrains 当前选中位置：${selection.filePath}:${lines}`,
      '这只是位置指引，没有附带代码内容。',
      '如果本轮问题和这个位置相关，请先自行读取对应文件和行号；如果无关，请忽略这条上下文。',
    ].join('\n')
  }

  return [
    `JetBrains 当前选中文件：${selection.filePath}`,
    '这只是文件指引，没有附带文件内容。',
    '如果本轮问题和这个文件相关，请先自行读取该文件；如果无关，请忽略这条上下文。',
  ].join('\n')
}

async function main() {
  const input = await readStdin()
  let payload = {}

  if (input) {
    try {
      payload = JSON.parse(input)
    } catch {
      payload = {}
    }
  }
  const cwd =
    typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd()
  const state = await readSelectionState({ cwd })

  if (!state || !isSelectionStateFresh(state, { maxAgeMs: getMaxAgeMs() })) {
    return
  }

  const additionalContext = formatAdditionalContext(state.selection)
  if (!additionalContext) {
    return
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    })}\n`,
  )
}

try {
  await main()
} catch (error) {
  console.error(
    `[codex-jetbrains-hook] ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  process.exit(1)
}
