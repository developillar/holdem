# ROYALE — authoritative multiplayer server

A single Node process that hosts the whole lobby: 48 rooms across six stakes ×
two variants (NLHE, PLO4) × three formats (cash, sit-and-go, bomb pot), a
WebSocket endpoint and an HTTP health endpoint.

The client is designed so this server is **optional**. A static deploy with no
backend is a complete poker game — `src/net/offline.ts` transparently falls
back to the in-process engine. When the server *is* reachable it takes over,
and the UI does not know the difference: both transports emit exactly the same
`src/core/bus.ts` events.

---

## Running it

```bash
npm run server                  # node --experimental-strip-types server/index.ts
PORT=9000 npm run server        # different port
ROYALE_LOG=pretty npm run server            # human-readable logs
ROYALE_LOG_LEVEL=debug npm run server       # everything
```

| Env | Default | Meaning |
|---|---|---|
| `PORT` / `ROYALE_PORT` | `8787` | TCP port |
| `HOST` | `0.0.0.0` | bind address |
| `ROYALE_LOG` | *(json)* | `pretty` for coloured one-line logs |
| `ROYALE_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Endpoints:

| Path | |
|---|---|
| `GET /health` | JSON liveness: uptime, connections, tables, frame counters |
| `GET /lobby` | current lobby rows, for smoke tests and dashboards |
| `WS /ws` | the game protocol |

The client finds the server automatically on `localhost` (`ws://<host>:8787/ws`),
or you can point it anywhere:

```
http://localhost:5173/?ws=ws://192.168.1.20:8787/ws
```

On a non-local hostname the client assumes **no server** and stays offline —
a production static host never generates a failed connection or console noise.
Set `globalThis.__ROYALE_WS__` in the host page to override that.

Node 22 runs the TypeScript directly via `--experimental-strip-types`, so
everything here is type-strippable: no `enum`, no namespaces, no parameter
properties, and every type-only import is written `import type`.

### File map

| File | |
|---|---|
| `index.ts` | sockets, identity, rate limits, heartbeat, health, shutdown |
| `tables.ts` | room registry, lobby feed, matchmaking, the shared heartbeat |
| `room.ts` | one authoritative table: rules, clock, seats, bots, broadcast |
| `poker.ts` | evaluator, side pots, distribution, legal-action derivation |
| `bots.ts` | AI seats — the client engine if it loads, an internal policy if not |
| `protocol.ts` | wire types, runtime validation, delta codec (shared with the client) |
| `log.ts` | structured logging |

---

## Protocol

Transport is WebSocket carrying UTF-8 JSON, one message per frame, `t` as the
discriminant. `protocol.ts` is imported by **both** sides, so the definitions
below cannot drift from the code.

### Client → server

The eight messages of `ClientMsg` in `src/core/types.ts` are implemented
verbatim:

| `t` | payload | |
|---|---|---|
| `hello` | `name, avatarId, token?` | first message on every connection |
| `join` | `tableId, seat?, buyIn` | sit down (idempotent — safe to resend) |
| `leave` | — | stand up and cash out |
| `act` | `kind, amount, handId, seq` | `amount` is a **total street commitment** |
| `react` | `kind, targetSeat` | |
| `chat` | `text` | |
| `sitout` | `on` | |
| `ping` | `ts` | echoed back in `pong` |

Plus six additive extensions the core union does not cover:

| `t` | payload | |
|---|---|---|
| `lobby` | `sub` | subscribe / unsubscribe to lobby pushes |
| `quickseat` | `stakeId, variant, format, buyIn` | matchmaking |
| `resync` | — | request a full snapshot |
| `timebank` | — | spend the time bank on the current decision |
| `rebuy` | `amount` | top up (cash only) |
| `bye` | — | clean disconnect |

### Server → client

`ServerMsg` verbatim — `welcome`, `state`, `delta`, `action`, `deal`,
`showdown`, `react`, `chat`, `error`, `pong` — plus the narrative stream the
renderer animates from: `lobby`, `seated`, `waitlist`, `left`, `hand`
(`phase: 'start' | 'end'`), `hole`, `turn`, `pot`, `collect`, `award`, `muck`,
`reject`, `sys`.

`src/net/client.ts` maps each of these onto the bus event the local engine
already emits, which is why no screen imports anything from `src/net/*`.

### Compaction

A full `TableState` is ~3 KB of JSON and the tick rate is 10 Hz, so state goes
out as **per-client deltas**:

* the server keeps the last state it sent *to each client* and diffs against it
* changed fields are keyed by two-character wire codes (`sk` = stack,
  `cm` = committed, `hc` = holeCards, …)
* `applyPatch()` on the client is the exact inverse

A typical tick is 40–150 bytes. Two changes deliberately do **not** count as
news: the tick counter, and sub-second movement of the action clock. Without
that rule the channel would be a firehose that never idles and would drive a
full renderer sync ten times a second on a table where nothing happened. In
practice it cuts `table:state` emissions by ~6×.

Clients receive a full snapshot on join, on `resync`, and immediately before
every showdown (so the revealed hole cards are in hand before the reveal
animation is asked to run).

---

## Security model

### 1. The server is the only thing that knows the deck

