import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'

export type Bindings = {
  /** Upstream Walrus aggregator base URL, e.g. https://aggregator.walrus.example */
  WALRUS_AGGREGATOR_URL: string
  /** Secret used to authorize the administrative Workers Cache purge endpoint. */
  KORI_ADMIN_TOKEN?: string
  /** Limits requests that would otherwise reach the upstream aggregator. */
  UPSTREAM_RATE_LIMITER: RateLimit
  /** Adds the producing Worker version to cache tags for targeted rollback purges. */
  CF_VERSION_METADATA: WorkerVersionMetadata
}

type AppEnv = { Bindings: Bindings }
type AppContext = Context<AppEnv>

type CachePolicy = {
  browser: string
  edge: string
}

type ReadRoute =
  | { kind: 'cache'; policy: CachePolicy; tags: string[] }
  | { kind: 'passthrough' }
  | { kind: 'invalid'; message: string }
  | null

const IMMUTABLE_CACHE: CachePolicy = {
  // Browser caches are deliberately bounded: an edge purge cannot recall bytes
  // already retained by a client.
  browser: 'public, max-age=86400, immutable',
  // Content-addressed bytes can remain at Cloudflare for a year. Explicitly
  // bound stale-on-error so a broken deployment cannot be hidden indefinitely.
  edge:
    'public, max-age=31536000, stale-while-revalidate=2592000, stale-if-error=2592000, immutable',
}

const MUTABLE_CACHE: CachePolicy = {
  browser: 'public, max-age=60',
  edge: 'public, max-age=300, stale-if-error=300',
}

const ADMIN_PURGE_PATH = '/_kori/admin/cache/purge'
const MAX_PATH_LENGTH = 2048
const MAX_QUERY_LENGTH = 8192
const MAX_IDENTIFIER_LENGTH = 512
const MAX_CONCAT_IDS = 100
const MAX_PURGE_BODY_BYTES = 16 * 1024
const MAX_PURGE_ITEMS = 100

const BLOB_ID = /^[A-Za-z0-9_-]{1,256}$/
const OBJECT_ID = /^0x[0-9a-fA-F]{64}$/
const BOOLEAN_VALUE = /^(?:true|false)$/
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/
const PRINTABLE_CACHE_TAG = /^[\x21-\x7E]{1,1024}$/

const app = new Hono<AppEnv>()

// Workers Cache applies heuristic TTLs when Cache-Control is absent. Default
// every response to no-store; explicitly cacheable proxy responses override
// both the client-facing and Cloudflare-only policies below.
app.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('cache-control')) {
    c.res.headers.set('cache-control', 'no-store')
  }
  if (!c.res.headers.has('cloudflare-cdn-cache-control')) {
    c.res.headers.set('cloudflare-cdn-cache-control', 'no-store')
  }
  c.res.headers.delete('cdn-cache-control')
})

// Bound request shape before routing or touching the upstream.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  if (url.pathname.length > MAX_PATH_LENGTH || url.search.length > MAX_QUERY_LENGTH) {
    return c.text('Request URI too long\n', 414)
  }
  await next()
})

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'OPTIONS'],
    allowHeaders: ['content-type', 'range', 'accept'],
    exposeHeaders: [
      'content-type',
      'content-length',
      'etag',
      'cf-cache-status',
      'retry-after',
    ],
  }),
)

// Collapse harmless alternate cache keys without contacting the aggregator.
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return next()
  }

  const url = new URL(c.req.url)
  let redirect = false

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '')
    redirect = true
  }

  const originalQuery = url.searchParams.toString()
  url.searchParams.sort()
  if (url.searchParams.toString() !== originalQuery) {
    redirect = true
  }

  if (redirect) {
    return c.redirect(url.toString(), 308)
  }

  await next()
})

app.get('/', (c) => c.text('kori — Walrus aggregator proxy\n'))

