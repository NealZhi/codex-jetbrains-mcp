import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const STATE_DIR_NAME = '.codex'
const STATE_FILE_NAME = 'jetbrains-selection-state.json'
const DEFAULT_MAX_AGE_MS = 20000

function pathExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  let current = resolve(cwd)

  while (true) {
    if (pathExists(join(current, '.git'))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) {
      return current
    }
    current = parent
  }
}

export function resolveSelectionStatePath(cwd = process.cwd()) {
  return join(resolveWorkspaceRoot(cwd), STATE_DIR_NAME, STATE_FILE_NAME)
}

function normalizeSelection(selection = {}) {
  const lineStart =
    typeof selection.lineStart === 'number' ? selection.lineStart : null
  const lineEnd = typeof selection.lineEnd === 'number' ? selection.lineEnd : null

  return {
    filePath:
      typeof selection.filePath === 'string' && selection.filePath
        ? selection.filePath
        : null,
    hasSelection: lineStart !== null && lineEnd !== null,
    lineStart,
    lineEnd,
    lineCount: typeof selection.lineCount === 'number' ? selection.lineCount : 0,
    updatedAt:
      typeof selection.updatedAt === 'string' && selection.updatedAt
        ? selection.updatedAt
        : null,
  }
}

export async function readSelectionState({ cwd = process.cwd() } = {}) {
  const filePath = resolveSelectionStatePath(cwd)

  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content)
    return {
      version: parsed?.version,
      workspaceRoot:
        typeof parsed?.workspaceRoot === 'string' ? parsed.workspaceRoot : null,
      connection:
        typeof parsed?.connection === 'string'
          ? parsed.connection
          : 'disconnected',
      syncedAt: typeof parsed?.syncedAt === 'string' ? parsed.syncedAt : null,
      selection: normalizeSelection(parsed?.selection),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export function isSelectionStateFresh(
  state,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!state?.syncedAt || state.connection !== 'connected') {
    return false
  }

  const syncedAtMs = Date.parse(state.syncedAt)
  if (!Number.isFinite(syncedAtMs)) {
    return false
  }

  return now - syncedAtMs <= maxAgeMs
}
