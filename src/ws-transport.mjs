import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'

const WS_CONNECTING = 0
const WS_OPEN = 1

function toError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

export class SimpleWebSocketTransport {
  #started = false
  #opened

  constructor(ws) {
    this.ws = ws
    this.onclose = undefined
    this.onerror = undefined
    this.onmessage = undefined

    this.#opened = new Promise((resolve, reject) => {
      if (ws.readyState === WS_OPEN) {
        resolve()
        return
      }

      const handleOpen = () => {
        cleanup()
        resolve()
      }
      const handleError = error => {
        cleanup()
        reject(toError(error))
      }
      const cleanup = () => {
        ws.off('open', handleOpen)
        ws.off('error', handleError)
      }

      ws.on('open', handleOpen)
      ws.on('error', handleError)
    })

    ws.on('message', data => {
      try {
        const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
        const parsed = JSON.parse(raw)
        const message = JSONRPCMessageSchema.parse(parsed)
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(toError(error))
      }
    })

    ws.on('error', error => {
      this.onerror?.(toError(error))
    })

    ws.on('close', () => {
      this.onclose?.()
    })
  }

  async start() {
    if (this.#started) {
      throw new Error('WebSocket transport can only be started once.')
    }

    await this.#opened

    if (this.ws.readyState !== WS_OPEN) {
      throw new Error('WebSocket is not open.')
    }

    this.#started = true
  }

  async send(message) {
    if (this.ws.readyState !== WS_OPEN) {
      throw new Error('WebSocket is not open.')
    }

    const payload = JSON.stringify(message)
    await new Promise((resolve, reject) => {
      this.ws.send(payload, error => {
        if (error) {
          reject(toError(error))
          return
        }
        resolve()
      })
    })
  }

  async close() {
    if (
      this.ws.readyState === WS_OPEN ||
      this.ws.readyState === WS_CONNECTING
    ) {
      this.ws.close()
    }
  }
}
