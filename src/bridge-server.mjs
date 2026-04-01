import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ClaudeJetBrainsClientBridge } from './claude-jetbrains-client.mjs'

function formatStatusText(snapshot) {
  const ide = snapshot.ide
  const selection = snapshot.selection

  return [
    `connection: ${snapshot.connection}`,
    `message: ${snapshot.message}`,
    ide ? `ide: ${ide.ideName}` : 'ide: none',
    ide ? `transport: ${ide.transport}` : 'transport: none',
    selection.filePath ? `file: ${selection.filePath}` : 'file: none',
    selection.lineStart !== null
      ? `selection: ${selection.lineStart}-${selection.lineEnd}`
      : 'selection: none',
    selection.updatedAt
      ? `selection_updated_at: ${selection.updatedAt}`
      : 'selection_updated_at: none',
  ].join('\n')
}

function formatSelectionText(selection) {
  if (!selection.filePath) {
    return 'No JetBrains file context is available yet.'
  }

  const lines =
    selection.lineStart !== null
      ? `${selection.lineStart}-${selection.lineEnd}`
      : 'none'

  const chunks = [
    `file: ${selection.filePath}`,
    `has_selection: ${selection.hasSelection}`,
    `lines: ${lines}`,
    `line_count: ${selection.lineCount}`,
  ]

  if (selection.text) {
    chunks.push('', selection.text)
    if (selection.textTruncated) {
      chunks.push('', '...[truncated]')
    }
  }

  return chunks.join('\n')
}

export async function startBridgeServer(options) {
  const bridge = new ClaudeJetBrainsClientBridge(options)
  await bridge.start()

  const server = new McpServer({
    name: 'codex-jetbrains-selection',
    version: '0.1.0',
  })

  server.tool(
    'jetbrains_status',
    'Show connection status for the Claude JetBrains plugin adapter.',
    {},
    async () => {
      const snapshot = bridge.snapshot()
      return {
        content: [
          {
            type: 'text',
            text: formatStatusText(snapshot),
          },
        ],
        structuredContent: snapshot,
      }
    },
  )

  server.tool(
    'jetbrains_list_instances',
    'List discovered JetBrains plugin instances and show which one matches the current project.',
    {},
    async () => {
      await bridge.refresh()
      const snapshot = bridge.snapshot()
      const lines =
        snapshot.discoveredInstances.length === 0
          ? ['No JetBrains plugin instances discovered.']
          : snapshot.discoveredInstances.map(instance => {
              const matchLabel = instance.matched ? 'matched' : 'ignored'
              return `${instance.ideName} · ${instance.transport} · ${instance.url} · ${matchLabel}`
            })

      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n'),
          },
        ],
        structuredContent: {
          cwd: snapshot.cwd,
          instances: snapshot.discoveredInstances,
        },
      }
    },
  )

  server.tool(
    'jetbrains_get_selection',
    'Return the current file path and selected lines forwarded by the Claude JetBrains plugin.',
    {
      includeText: z.boolean().optional().default(true),
      maxChars: z.number().int().positive().max(50000).optional().default(8000),
    },
    async ({ includeText = true, maxChars = 8000 }) => {
      await bridge.refresh()
      const selection = bridge.getSelection({ includeText, maxChars })
      return {
        content: [
          {
            type: 'text',
            text: formatSelectionText(selection),
          },
        ],
        structuredContent: selection,
      }
    },
  )

  server.tool(
    'jetbrains_refresh_connection',
    'Force a fresh scan of lockfiles and reconnect to the matching JetBrains plugin instance.',
    {},
    async () => {
      await bridge.refresh()
      const snapshot = bridge.snapshot()
      return {
        content: [
          {
            type: 'text',
            text: `Refresh complete. ${snapshot.message}`,
          },
        ],
        structuredContent: snapshot,
      }
    },
  )

  server.tool(
    'jetbrains_list_upstream_tools',
    'List the upstream MCP tools exposed by the Claude JetBrains plugin connection for debugging and extension work.',
    {},
    async () => {
      const tools = await bridge.listUpstreamTools()
      return {
        content: [
          {
            type: 'text',
            text:
              tools.length === 0
                ? 'No upstream tools available.'
                : tools.map(tool => `${tool.name} - ${tool.description ?? ''}`).join('\n'),
          },
        ],
        structuredContent: {
          tools,
        },
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const shutdown = async () => {
    await bridge.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}
