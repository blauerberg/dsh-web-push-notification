import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function readJson(req: IncomingMessage, maxBytes: number, allowEmpty = false): Promise<unknown> {
  const contentType = req.headers['content-type']
  const mediaType = typeof contentType === 'string' ? contentType.split(';', 1)[0]?.trim().toLowerCase() : undefined
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'content-type must be application/json')
  }
  const declaredLength = Number(req.headers['content-length'] ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, 'request body is too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new HttpError(413, 'request body is too large')
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (body === '' && allowEmpty) return undefined
  try {
    return JSON.parse(body)
  } catch {
    throw new HttpError(400, 'request body must be valid JSON')
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
}