// Purges are always uncached because Workers Cache only caches GET and HEAD.
// Keeping this inside Kori lets the same Worker invalidate its private cache.
app.post(ADMIN_PURGE_PATH, async (c) => {
  if (!c.env.KORI_ADMIN_TOKEN) {
    return c.json({ error: 'Cache purge is not configured' }, 503)
  }
  if (c.req.header('authorization') !== `Bearer ${c.env.KORI_ADMIN_TOKEN}`) {
    c.header('WWW-Authenticate', 'Bearer')
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const contentLength = Number(c.req.header('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_PURGE_BODY_BYTES) {
    return c.json({ error: 'Request body too large' }, 413)
  }
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'Content-Type must be application/json' }, 415)
  }

  let input: unknown
  try {
    const body = await c.req.text()
    if (new TextEncoder().encode(body).byteLength > MAX_PURGE_BODY_BYTES) {
      return c.json({ error: 'Request body too large' }, 413)
    }
    input = JSON.parse(body)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = parsePurgeRequest(input)
  if ('error' in parsed) {
    return c.json({ error: parsed.error }, 400)
  }

  const cache = c.executionCtx.cache
  if (!cache) {
    return c.json({ error: 'Workers Cache purge is unavailable' }, 503)
  }

  const result = await cache.purge(parsed.options)
  if (!result.success) {
    console.error('Workers Cache purge failed', result.errors)
    return c.json({ error: 'Cache purge failed', details: result.errors }, 502)
  }

  return c.json({ success: true })
})

// Kori is read-only apart from its authenticated cache administration route.
app.put('*', (c) => {
  const path = new URL(c.req.url).pathname
  if (path === '/v1/blobs' || path === '/v1/quilts') {
    return c.text('kori is read-only — use a Walrus publisher directly\n', 403)
  }
  return c.text('Not found\n', 404)
})
app.post('*', (c) => c.text('Not found\n', 404))
app.delete('*', (c) => c.text('Not found\n', 404))
app.patch('*', (c) => c.text('Not found\n', 404))

app.get('*', async (c) => {
  const route = matchReadRoute(new URL(c.req.url))
  if (!route) {
    return c.text('Not found\n', 404)
  }
  if (route.kind === 'invalid') {
    return c.text(`${route.message}\n`, 400)
  }
  if (route.kind === 'cache') {
    return cachedFetch(c, route.policy, route.tags)
  }
  return passthrough(c)
})

/**
 * Fetch an upstream response and mark successful responses for Workers Cache.
 *
 * The cache sits in front of this Worker. On a hit this function never runs;
 * on a miss the upstream limiter is consulted and Cloudflare stores a
 * successful response according to Cloudflare-CDN-Cache-Control.
 */
async function cachedFetch(
  c: AppContext,
  policy: CachePolicy,
  resourceTags: string[],
): Promise<Response> {
  const limited = await enforceUpstreamRateLimit(c)
  if (limited) return limited

  const upstreamRes = await fetch(upstreamUrl(c.env, c.req.url))
  if (!upstreamRes.ok) {
    return rewriteNoStore(upstreamRes)
  }

  return rewriteCachePolicy(upstreamRes, policy, [
    'kori',
    `v:${c.env.CF_VERSION_METADATA.id}`,
    ...resourceTags,
  ])
}

/** No-cache passthrough used for health and streaming routes. */
async function passthrough(c: AppContext): Promise<Response> {
  const limited = await enforceUpstreamRateLimit(c)
  if (limited) return limited

  const headers = new Headers()
  const range = c.req.header('range')
  if (range) headers.set('range', range)

  const upstreamRes = await fetch(upstreamUrl(c.env, c.req.url), { headers })
  return rewriteNoStore(upstreamRes)
}

async function enforceUpstreamRateLimit(c: AppContext): Promise<Response | null> {
  // Kori is anonymous, so Cloudflare's trusted connecting-IP header is the only
  // stable actor key available. The fallback groups non-Cloudflare local tests.
  const key = c.req.header('cf-connecting-ip') ?? 'unknown'
  const { success } = await c.env.UPSTREAM_RATE_LIMITER.limit({ key })
  if (success) return null

  return new Response('Too many cache misses; retry later\n', {
    status: 429,
    headers: {
      'cache-control': 'no-store',
      'cloudflare-cdn-cache-control': 'no-store',
      'retry-after': '60',
    },
  })
}

function upstreamUrl(env: Bindings, reqUrl: string): string {
  const request = new URL(reqUrl)
  const upstream = new URL(env.WALRUS_AGGREGATOR_URL)
  upstream.pathname = request.pathname
  upstream.search = request.search
  return upstream.toString()
}

function rewriteCachePolicy(
  response: Response,
  policy: CachePolicy,
  cacheTags: string[],
): Response {
  const headers = sanitizedHeaders(response)
  headers.set('cache-control', policy.browser)
  headers.set('cloudflare-cdn-cache-control', policy.edge)
  headers.set('cache-tag', [...new Set(cacheTags)].join(','))
  return new Response(response.body, { status: response.status, headers })
}

