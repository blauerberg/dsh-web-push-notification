import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('package notices', () => {
  it('ships the notice for code included in the host bundle', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { files?: string[] }
    const notice = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')
    expect(manifest.files).toContain('THIRD_PARTY_NOTICES.md')
    expect(notice).toContain('@deepseek-ai/schemastery')
    expect(notice).toContain('@deepseek-ai/cosmokit')
    expect(notice).toContain('Copyright (c) 2021-present Shigma')
  })
})
