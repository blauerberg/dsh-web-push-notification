import { describe, expect, it } from 'vitest'
import {
  declaresPreferences,
  validateEndpoint,
  validatePreviousEndpoint,
  validateSettings,
  validateStoreState,
  validateSubscription,
  validateTestRequest,
} from '../src/validation.ts'

const subscription = {
  endpoint: 'https://push.example.test/send/one',
  expirationTime: null,
  keys: { p256dh: 'AQID', auth: 'BAUG' },
  preferences: {
    turnCompleted: true,
    turnFailed: true,
    approval: true,
    question: true,
    subagentRuns: false,
    bodyMode: 'full' as const,
  },
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
    // A device that predates the subagent preference stays quiet about them.
    expect(value.preferences.subagentRuns).toBe(false)
  })

  it('rejects a subagent preference that is not a boolean', () => {
    expect(() =>
      validateSubscription({
        ...subscription,
        preferences: { ...subscription.preferences, subagentRuns: 'yes' },
      }),
    ).toThrow(/preferences/)
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

  it('rejects an endpoint that aims the sender at a private, loopback, or link-local host', () => {
    const rejected = [
      'https://localhost/send/one',
      'https://127.0.0.1/send/one',
      'https://10.1.2.3/send/one',
      'https://172.16.0.9/send/one',
      'https://172.31.255.1/send/one',
      'https://192.168.68.69/send/one',
      'https://169.254.169.254/send/one',
      'https://[::1]/send/one',
      'https://[fd00::1]/send/one',
      'https://printer.local/send/one',
      // A trailing dot is the same name to DNS, and the URL parser keeps it on a
      // name while normalizing it away on a dotted quad.
      'https://localhost./send/one',
      'https://printer.local./send/one',
      // An IPv4-mapped IPv6 literal reaches the same host as the dotted quad.
      'https://[::ffff:127.0.0.1]/send/one',
      'https://[::ffff:169.254.169.254]/send/one',
    ]
    for (const endpoint of rejected) {
      expect(() => validateSubscription({ ...subscription, endpoint }), endpoint).toThrow(/private, loopback/)
    }
  })

  it('reads the endpoint a renewal replaces and whether the request chose preferences', () => {
    expect(validatePreviousEndpoint({ previousEndpoint: 'https://push.example.test/old' })).toBe(
      'https://push.example.test/old',
    )
    expect(validatePreviousEndpoint({})).toBeUndefined()
    expect(validatePreviousEndpoint({ previousEndpoint: null })).toBeUndefined()
    expect(() => validatePreviousEndpoint({ previousEndpoint: 7 })).toThrow(/previous endpoint/)

    expect(declaresPreferences({ preferences: { bodyMode: 'summary' } })).toBe(true)
    expect(declaresPreferences({ previousEndpoint: 'https://push.example.test/old' })).toBe(false)
    expect(declaresPreferences(undefined)).toBe(false)
  })

  it('keeps accepting every real Push service and the public edge of each blocked range', () => {
    const accepted = [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QAbc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      // 172.32 sits just past the end of the 172.16/12 private block.
      'https://172.32.0.1/send/one',
      // A hostname may contain "localhost" without being localhost.
      'https://notlocalhost.example.test/send/one',
    ]
    for (const endpoint of accepted) {
      expect(validateEndpoint({ endpoint }), endpoint).toBe(endpoint)
    }
  })
})

describe('suppression settings', () => {
  const vapid = { publicKey: 'AQID', privateKey: 'BAUG' }

  it('accepts both fields, and reads a persisted policy back', () => {
    expect(validateSettings({ suppressWhileActive: false, idleMinutes: 1 })).toEqual({
      suppressWhileActive: false,
      idleMinutes: 1,
    })
    expect(
      validateStoreState({
        version: 1,
        vapid,
        subscriptions: [],
        settings: { suppressWhileActive: true, idleMinutes: 30 },
      }),
    ).toEqual({
      version: 1,
      vapid,
      subscriptions: [],
      settings: { suppressWhileActive: true, idleMinutes: 30 },
    })
  })

  it('defaults the policy for a state file that predates it', () => {
    expect(validateStoreState({ version: 1, vapid, subscriptions: [] })).toEqual({
      version: 1,
      vapid,
      subscriptions: [],
      settings: { suppressWhileActive: true, idleMinutes: 10 },
    })
  })

  it('rejects a policy it cannot honour, and a persisted one it cannot read', () => {
    const rejected: unknown[] = [
      'quiet',
      {},
      { suppressWhileActive: true },
      { suppressWhileActive: 1, idleMinutes: 5 },
      { suppressWhileActive: true, idleMinutes: '5' },
      { suppressWhileActive: true, idleMinutes: 0 },
      { suppressWhileActive: true, idleMinutes: 2.5 },
      { suppressWhileActive: true, idleMinutes: 61 },
    ]
    for (const value of rejected) {
      expect(() => validateSettings(value), JSON.stringify(value)).toThrow(/suppression/)
    }
    expect(() =>
      validateStoreState({
        version: 1,
        vapid,
        subscriptions: [],
        settings: { suppressWhileActive: true, idleMinutes: 0 },
      }),
    ).toThrow(/idleMinutes/)
  })
})

describe('test notification request', () => {
  it('validates the optional current-device endpoint', () => {
    expect(validateTestRequest({ endpoint: subscription.endpoint }).endpoint).toBe(subscription.endpoint)
    for (const endpoint of ['http://push.example.test/device', 'https://127.0.0.1/device', 42]) {
      expect(() => validateTestRequest({ endpoint })).toThrow()
    }
  })

  it('accepts a bodyless request and rejects values that are not objects', () => {
    expect(validateTestRequest(undefined)).toEqual({})
    expect(validateTestRequest({})).toEqual({})
    expect(() => validateTestRequest('DeepSeek Harness')).toThrow(/must be an object/)
    expect(() => validateTestRequest(['title'])).toThrow(/must be an object/)
  })
})
