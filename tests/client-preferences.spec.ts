import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPreferences } from '../src/client/preferences.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'
import { validatePreferences } from '../src/validation.ts'

afterEach(() => vi.unstubAllGlobals())

describe('stored notification preferences', () => {
  it('keeps legacy event choices when bodyMode and subagentRuns are absent', () => {
    const stored = { turnCompleted: false, turnFailed: true, approval: false, question: true }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(stored) })

    const expected = { ...stored, bodyMode: 'full', subagentRuns: false }
    expect(readPreferences()).toEqual(expected)
    expect(validatePreferences(stored)).toEqual(expected)
  })

  it.each([
    null,
    [],
    { ...DEFAULT_NOTIFICATION_PREFERENCES, question: undefined },
    { ...DEFAULT_NOTIFICATION_PREFERENCES, bodyMode: 'preview' },
    { ...DEFAULT_NOTIFICATION_PREFERENCES, subagentRuns: 'yes' },
  ])('defaults malformed local preferences while the server rejects them: %j', (stored) => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(stored) })
    expect(readPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    expect(() => validatePreferences(stored)).toThrow(/preferences/)
  })

  it.each([null, '{'])('defaults absent or unreadable local JSON: %s', (stored) => {
    vi.stubGlobal('localStorage', { getItem: () => stored })
    expect(readPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
  })
})
