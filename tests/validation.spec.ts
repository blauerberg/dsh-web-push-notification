import { describe, expect, it } from 'vitest'
import { validateEndpoint, validateStoreState, validateSubscription } from '../src/validation.ts'

const subscription = {
  endpoint: 'https://push.example.test/send/one',
  expirationTime: null,
  keys: { p256dh: 'AQID', auth: 'BAUG' },
  preferences: { turnCompleted: true, turnFailed: true, approval: true, question: true, bodyMode: 'full' as const },
}

describe('subscription validation', () => {
  it('accepts a browser subscription and normalizes missing expiration time', () => {
    expect(validateSubscription({ endpoint: subscription.endpoint, keys: subscription.keys })).toEqual(subscription)
    expect(validateEndpoint(subscription)).toBe(subscription.endpoint)
  })

  it('accepts the legacy preference record with the default full body mode', () => {
    const value = validateSubscription({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      preferences: { turnCompleted: true, turnFailed: true, approval: true, question: true },
    })
    expect(value.preferences.bodyMode).toBe('full')
  })

  it('rejects insecure endpoints and padded keys', () => {
    expect(() => validateSubscription({ ...subscription, endpoint: 'http://push.example.test/send/one' })).toThrow(
      /HTTPS/,
    )
    expect(() => validateSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'BAUG=' } })).toThrow(
      /auth/,
    )
  })

  it('rejects malformed persisted state and duplicate endpoints', () => {
    expect(() =>
      validateStoreState({
        version: 1,
        vapid: { publicKey: 'AQID', privateKey: 'BAUG' },
        subscriptions: [subscription, subscription],
      }),
    ).toThrow(/duplicate/)
  })
})
