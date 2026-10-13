import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/**
 * The notification artwork is verified by decoding it, not by trusting whoever
 * exported it. These two files were once a brand-blue whale on a transparent
 * canvas, which read as a second, differently coloured animal beside the app
 * icon in the shade. Nothing pinned that, so it shipped twice.
 *
 * The large icon is now deliberately invisible. Android draws the posting app's
 * own icon in a notification's left slot whether or not the page supplies one, so
 * a visible large icon can only ever add a second animal beside it. It has to
 * remain a valid, correctly sized PNG all the same: Chromium replaces a null or
 * zero-width icon with a grey disc carrying the origin monogram, which would be a
 * third look, and the first case below pins exactly that.
 */

type Png = {
  width: number
  height: number
  at: (x: number, y: number) => [number, number, number, number]
}

/** IHDR + IDAT, the five scanline filters, and a pixel sampler. */
function decodePng(buffer: Buffer): Png {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body.readUInt8(8)
      colorType = body.readUInt8(9)
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`unsupported colour type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const above = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels] : 0
      const up = above[i]
      const corner = i >= channels ? above[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - corner
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - corner)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner
      }
      out[i] = value & 0xff
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const o = y * stride + x * channels
      return [pixels[o], pixels[o + 1], pixels[o + 2], channels === 4 ? pixels[o + 3] : 255]
    },
  }
}

const load = (name: string) => decodePng(readFileSync(new URL(`../public/${name}`, import.meta.url)))
const icon = load('notification-icon.png')
const badge = load('notification-badge.png')

/** The retired artwork: a saturated blue, whichever way it is blended. */
const isBrandBlue = (p: number[]) => p[3] > 128 && p[2] > 140 && p[2] - p[0] > 40 && p[2] - p[1] > 40

describe('notification artwork', () => {
  it('ships a present but invisible large icon, so only the app icon shows', () => {
    // Non-zero dimensions are the load-bearing part: Chromium falls back to the
    // grey origin monogram for a null or zero-width icon, so shrinking this away
    // would trade the second animal for a disc rather than removing it.
    expect(icon.width).toBe(192)
    expect(icon.height).toBe(192)

    // Alpha 1 rather than 0: a fully transparent raster is the obvious thing for
    // an unseen emptiness check to discard, and one step of alpha is invisible.
    expect(icon.at(0, 0)[3]).toBe(1)
    expect(icon.at(96, 96)[3]).toBe(1)

    let visible = 0
    for (let y = 0; y < icon.height; y++) {
      for (let x = 0; x < icon.width; x++) if (icon.at(x, y)[3] > 1) visible++
    }
    expect(visible).toBe(0)
  })

  it('leaves no brand-blue pixel in either asset', () => {
    let blue = 0
    for (const png of [icon, badge]) {
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) if (isBrandBlue(png.at(x, y))) blue++
      }
    }
    expect(blue).toBe(0)
  })

  it('keeps the badge a monochrome silhouette Android can whiten', () => {
    expect(badge.width).toBe(96)
    expect(badge.height).toBe(96)
    // Chrome tints the badge with PorterDuff SRC_ATOP over white, so only the
    // alpha channel survives; a coloured badge loses its shape's contrast.
    let coloured = 0
    for (let y = 0; y < badge.height; y++) {
      for (let x = 0; x < badge.width; x++) {
        const [r, g, b, a] = badge.at(x, y)
        if (a > 8 && (Math.abs(r - g) > 2 || Math.abs(g - b) > 2)) coloured++
      }
    }
    expect(coloured).toBe(0)
  })
})
