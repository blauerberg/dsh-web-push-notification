import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// These assets provide an invisible large icon and a monochrome badge. Changing
// either requires checking their appearance on devices before updating its hash.
it.each([
  ['notification-icon.png', 'f9f5ed04a5c903b4b70c2c7b3a0c632a6bce13505e9e8e9cd3f859cbbd7c6090'],
  ['notification-badge.png', '2a82a327b35dcdfa1bf70be82e60ef1ab9e4eea81d8230b093c6d98be129b841'],
])('preserves the notification artwork in %s', (name, hash) => {
  const bytes = readFileSync(new URL(`../public/${name}`, import.meta.url))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash)
})