function rewriteNoStore(response: Response): Response {
  const headers = sanitizedHeaders(response)
  headers.set('cache-control', 'no-store')
  headers.set('cloudflare-cdn-cache-control', 'no-store')
  headers.delete('cache-tag')
  return new Response(response.body, { status: response.status, headers })
}

function sanitizedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  headers.delete('cdn-cache-control')
  headers.delete('cloudflare-cdn-cache-control')
  return headers
}

function matchReadRoute(url: URL): ReadRoute {
  const { pathname, searchParams } = url
  let match: RegExpMatchArray | null

  match = pathname.match(/^\/v1\/blobs\/([^/]+)\/byte-range$/)
  if (match) {
    const blobId = match[1]!
    const idError = validateBlobId(blobId)
    const queryError =
      validateAllowedQuery(searchParams, ['start', 'length'], ['start', 'length']) ??
      validateUnsignedInteger(searchParams.get('start')!, 'start', true) ??
      validateUnsignedInteger(searchParams.get('length')!, 'length', false)
    if (idError || queryError) return invalid(idError ?? queryError!)
    return cacheRoute(IMMUTABLE_CACHE, [`blob:${blobId}`])
  }

  match = pathname.match(/^\/v1\/blobs\/by-quilt-patch-id\/([^/]+)$/)
  if (match) {
    const patchId = match[1]!
    const error =
      validateBlobId(patchId, 'quilt patch ID') ?? validateAllowedQuery(searchParams, [])
    if (error) return invalid(error)
    return cacheRoute(IMMUTABLE_CACHE, [`quilt-patch:${patchId}`])
  }

  match = pathname.match(/^\/v1\/blobs\/by-quilt-id\/([^/]+)\/([^/]+)$/)
  if (match) {
    const quiltId = match[1]!
    const identifier = decodeSegment(match[2]!)
    const error =
      validateBlobId(quiltId, 'quilt ID') ??
      validateIdentifier(identifier, 'quilt identifier') ??
      validateAllowedQuery(searchParams, [])
    if (error) return invalid(error)
    return cacheRoute(IMMUTABLE_CACHE, [`quilt:${quiltId}`])
  }

  match = pathname.match(/^\/v1\/quilts\/([^/]+)\/patches$/)
  if (match) {
    const quiltId = match[1]!
    const error =
      validateBlobId(quiltId, 'quilt ID') ?? validateAllowedQuery(searchParams, [])
    if (error) return invalid(error)
    return cacheRoute(IMMUTABLE_CACHE, [`quilt:${quiltId}`])
  }

  if (pathname === '/v1alpha/blobs/concat') {
    const error =
      validateAllowedQuery(
        searchParams,
        ['ids', 'skip_consistency_check', 'strict_consistency_check'],
        ['ids'],
      ) ?? validateReadOptions(searchParams)
    if (error) return invalid(error)

    const ids = searchParams.get('ids')!.split(',')
    if (ids.length > MAX_CONCAT_IDS) {
      return invalid(`ids must contain at most ${MAX_CONCAT_IDS} values`)
    }
    if (ids.some((id) => validateWalrusReadId(id))) {
      return invalid('ids contains an invalid blob or object ID')
    }

    return cacheRoute(
      IMMUTABLE_CACHE,
      ids.map((id) => (OBJECT_ID.test(id) ? `object:${id.toLowerCase()}` : `blob:${id}`)),
    )
  }

  match = pathname.match(/^\/v1\/blobs\/by-object-id\/([^/]+)$/)
  if (match) {
    const objectId = match[1]!
    const error =
      validateObjectId(objectId) ??
      validateAllowedQuery(searchParams, [
        'skip_consistency_check',
        'strict_consistency_check',
      ]) ??
      validateReadOptions(searchParams)
    if (error) return invalid(error)
    return cacheRoute(MUTABLE_CACHE, [`object:${objectId.toLowerCase()}`])
  }

  match = pathname.match(/^\/v1alpha\/blobs\/([^/]+)\/stream$/)
  if (match) {
    const blobId = match[1]!
    const error =
      validateBlobId(blobId) ??
      validateAllowedQuery(searchParams, [
        'skip_consistency_check',
        'strict_consistency_check',
      ]) ??
      validateReadOptions(searchParams)
    if (error) return invalid(error)
    return { kind: 'passthrough' }
  }

  if (pathname === '/status') {
    const error = validateAllowedQuery(searchParams, [])
    return error ? invalid(error) : { kind: 'passthrough' }
  }

  match = pathname.match(/^\/v1\/blobs\/([^/]+)$/)
  if (match) {
    const blobId = match[1]!
    const error =
      validateBlobId(blobId) ??
      validateAllowedQuery(searchParams, [
        'skip_consistency_check',
        'strict_consistency_check',
      ]) ??
      validateReadOptions(searchParams)
    if (error) return invalid(error)
    return cacheRoute(IMMUTABLE_CACHE, [`blob:${blobId}`])
  }

  return null
}

