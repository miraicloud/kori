import { afterEach, describe, expect, mock, test } from 'bun:test'
import app, { type Bindings } from './index'

const originalFetch = globalThis.fetch

function createEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    WALRUS_AGGREGATOR_URL: 'https://aggregator.example',
    UPSTREAM_RATE_LIMITER: {
      limit: mock(async () => ({ success: true })),
    },
    CF_VERSION_METADATA: {
      id: 'version-123',
      tag: '',
      timestamp: '2026-07-30T00:00:00.000Z',
    },
    ...overrides,
  }
}

function createExecutionContext(
  purge: (options: CachePurgeOptions) => Promise<CachePurgeResult>,
): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    exports: {},
    props: undefined,
    cache: { purge },
  } as unknown as ExecutionContext
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('cache policy', () => {
  test('marks content-addressed responses for Workers Cache', async () => {
    const upstreamFetch = mock(async () => {
      return new Response('blob', { headers: { etag: '"blob-etag"' } })
    })
    globalThis.fetch = upstreamFetch as typeof fetch
    const env = createEnv()

    const res = await app.request(
      'https://kori.example/v1/blobs/blob-id?strict_consistency_check=true',
      { headers: { 'cf-connecting-ip': '192.0.2.1' } },
      env,
    )

    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    expect(upstreamFetch.mock.calls[0]?.[0]).toBe(
      'https://aggregator.example/v1/blobs/blob-id?strict_consistency_check=true',
    )
    expect(env.UPSTREAM_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: '192.0.2.1' })
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable')
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe(
      'public, max-age=31536000, stale-while-revalidate=2592000, stale-if-error=2592000, immutable',
    )
    expect(res.headers.get('cache-tag')).toBe('kori,v:version-123,blob:blob-id')
    expect(res.headers.get('etag')).toBe('"blob-etag"')
    expect(res.headers.has('x-kori-cache')).toBe(false)
  })

  test('uses bounded browser and edge TTLs for mutable object lookups', async () => {
    globalThis.fetch = mock(async () => new Response('attributes')) as typeof fetch
    const objectId = `0x${'a'.repeat(64)}`

    const res = await app.request(
      `https://kori.example/v1/blobs/by-object-id/${objectId}`,
      undefined,
      createEnv(),
    )

    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe(
      'public, max-age=300, stale-if-error=300',
    )
    expect(res.headers.get('cache-tag')).toContain(`object:${objectId}`)
  })

  test('does not cache upstream errors or trust their CDN headers', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('missing', {
          status: 404,
          headers: {
            'cdn-cache-control': 'public, max-age=999',
            'cloudflare-cdn-cache-control': 'public, max-age=999',
            'cache-tag': 'upstream',
          },
        }),
    ) as typeof fetch

    const res = await app.request(
      'https://kori.example/v1/blobs/missing',
      undefined,
      createEnv(),
    )

    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
    expect(res.headers.has('cdn-cache-control')).toBe(false)
    expect(res.headers.has('cache-tag')).toBe(false)
  })

  test('tags concat responses by each constituent resource', async () => {
    globalThis.fetch = mock(async () => new Response('combined')) as typeof fetch
    const objectId = `0x${'b'.repeat(64)}`

    const res = await app.request(
      `https://kori.example/v1alpha/blobs/concat?ids=blob-a%2C${objectId}`,
      undefined,
      createEnv(),
    )

    expect(res.headers.get('cache-tag')).toBe(
      `kori,v:version-123,blob:blob-a,object:${objectId}`,
    )
  })

  test('does not heuristically cache local and not-found responses', async () => {
    const env = createEnv()
    const home = await app.request('https://kori.example/', undefined, env)
    const missing = await app.request('https://kori.example/not-a-route', undefined, env)

    expect(home.headers.get('cache-control')).toBe('no-store')
    expect(home.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
    expect(missing.headers.get('cache-control')).toBe('no-store')
    expect(missing.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
  })
})