Clients send *intents*. The room owns the shuffle (two independent
Fisher-Yates passes from a crypto-seeded generator), the deal, the betting
rules, the pots and the showdown. Nothing a client says is ever taken as fact.

### 2. Hole cards are filtered per player, at the boundary

`Room.viewFor(seat)` is the **only** function that turns internal state into a
`TableState`, and it copies `holeCards` for exactly two cases:

* the recipient's own seat
* a seat that has voluntarily shown down (`shown && !mucked`)

There is no code path that serializes `Seat.holeCards` directly. Deltas are
computed *from* filtered views, so a delta cannot leak what a snapshot would
not have. Deal-time messages are per-recipient: your own card arrives as
`{t:'hole', cards:[17]}`, everyone else's as `{t:'hole', cards:[]}` — the
client is told a card was dealt, not which one.

**Mucked hands are never transmitted.** A player who loses at showdown and
declines to show has their cards cleared at hand end without ever crossing the
socket. The client renders a stable placeholder face for hidden cards; the true
card replaces it only when the server reveals it.

The legal action set is also filtered: `{t:'turn'}` carries `legal: []` for
every recipient except the seat that has to act, so the wire never advertises
another player's options or stack-derived limits.

### 3. Every action is re-validated

`legalActions()` derives the legal set from server state at the moment the
action arrives — not from the set that was shipped to the client. An action
must match by kind, and a bet/raise amount must fall inside the derived
`[min, max]` band or it is clamped into it. Anything outside is rejected with
`{t:'reject'}`, which the client uses to roll back its optimistic prediction,
and logged as `action.illegal` with the full legal set for forensics.

Out-of-turn and stale-hand actions are rejected the same way. Amounts are
`total street commitment`, so a replayed packet cannot double-bet.

### 4. Nothing on the wire is trusted

`decodeClient()` checks the frame size (8 KB cap), parses, checks the
discriminant, then checks every field's type, range and length. Unknown `t`
values are dropped, never coerced. `decodeServer()` does the same in the other
direction — a corrupted or hostile frame must not be able to hand the renderer
a malformed `TableState`, because the whole UI reads that object without
further guards.

Names and chat pass through `sanitizeText()`, which strips control characters
and the zero-width / bidi-override codepoints used for display spoofing.

### 5. Identity

`hello` issues a 128-bit random player id (`p_…`) which doubles as the resume
token. It is only ever sent to the client that owns it, and reconnecting with
it adopts the reserved seat. This is deliberately demo-grade: **a real deploy
should replace it with a signed token from an auth service** — the swap point
is the `hello` case in `index.ts`.

### 6. Abuse controls

| | |
|---|---|
| Connection flood | 60 frames/sec per socket, then `1008` close |
| Chat | 4 messages / 12 s, token bucket |
| Reactions | 8 / 8 s |
| Profanity | leetspeak-normalised match, masked not dropped, logged |
| Idle | 3 clock expiries → sat out; 5 → removed from the seat |
| Dead sockets | ping every 15 s, terminate after 45 s of silence |
| Backpressure | deltas and lobby pushes are dropped above 512 KB buffered |

**Collusion signal.** The room records every confrontation where seat A faced
aggression from seat B and either folded or continued. Once a human pair has
20+ confrontations with an ≥85 % fold rate in one direction, it logs
`security.collusion-signal` with the counts. This is a *signal for review*, not
an enforcement action — chip dumping and soft play need human adjudication, and
an automatic ban on a heuristic this cheap would punish nits.

### 7. What the server does *not* do

Deliberate non-goals, so nobody mistakes this for a money-handling system:

* no persistence — stacks live in memory and die with the process
* no wallet, no settlement, no anti-money-laundering
* no TLS termination (put it behind a reverse proxy)
* no horizontal scaling — one process owns all rooms

---

## Rooms

A room only runs a real game when a human is in it. With nobody watching, its
bot floor drops to zero and it goes dormant — otherwise 48 simultaneous poker
games would burn CPU for an empty lobby. The lobby row stays alive: dormant
tables report a seeded, slowly-drifting population model so the list breathes.
The instant somebody sits, the room wakes, backfills AI opponents and the
numbers become measurements.

* **Seats** — join, buy-in clamped to the stake band, sit-out, waitlist when
  full, and a 60 s reserved seat on disconnect. A disconnected player gets a
  2.5 s clock instead of 15 s so the table does not stall.
* **Clock** — 15 s base, plus a 30 s time bank that regenerates 2 s a hand up
  to 60 s. Expiry checks first: if checking is free the seat checks, otherwise
  it folds.
* **Bots** — `src/engine/bots.ts` is loaded dynamically at boot. If it loads
  (the normal case) online opponents are the same opponents as offline. If it
  does not, an internal policy takes over that respects pot odds, position,
  board texture and stack depth. Every engine call is individually wrapped, so
  one bad decision falls back for that decision only.
* **Rake** — 5 % capped at 3 bb, flop-seen only, cash formats only.
* **Bomb pots** — every 14th hand on cash tables, every hand on bomb tables:
  a 2 bb ante from everyone, no blinds, straight to the flop.
* **Sit-and-go** — 1500 starting chips, a 14-level blind ladder on 4-minute
  levels, 50/30/20 payouts, and a fresh tournament seeded when one ends.
