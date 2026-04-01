import process from 'node:process'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { z } from 'zod'
import { discoverBestJetBrainsInstance } from './ide-discovery.mjs'
import { SimpleWebSocketTransport } from './ws-transport.mjs'

const SelectionChangedNotificationSchema = z.object({
  method: z.literal('selection_changed'),
  params: z.object({
    selection: z
      .object({
        start: z.object({
          line: z.number(),
          character: z.number(),
        }),
        end: z.object({
          line: z.number(),
          character: z.number(),
        }),
      })
      .nullable()
      .optional(),
    text: z.string().optional(),
    filePath: z.string().optional(),
  }),
})

const AtMentionedNotificationSchema = z.object({
  method: z.literal('at_mentioned'),
  params: z
    .object({
      filePath: z.string().optional(),
    })
    .passthrough(),
})

const LogEventNotificationSchema = z.object({
  method: z.literal('log_event'),
  params: z
    .object({
      eventName: z.string().optional(),
    })
    .passthrough(),
})

function createInitialState(cwd) {
  return {
    cwd,
    connection: 'disconnected',
    message: 'Adapter not started yet.',
    ide: null,
    selection: {
      filePath: null,
      text: null,
      lineStart: null,
      lineEnd: null,
      lineCount: 0,
      charStart: null,
      charEnd: null,
      updatedAt: null,
    },
    discoveredInstances: [],
    lastRefreshAt: null,
  }
}

function formatSelection(selection, { includeText, maxChars }) {
  const text =
    includeText && typeof selection.text === 'string'
      ? selection.text.slice(0, maxChars)
      : null

  return {
    filePath: selection.filePath,
    hasSelection: selection.lineStart !== null,
    lineStart: selection.lineStart,
    lineEnd: selection.lineEnd,
    lineCount: selection.lineCount,
    charStart: selection.charStart,
    charEnd: selection.charEnd,
    text,
    textTruncated:
      includeText &&
      typeof selection.text === 'string' &&
      selection.text.length > maxChars,
    updatedAt: selection.updatedAt,
  }
}

export class ClaudeJetBrainsClientBridge {
  constructor({ cwd, pollMs = 2000, verbose = false }) {
    this.cwd = cwd
    this.pollMs = pollMs
    this.verbose = verbose
    this.state = createInitialState(cwd)
    this.client = null
    this.transport = null
    this.connectedInstance = null
    this.refreshPromise = null
    this.pollTimer = null
  }

  log(message) {
    if (this.verbose) {
      console.error(`[codex-jetbrains-mcp] ${message}`)
    }
  }

  snapshot() {
    return structuredClone(this.state)
  }

  async start() {
    await this.refresh()
    this.pollTimer = setInterval(() => {
      void this.refresh()
    }, this.pollMs)
    this.pollTimer.unref?.()
  }