describe('request protection', () => {
  test('rejects unknown query parameters before the limiter or upstream', async () => {
    const upstreamFetch = mock(async () => new Response('blob'))
    globalThis.fetch = upstreamFetch as typeof fetch
    const env = createEnv()

    const res = await app.request(
      'https://kori.example/v1/blobs/blob-id?cachebuster=1',
      undefined,
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Unknown query parameter')
    expect(env.UPSTREAM_RATE_LIMITER.limit).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  test('validates required byte-range query parameters', async () => {
    const upstreamFetch = mock(async () => new Response('blob'))
    globalThis.fetch = upstreamFetch as typeof fetch
    const env = createEnv()

    const missing = await app.request(
      'https://kori.example/v1/blobs/blob-id/byte-range?start=0',
      undefined,
      env,
    )
    const zeroLength = await app.request(
      'https://kori.example/v1/blobs/blob-id/byte-range?length=0&start=0',
      undefined,
      env,
    )

    expect(missing.status).toBe(400)
    expect(zeroLength.status).toBe(400)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  test('redirects alternate query ordering and trailing slashes', async () => {
    const env = createEnv()
    const queryOrder = await app.request(
      'https://kori.example/v1/blobs/blob-id?strict_consistency_check=false&skip_consistency_check=false',
      undefined,
      env,
    )
    const trailingSlash = await app.request(
      'https://kori.example/v1/blobs/blob-id/',
      undefined,
      env,
    )

    expect(queryOrder.status).toBe(308)
    expect(queryOrder.headers.get('location')).toBe(
      'https://kori.example/v1/blobs/blob-id?skip_consistency_check=false&strict_consistency_check=false',
    )
    expect(trailingSlash.status).toBe(308)
    expect(trailingSlash.headers.get('location')).toBe(
      'https://kori.example/v1/blobs/blob-id',
    )
  })

  test('rate limits upstream misses without fetching', async () => {
    const upstreamFetch = mock(async () => new Response('blob'))
    globalThis.fetch = upstreamFetch as typeof fetch
    const env = createEnv({
      UPSTREAM_RATE_LIMITER: {
        limit: mock(async () => ({ success: false })),
      },
    })

    const res = await app.request(
      'https://kori.example/v1/blobs/blob-id',
      { headers: { 'cf-connecting-ip': '192.0.2.2' } },
      env,
    )

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  test('rejects oversized request URIs', async () => {
    const res = await app.request(
      `https://kori.example/v1/blobs/blob-id?ids=${'a'.repeat(9000)}`,
      undefined,
      createEnv(),
    )

    expect(res.status).toBe(414)
  })
})

describe('passthrough responses', () => {
  test('forwards Range on uncached routes', async () => {
    const upstreamFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://aggregator.example/v1alpha/blobs/blob-id/stream')
      expect(new Headers(init?.headers).get('range')).toBe('bytes=10-19')
      return new Response('stream')
    })
    globalThis.fetch = upstreamFetch as typeof fetch

    const res = await app.request(
      'https://kori.example/v1alpha/blobs/blob-id/stream',
      { headers: { range: 'bytes=10-19' } },
      createEnv(),
    )

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
  })

  test('exposes Cloudflare cache and rate-limit status through CORS', async () => {
    const res = await app.request(
      'https://kori.example/',
      { headers: { origin: 'https://client.example' } },
      createEnv(),
    )

    expect(res.headers.get('access-control-expose-headers')).toContain('cf-cache-status')
    expect(res.headers.get('access-control-expose-headers')).toContain('retry-after')
  })
})

describe('cache administration', () => {
  test('rejects purge requests without the configured bearer token', async () => {
    const env = createEnv({ KORI_ADMIN_TOKEN: 'secret-token' })
    const res = await app.request(
      'https://kori.example/_kori/admin/cache/purge',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tags: ['blob:blob-id'] }),
      },
      env,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('purges validated resource tags', async () => {
    const purge = mock(async () => ({
      success: true,
      zoneTag: 'worker',
      errors: [],
    }))
    const env = createEnv({ KORI_ADMIN_TOKEN: 'secret-token' })
    const ctx = createExecutionContext(purge)

    const res = await app.request(
      'https://kori.example/_kori/admin/cache/purge',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tags: ['blob:blob-id', 'blob:blob-id'] }),
      },
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(purge).toHaveBeenCalledWith({ tags: ['blob:blob-id'] })
  })

  test('requires exactly one valid purge mode', async () => {
    const purge = mock(async () => ({
      success: true,
      zoneTag: 'worker',
      errors: [],
    }))
    const res = await app.request(
      'https://kori.example/_kori/admin/cache/purge',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tags: ['kori'], purgeEverything: true }),
      },
      createEnv({ KORI_ADMIN_TOKEN: 'secret-token' }),
      createExecutionContext(purge),
    )

    expect(res.status).toBe(400)
    expect(purge).not.toHaveBeenCalled()
  })
})
