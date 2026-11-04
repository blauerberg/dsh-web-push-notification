import type { IncomingMessage, ServerResponse } from 'node:http'

export function request(method: string, body?: unknown, contentType = 'application/json'): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers:
      raw === ''
        ? { host: '127.0.0.1' }
        : { host: '127.0.0.1', 'content-type': contentType, 'content-length': String(Buffer.byteLength(raw)) },
    async *[Symbol.asyncIterator]() {
      if (raw !== '') yield Buffer.from(raw)
    },
  } as unknown as IncomingMessage
}

export function response() {
  const captured = {
    status: 0,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    raw: undefined as unknown,
  }
  const writable = {
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      captured.status = status
      captured.headers = headers
    },
    end(raw?: unknown) {
      captured.raw = raw
      const text = raw === undefined ? undefined : String(raw)
      try {
        captured.body = text === undefined ? undefined : JSON.parse(text)
      } catch {
        captured.body = text
      }
    },
  } as unknown as ServerResponse
  return Object.assign(captured, { response: writable })
}
