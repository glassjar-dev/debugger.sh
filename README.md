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
| `POST /api/events` | `events/dt=YYYY-MM-DD/HH/<received_ms>-<uuid>.ndjson` |