function cacheRoute(policy: CachePolicy, tags: string[]): ReadRoute {
  return { kind: 'cache', policy, tags }
}

function invalid(message: string): ReadRoute {
  return { kind: 'invalid', message }
}

function validateAllowedQuery(
  params: URLSearchParams,
  allowed: string[],
  required: string[] = [],
): string | null {
  const allowedSet = new Set(allowed)
  for (const key of params.keys()) {
    if (!allowedSet.has(key)) return `Unknown query parameter: ${key}`
    if (params.getAll(key).length > 1) return `Query parameter may only appear once: ${key}`
  }
  for (const key of required) {
    if (!params.has(key) || params.get(key) === '') return `Missing query parameter: ${key}`
  }
  return null
}

function validateReadOptions(params: URLSearchParams): string | null {
  const strict = params.get('strict_consistency_check')
  const skip = params.get('skip_consistency_check')

  if (strict !== null && !BOOLEAN_VALUE.test(strict)) {
    return 'strict_consistency_check must be true or false'
  }
  if (skip !== null && !BOOLEAN_VALUE.test(skip)) {
    return 'skip_consistency_check must be true or false'
  }
  if (strict === 'true' && skip === 'true') {
    return 'strict_consistency_check and skip_consistency_check cannot both be true'
  }
  return null
}

function validateUnsignedInteger(
  value: string,
  name: string,
  allowZero: boolean,
): string | null {
  if (!UNSIGNED_INTEGER.test(value) || value.length > 20) {
    return `${name} must be an unsigned integer`
  }
  if (!allowZero && BigInt(value) === 0n) {
    return `${name} must be greater than zero`
  }
  return null
}

function validateBlobId(value: string, name = 'blob ID'): string | null {
  return BLOB_ID.test(value) ? null : `Invalid ${name}`
}

function validateObjectId(value: string): string | null {
  return OBJECT_ID.test(value) ? null : 'Invalid object ID'
}

function validateWalrusReadId(value: string): string | null {
  return validateBlobId(value) && validateObjectId(value)
}

function validateIdentifier(value: string | null, name: string): string | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return `Invalid ${name}`
  }
  return null
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function parsePurgeRequest(
  input: unknown,
): { options: CachePurgeOptions } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Body must be a JSON object' }
  }

  const body = input as Record<string, unknown>
  const allowedKeys = new Set(['tags', 'pathPrefixes', 'purgeEverything'])
  const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key))
  if (unknownKey) return { error: `Unknown purge option: ${unknownKey}` }

  const modes = [
    body.tags !== undefined,
    body.pathPrefixes !== undefined,
    body.purgeEverything !== undefined,
  ].filter(Boolean).length
  if (modes !== 1) {
    return { error: 'Specify exactly one of tags, pathPrefixes, or purgeEverything' }
  }

  if (body.tags !== undefined) {
    if (
      !Array.isArray(body.tags) ||
      body.tags.length === 0 ||
      body.tags.length > MAX_PURGE_ITEMS ||
      body.tags.some((tag) => typeof tag !== 'string' || !PRINTABLE_CACHE_TAG.test(tag))
    ) {
      return { error: `tags must contain 1-${MAX_PURGE_ITEMS} printable ASCII values` }
    }
    return { options: { tags: [...new Set(body.tags as string[])] } }
  }

  if (body.pathPrefixes !== undefined) {
    if (
      !Array.isArray(body.pathPrefixes) ||
      body.pathPrefixes.length === 0 ||
      body.pathPrefixes.length > MAX_PURGE_ITEMS ||
      body.pathPrefixes.some(
        (prefix) =>
          typeof prefix !== 'string' ||
          !prefix.startsWith('/') ||
          prefix.length > MAX_PATH_LENGTH ||
          prefix.includes('?') ||
          prefix.includes('#'),
      )
    ) {
      return {
        error: `pathPrefixes must contain 1-${MAX_PURGE_ITEMS} absolute paths without queries or fragments`,
      }
    }
    return {
      options: { pathPrefixes: [...new Set(body.pathPrefixes as string[])] },
    }
  }

  if (body.purgeEverything !== true) {
    return { error: 'purgeEverything must be true' }
  }
  return { options: { purgeEverything: true } }
}

export default app
