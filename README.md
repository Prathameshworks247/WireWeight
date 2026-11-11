# WireWeight — JSON vs Protocol Buffers

A small but *real* application — the "watch your driver on a map" feature — built once
with **JSON** and once with **Protocol Buffers**, so the difference in **payload size**
and **latency** is measurable instead of hand-wavy.

The application code is identical for both formats. Only [`src/codec.js`](src/codec.js)
changes, selected with an env var:

```bash
FORMAT=json   node src/server.js
FORMAT=proto  node src/server.js
```

---

## What it does

```
 driver phone                 ingest + relay server              customer app
 (driver-sim.js)                   (server.js)                   (in driver-sim)
      │                                 │                              │
      │  LocationPing  every ~2s        │                              │
      ├────────────────────────────────▶│  decode, store, re-encode    │
      │        (52 B proto / 159 B json)│                              │
      │                                 │   TrackUpdate                │
      │                                 ├─────────────────────────────▶│
      │                                 │                              │  draw dot,
      │                                 │  on trip end: write Trip      │  show ETA
      │                                 │  to  trips/*.pb | *.json      │
```

* **`LocationPing`** — the hot message: GPS fix sent thousands of times per delivery.
* **`TrackUpdate`** — server → customer, current position + sequence + ETA.
* **`Trip`** — the whole delivery persisted to disk when it ends (`repeated LocationPing`).

Schema: [`proto/tracking.proto`](proto/tracking.proto).
Why it's written that way: [`PROTO_GUIDE.md`](PROTO_GUIDE.md).

---

## Quick start

```bash
npm install

# 1. the headline numbers, no servers needed
npm run bench

# 2. see it live — two terminals
FORMAT=proto node src/server.js
FORMAT=proto node src/driver-sim.js      # streams the route, prints RTT + bytes

# 3. same thing with JSON, compare
FORMAT=json node src/server.js
FORMAT=json node src/driver-sim.js

# 4. make the size difference show up as latency: throttle the link
LINK_KBPS=32 LINK_RTT_MS=80 FORMAT=json  node src/server.js
LINK_KBPS=32 LINK_RTT_MS=80 FORMAT=json  node src/driver-sim.js
#   ...then repeat with FORMAT=proto

# 5. compare stored trip size on disk
ls -lh trips/
```

---

## Results

Measured on this machine — Node v20.19.0, Apple Silicon. Regenerate anytime with
`npm run bench`. A "ping" here has 9 fields: `delivery_id, driver_id, lat, lng,
heading, speed_mps, ts, status, accuracy_m`.

### 1. Payload size

| Message | JSON raw | Protobuf raw | JSON gzip | Protobuf gzip |
|---|--:|--:|--:|--:|
| one `LocationPing` | 159 B | **52 B** | 152 B | 75 B |
| one trip (750 pings ≈ 25 min) | 117.2 KB | **39.6 KB** | 13.6 KB | 18.0 KB |

* **Raw, per message: Protobuf is 67% smaller** (52 vs 159 bytes). This is the number
  that matters for a stream of small messages — every ping is its own frame.
* **gzip on a single tiny message makes it *bigger*** (75 > 52): the gzip header/dictionary
  costs ~25 bytes and there's nothing to compress. Per-message compression is a trap
  for small payloads in *either* format.
* **A large JSON batch gzips extremely well** — 117 KB → 13.6 KB — because every record
  repeats the same keys (`"lat":`, `"lng":`, …). The Protobuf trip is already dense, so
  gzip only takes it 39.6 KB → 18.0 KB. **For big, compressible batches over a
  gzip-enabled transport, JSON can end up smaller.** Protobuf's win is on the wire,
  per message, uncompressed.

### 2. CPU — encode / decode (200,000 iterations)

| Operation | JSON | Protobuf | Speedup |
|---|--:|--:|--:|
| encode one ping | 0.924 µs | **0.501 µs** | 1.84× |
| decode one ping | 0.636 µs | **0.332 µs** | 1.92× |
| encode throughput | 1.08 M/s | **1.99 M/s** | |
| decode throughput | 1.57 M/s | **3.01 M/s** | |

Protobuf is ~2× faster both ways here. `V8`'s JSON is heavily optimised C++, so the gap
is smaller than people expect — but it's real, and it grows with message complexity
(nested messages, repeated fields) and in languages without a world-class JSON parser.

### 3. Latency — end-to-end relay RTT (`driver-sim`, p50)

Round trip = encode → uplink → server decode + re-encode → downlink → decode.

| Link | JSON p50 | Protobuf p50 | Difference |
|---|--:|--:|--:|
| localhost, unthrottled | ~0.9 ms | ~1.1 ms | **noise** — bandwidth is infinite, size is invisible |
| `LINK_KBPS=128 LINK_RTT_MS=50` (poor 3G) | 124.6 ms | **109.8 ms** | 15 ms / ~12% faster |
| `LINK_KBPS=32 LINK_RTT_MS=80` (2G / congested) | 249.5 ms | **189.1 ms** | **60 ms / ~24% faster** |

**This is the key lesson about latency:** on a fast local network, choosing Protobuf for
speed is pointless — the two are within noise. The payload-size advantage converts into a
latency advantage **only when the link is slow, metered, congested, or far away** (mobile
devices, cross-region, IoT). The slower the link, the more the 107-byte-per-ping saving
matters.

### 4. Fleet-scale wire volume

500 drivers × 18 trips/day × 750 pings = **6.75 M pings/day**

| | JSON | Protobuf | Saved |
|---|--:|--:|--:|
| ingress / day | 1.07 GB | **0.35 GB** | 0.72 GB |
| ingress / month | 32.2 GB | **10.5 GB** | 21.7 GB (67%) |

Plus the mirror of that on the customer-facing side, plus storage, plus every driver's
metered mobile data.

---

## When the difference is worth it

**Reach for Protocol Buffers when:**
- high-frequency small messages (telemetry, tracking, game state, sensors)
- clients on mobile / metered / high-latency links
- multiple languages sharing one contract (driver app in Kotlin/Swift, backend in Node/Go)
- you want a schema enforced and versioned (gRPC is built on this)
- storage or bandwidth cost scales with your traffic

**Stay on JSON when:**
- request/response with a human in the loop, low volume
- payloads are already large and go over a gzip-enabled HTTP transport
- you need to eyeball traffic in devtools / `curl` without tooling
- the team is small, the API is internal, and a schema + `protoc` step is pure overhead

See [`PROTO_GUIDE.md`](PROTO_GUIDE.md) for the full advantages/disadvantages list and the
do's & don'ts of writing a `.proto` file.

---

## Files

| Path | What |
|---|---|
| `proto/tracking.proto` | the shared schema |
| `src/codec.js` | the only format-aware code — `FORMAT=json\|proto` |
| `src/route.js` | deterministic synthetic GPS route (seeded PRNG) |
| `src/bench.js` | size + CPU benchmark, prints the tables above |
| `src/server.js` | WebSocket ingest + relay + trip persistence |
| `src/driver-sim.js` | fake driver phone; streams route, measures relay RTT |
| `src/link.js` | optional bandwidth/latency simulation (`LINK_KBPS`, `LINK_RTT_MS`) |
| `PROTO_GUIDE.md` | beginner guide + do's/don'ts + pros/cons |
