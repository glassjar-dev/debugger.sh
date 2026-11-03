<p align="center">
  <a href="https://debugger.sh">
    <img alt="debugger.sh" src="assets/logo.png" width="280" />
  </a>
</p>

A browser IDE for C++, Python, and Rust built on top of <a href="https://github.com/debugger-sh/engine">debugger-sh</a>

## Running locally

> Requires [Node](https://nodejs.org/)

```bash
npm install
npm run dev:api   # share + telemetry API on :8787, with a local R2 bucket
npm run dev       # IDE on :3000; proxies /api to :8787
```

Open [localhost:3000](http://localhost:3000). The IDE works without `dev:api`; only sharing and telemetry need it.

`npm run preview` builds the static export and serves it together with the API, as in production.

## API

`worker/index.ts` is a Cloudflare Worker that handles `/api/*`; everything else is served from the static export in `out/`. Data lives in one R2 bucket:

| Route | Stores |
|---|---|
| `POST /api/share`, `GET /api/share/:id` | `shares/<id>.json` |
| `POST /api/events` | `events/dt=YYYY-MM-DD/HH/<flushed_ms>-<uuid>.ndjson` |

Only the IDE's own pages can write: `POST`s must be `application/json` and same-origin.

### Cost limits

R2 bills writes past 1M a month, with no spending cap of its own, so the Worker enforces one:

- **Daily write budget.** Every R2 write goes through the `DataGate` Durable Object (`worker/gate.ts`), which allows `R2_DAILY_WRITE_LIMIT` writes per UTC day (30,000 in `wrangler.jsonc`). Past that, shares return 503 until midnight UTC and telemetry waits in the buffer.
- **Batched telemetry.** Events are buffered in `DataGate` and written as one object a minute, however many people are using the IDE. Browsers send every 10 seconds.
- **Oversized events** (over 256 KiB as one JSON line) are replaced by a `telemetry_dropped` event that records the original event name and size.
- **Workers Free** stops the Worker at 100k requests a day across the account, which is a final backstop; static assets don't count.

### Deploying

Create the bucket and expire telemetry after 90 days, once:

```bash
npx wrangler r2 bucket create glassjar-data
npx wrangler r2 bucket lifecycle add glassjar-data expire-events events/ --expire-days 90
```

Then `npm run build && npx wrangler deploy`. Shares are cached for an hour; to take one down, delete `shares/<id>.json` and purge `/api/share/<id>` from the cache.
