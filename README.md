# Belch

Belch is a browser-based party game app where the host screen runs the room and players use their phones as controllers.

The repo is a Bun workspace with:

- `apps/web`: Solid + Vite client
- `apps/server`: Cloudflare Worker API, WebSocket routing, and Durable Object room state
- `packages/protocol`: shared Zod schemas, message types, game constants, and visibility helpers
- `packages/ui`: shared UI styles
- `tests`: Bun tests for shared protocol behavior

## Requirements

- Bun
- Cloudflare Wrangler, installed through the workspace dependencies

Install dependencies:

```sh
bun install
```

## Development

Run the web app and Worker together:

```sh
bun run dev
```

This starts:

- `bun run dev:server`: `wrangler dev`
- `bun run dev:web`: Vite with `--host`

Useful scripts:

```sh
bun run test
bun run typecheck
bun run build
bun run deploy
```

## App Flow

From the landing page, a host creates a room with `POST /api/room`. The server generates a four-letter room code, stores a host token locally in the browser, and routes the host to:

```txt
/:code/host
```

Guests join with a room code and name at:

```txt
/:code
```

Both host and guest clients connect to:

```txt
/ws/:code
```

The Worker validates the room code and forwards the WebSocket to the room Durable Object.

## Games

Belch currently supports:

- Quiplash-style prompt answers and voting
- Fibbage-style lie submission and truth selection

Game state moves through these phases:

```txt
lobby -> writing -> voting -> reveal -> final
```

The protocol package owns the shared message contracts and redaction helpers so the server can send each viewer only the state they should see.

## Deployment

The Cloudflare Worker is configured in `wrangler.json`.

Deploy with:

```sh
bun run deploy
```

The Worker serves API routes, WebSocket upgrades, Durable Object room state, and static client assets through the configured `ASSETS` binding.
