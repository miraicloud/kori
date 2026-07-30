# kori

Kori is a Cloudflare-cached read-only proxy for a Walrus aggregator. Walrus
blobs are content-addressed, so most aggregator responses are effectively
immutable. Kori uses
[Workers Cache](https://developers.cloudflare.com/workers/cache/) in front of
the Worker so repeated reads of the same blob or quilt patch do not execute
Kori or reach the upstream aggregator.

## Design

- Enable Cloudflare's tiered Workers Cache. Requests check a POP-local lower
  tier and then an upper tier that aggregates fills across Cloudflare's
  network. Only a miss in both tiers executes Kori.
- Cache content-addressed routes (blobs, quilt patches, quilt patch listings)
  with `max-age=1y, stale-while-revalidate=30d, immutable`. The bytes are
  cryptographically tied to the URL hash — they're valid forever. The
  aggregator's defaults are conservative because it serves unknown clients;
  Kori knows it's caching content-addressed data and bets on it.
- Let Workers Cache perform stale-while-revalidate and request collapsing.
- Block write endpoints — read-only proxy.
- Pass through health, streaming, and object-attribute routes either
  uncached or with a short TTL.
- Single backend, no racing. Walrus is bandwidth-bound, not RTT-bound.

## Routes

| Pattern | Cache | Notes |
| --- | --- | --- |
| `GET /v1/blobs/:blobId` | 1y + SWR 30d + immutable | Content-addressed |
| `GET /v1/blobs/:blobId/byte-range?start=&length=` | 1y + SWR 30d + immutable | `start`/`length` part of cache key |
| `GET /v1/blobs/by-quilt-patch-id/:patchId` | 1y + SWR 30d + immutable | patch id is a content hash |
| `GET /v1/blobs/by-quilt-id/:quiltId/:identifier` | 1y + SWR 30d + immutable | quilt + identifier are immutable |
| `GET /v1/quilts/:quiltId/patches` | 1y + SWR 30d + immutable | quilt structure is immutable |
| `GET /v1alpha/blobs/concat?ids=...` | 1y + SWR 30d + immutable | `ids` are part of the cache key |
| `GET /v1/blobs/by-object-id/:objectId` | 5min | Sui object attributes can mutate |
| `GET /v1alpha/blobs/:blobId/stream` | passthrough | Streamed; no cache |
| `GET /status` | passthrough | Health |
| `PUT /v1/blobs`, `PUT /v1/quilts` | **403** | Use a publisher directly |

Workers Cache satisfies `Range` requests from the cached full response. A cold
range request fills the cache with the full `200` response, then Cloudflare
returns the requested `206` slice; different ranges share that cache entry.

Cloudflare adds `Cf-Cache-Status` (`HIT`, `MISS`, `UPDATING`, `BYPASS`, and so
on) to responses so callers can see what happened. Kori exposes that header to
browser clients through CORS.

## Configuration

`WALRUS_AGGREGATOR_URL` (env var) — upstream aggregator base URL. Default in
`wrangler.jsonc` points at a public mainnet aggregator. Override per-deploy
in your own wrangler config, or via `.dev.vars` for local development.

Workers Cache requires Wrangler 4.69.0 or newer and this configuration:

```jsonc
"cache": {
  "enabled": true
}
```

External Wrangler configs passed with `--config` replace the in-tree config,
so they must enable `cache` as well.

## Develop & deploy

```sh
bun install
bun test
bun run dev                                          # local on :8787
bun run deploy                                       # deploy with in-tree config
bun run deploy -- --config /path/to/overlay/dir      # deploy with external overlay
```

The `--config <dir>` mode reads `<dir>/wrangler.jsonc` for environment-specific
settings (worker name, custom domain, account, secrets) — useful for keeping
deployment overlays in a separate (private) repo. The deploy script also
sources a `.env` from the overlay dir or its parent into the wrangler env, so
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` work without exporting.

## Future work

- R2 persistence for a durable Walrus availability backstop.
- Admin purge endpoint for takedowns.
- Analytics datapoints (cache status, backend, response size).

## License

Apache-2.0
