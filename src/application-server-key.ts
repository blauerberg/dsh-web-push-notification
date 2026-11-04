export function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const result = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index)
  return result
}