  async stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    await this.#disconnect('Adapter stopped.')
  }

  async refresh() {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.#refreshImpl().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  async listUpstreamTools() {
    await this.refresh()
    if (!this.client) {
      return []
    }

    try {
      const result = await this.client.listTools()
      return result.tools ?? []
    } catch (error) {
      await this.#disconnect(`Failed to list upstream tools: ${String(error)}`)
      return []
    }
  }

  async #refreshImpl() {
    const discovered = await discoverBestJetBrainsInstance({ cwd: this.cwd })
    this.state.discoveredInstances = discovered.instances.map(instance => ({
      ideName: instance.ideName,
      url: instance.url,
      transport: instance.transport,
      lockfilePath: instance.lockfilePath,
      workspaceFolders: instance.workspaceFolders,
      matched: instance.matched,
      runningInWindows: instance.runningInWindows,
      authTokenPresent: Boolean(instance.authToken),
      mtimeMs: instance.mtimeMs,
    }))
    this.state.lastRefreshAt = new Date().toISOString()

    if (!discovered.match) {
      await this.#disconnect('No matching JetBrains instance found for current cwd.')
      return
    }

    if (
      this.connectedInstance &&
      this.client &&
      this.connectedInstance.url === discovered.match.url &&
      this.connectedInstance.authToken === discovered.match.authToken
    ) {
      this.state.connection = 'connected'
      this.state.message = `Connected to ${discovered.match.ideName}`
      return
    }

    await this.#connect(discovered.match)
  }

  async #connect(instance) {
    await this.#disconnect('Switching IDE instance.')

    this.state.connection = 'connecting'
    this.state.message = `Connecting to ${instance.ideName}...`
    this.state.ide = {
      ideName: instance.ideName,
      url: instance.url,
      transport: instance.transport,
      workspaceFolders: instance.workspaceFolders,
      lockfilePath: instance.lockfilePath,
      authTokenPresent: Boolean(instance.authToken),
    }

    this.log(`Connecting to ${instance.url}`)

    const client = new Client({
      name: 'codex-jetbrains-upstream-client',
      version: '0.1.0',
    })

    client.setNotificationHandler(SelectionChangedNotificationSchema, notification => {
      this.#handleSelection(notification.params ?? {})
    })

    client.setNotificationHandler(AtMentionedNotificationSchema, notification => {
      const params = notification.params ?? {}
      this.log(
        `Received at_mentioned for ${params.filePath ?? 'unknown file'}`,
      )
    })

    client.setNotificationHandler(LogEventNotificationSchema, notification => {
      const params = notification.params ?? {}
      this.log(`Upstream log_event: ${params.eventName ?? 'unknown'}`)
    })

    let transport
    if (instance.transport === 'ws') {
      const headers = {
        ...(instance.authToken
          ? {
              'X-Claude-Code-Ide-Authorization': instance.authToken,
            }
          : {}),
      }
      const ws = new WebSocket(instance.url, ['mcp'], { headers })
      transport = new SimpleWebSocketTransport(ws)
    } else {
      transport = new SSEClientTransport(new URL(instance.url))
    }

    transport.onerror = error => {
      this.log(`Upstream transport error: ${error.message}`)
    }

    transport.onclose = () => {
      this.log('Upstream transport closed.')
      this.#markDisconnected('JetBrains plugin connection closed.')
    }

    try {
      await client.connect(transport)
      await client.notification({
        method: 'ide_connected',
        params: {
          pid: process.pid,
        },
      })

      this.client = client
      this.transport = transport
      this.connectedInstance = instance
      this.state.connection = 'connected'
      this.state.message = `Connected to ${instance.ideName}`

      this.log(`Connected to ${instance.ideName}`)
    } catch (error) {
      this.state.connection = 'disconnected'
      this.state.message = `Failed to connect: ${String(error)}`
      await this.#disconnect(`Connection failed: ${String(error)}`)
    }
  }

  async #disconnect(message) {
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {}
    }

    if (this.client?.close) {
      try {
        await this.client.close()
      } catch {}
    }

    this.#markDisconnected(message)
  }

  #markDisconnected(message) {
    this.client = null
    this.transport = null
    this.connectedInstance = null
    this.state.ide = null
    this.state.connection = 'disconnected'
    this.state.message = message
  }

  #handleSelection(params) {
    const nextSelection = {
      filePath:
        typeof params.filePath === 'string' && params.filePath
          ? params.filePath
          : null,
      text: typeof params.text === 'string' ? params.text : null,
      lineStart: null,
      lineEnd: null,
      lineCount: 0,
      charStart: null,
      charEnd: null,
      updatedAt: new Date().toISOString(),
    }

    const start = params?.selection?.start
    const end = params?.selection?.end

    if (
      typeof start?.line === 'number' &&
      typeof start?.character === 'number' &&
      typeof end?.line === 'number' &&
      typeof end?.character === 'number'
    ) {
      let lineCount = end.line - start.line + 1
      if (end.character === 0) {
        lineCount -= 1
      }
      if (lineCount < 1) {
        lineCount = 1
      }

      nextSelection.lineStart = start.line
      nextSelection.lineEnd = start.line + lineCount - 1
      nextSelection.lineCount = lineCount
      nextSelection.charStart = start.character
      nextSelection.charEnd = end.character
    }

    this.state.selection = nextSelection
    this.log(
      `Selection updated: ${nextSelection.filePath ?? 'no-file'}:${nextSelection.lineStart ?? '-'}-${nextSelection.lineEnd ?? '-'}`,
    )
  }

  getSelection({ includeText = true, maxChars = 8000 } = {}) {
    return formatSelection(this.state.selection, { includeText, maxChars })
  }
}
