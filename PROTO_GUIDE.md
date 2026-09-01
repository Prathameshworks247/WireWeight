# Writing `.proto` files — a beginner's guide, with do's & don'ts

This is the practical companion to [`proto/tracking.proto`](proto/tracking.proto).
It assumes you have never written a schema file before.

---

## 1. What a `.proto` file actually is

A `.proto` file is **a contract**. It describes the *shape* of your messages —
field names, types, and a number for each field — in a language-neutral way.

You don't ship the `.proto` file to production. You run it through a **compiler**
(`protoc`, or a library like `protobufjs` that reads it at runtime) which
generates real code — classes with getters/setters and two methods that matter:

* `encode(obj)` → a compact binary `Buffer`
* `decode(buffer)` → your object back

The same `.proto` can generate Go, Java, Python, C++, Rust, TypeScript… That's the
"language-neutral" promise: two teams agree on one file and never argue about JSON
key casing again.

### The mental model

| JSON world | Protobuf world |
|---|---|
| shape lives in your head / a wiki / a TypeScript type | shape lives in `*.proto`, version-controlled |
| `JSON.stringify` | generated `encode()` |
| `JSON.parse` | generated `decode()` |
| keys sent as text on every message | keys replaced by 1–2 byte **field numbers** |
| any field can be anything | types are fixed and checked at encode time |

---

## 2. Anatomy of a message

```proto
syntax = "proto3";           // ALWAYS line 1. Use proto3, not proto2.

package tracking;            // namespace — prevents name clashes when files import each other

message LocationPing {       // a message = a struct/record/object
  string delivery_id = 1;   //  type    name          field number
  int32  driver_id   = 2;
  double lat         = 3;
  Status status      = 8;   // messages can contain enums and other messages

  enum Status {
    STATUS_UNSPECIFIED = 0; //  first value MUST be 0 and should mean "not set"
    EN_ROUTE           = 1;
    ARRIVED            = 2;
  }
}
```

### The field number is the important part

`= 1`, `= 2`, `= 8` are **not** default values and **not** array indices. They are
the field's permanent ID on the wire. The binary format stores *field number →
value*, never the field name. That's the whole reason Protobuf messages are small.

Consequences:
* The **name** `delivery_id` is for humans and generated code only. You can rename it
  freely; the wire doesn't care.
* The **number** `1` is forever. Change it and you've broken every stored message and
  every client that hasn't redeployed.
* Numbers **1–15** encode in **one byte**, 16–2047 in two. Give the low numbers to
  fields that appear in every message.

### Scalar types cheat-sheet

| `.proto` type | use for | notes |
|---|---|---|
| `int32` / `int64` | whole numbers | inefficient for negatives — use `sint32/64` if often negative |
| `uint32` / `uint64` | non-negative counts | |
| `sint32` / `sint64` | often-negative ints | zig-zag encoded, smaller for negatives |
| `fixed64` / `fixed32` | ids / hashes that are usually large | always 4/8 bytes, no varint |
| `float` (32-bit) | headings, low-precision sensor values | ~7 sig figs |
| `double` (64-bit) | latitude/longitude, money-as-float (don't), precise values | |
| `bool` | flags | 1 byte |
| `string` | UTF-8 text | must be valid UTF-8 |
| `bytes` | binary blobs, image thumbnails, encrypted data | **not** `string` |
| `enum` | a closed set of options | first entry = 0 |
| `repeated T` | a list/array of `T` | |
| `map<K, V>` | a dictionary | `map<string, int32>` |
| `oneof` | exactly one of several fields set | union type |

> **`int64` in JavaScript:** JS numbers lose precision above 2^53. Libraries return
> `int64` as a string or a `Long` object by default. In this repo `codec.js` passes
> `{ longs: Number }` because millisecond timestamps are safely under 2^53 — but for
> real 64-bit IDs, keep them as strings.

---

## 3. How to compile it

### Option A — runtime, no build step (what this repo uses)

```js
import protobuf from 'protobufjs';
const root = await protobuf.load('proto/tracking.proto');
const LocationPing = root.lookupType('tracking.LocationPing');

const buf = LocationPing.encode(LocationPing.fromObject(obj)).finish();
const back = LocationPing.toObject(LocationPing.decode(buf), { enums: String, longs: Number });
```

Easiest to start with. No types, slightly slower than generated code.

### Option B — `protoc`, generated code (what production usually uses)

```bash
# install the compiler
brew install protobuf            # macOS
# then generate, e.g. for TypeScript with ts-proto:
protoc --plugin=./node_modules/.bin/protoc-gen-ts_proto \
       --ts_proto_out=./src/gen \
       proto/tracking.proto
```

You get real types, faster code, and IDE autocomplete — at the cost of a build step
you must re-run every time the `.proto` changes, and a compiler version to keep in
sync across the team.

---

## 4. DO's

**1. DO put `syntax = "proto3";` on the first line.** Without it the compiler assumes
proto2 and the rules change.

**2. DO use a `package`** (and reverse-domain style for anything shared:
`com.acme.tracking`). It namespaces your types.

**3. DO make the first enum value `0` and name it `*_UNSPECIFIED`.** proto3 has no
field presence for enums — a missing enum reads back as `0`. If `0` is a *real*
meaningful state you can't tell "unset" from that state.

**4. DO keep field numbers 1–15 for the fields present in every message.** They cost
one byte; 16+ cost two. In `LocationPing`, the always-there GPS fields are 1–8.

**5. DO `reserved` the numbers AND names of fields you delete.**
```proto
reserved 10, 11;
reserved "battery_pct", "temperature_c";
```
This makes the compiler reject anyone who later reuses `10` or `battery_pct` and
silently misreads old data.

**6. DO treat field numbers as immutable and append-only.** New field → next unused
number. Never renumber.

**7. DO use `snake_case` for field names** and `PascalCase` for messages/enums. Every
code generator maps `snake_case` to that language's idiom (`deliveryId` in JS,
`delivery_id` in Python). Fighting the convention causes churn.

**8. DO use `bytes` for binary data,** never `string`. `string` must be valid UTF-8;
raw bytes will get mangled.

**9. DO think about whether a field can ever be legitimately zero/empty.** If "0" and
"not sent" must be distinguishable, mark the field `optional` (proto3 re-added this):
```proto
optional float accuracy_m = 9;   // now you can check hasAccuracyM()
```

**10. DO keep messages focused.** A `LocationPing` is a GPS fix. Don't bolt driver
profile, vehicle details, and the customer's address onto it "because it's handy."
Compose with nested messages instead.

**11. DO store `.proto` files in a shared location** — a `proto/` dir imported by all
services, or a dedicated schema repo — and version them. The contract only works if
everyone builds from the same file.

**12. DO plan for evolution from day one.** Assume every message will gain fields.
That's fine and free in Protobuf *if* you only ever add.

---

## 5. DON'Ts

**1. DON'T change a field's number.** It's the wire identity. Changing `lat = 3` to
`lat = 4` means every old message now has an unknown field 3 and a missing field 4.

**2. DON'T change a field's type** in an incompatible way (`string` ↔ `int32`,
`float` ↔ `double`). Some swaps are wire-compatible (`int32`/`int64`/`bool`/`uint32`
for small values), most silently corrupt data. When in doubt, add a new field.

**3. DON'T reuse a deleted field's number or name.** Old stored messages and
not-yet-updated clients still use it. `reserved` it instead.

**4. DON'T rely on `required`.** It doesn't exist in proto3, on purpose — a "required"
field can never be safely removed. Validate in code.

**5. DON'T assume default values are transmitted.** proto3 does not put scalar fields
equal to their default (`0`, `false`, `""`) on the wire. Receiver just sees the
default. If you need "the sender explicitly set this to 0", use `optional`.

**6. DON'T expect field ordering.** The wire format has no guaranteed field order and
no canonical byte output. Never hash or byte-compare two encodings and expect a match.

**7. DON'T put large blobs in a hot message.** A 2 MB image thumbnail inside every
`LocationPing` defeats the point. Send a URL or a separate message.

**8. DON'T use `double` for money.** Same as everywhere else — use integer cents, or a
dedicated decimal type.

**9. DON'T deeply nest or make giant messages** if you can avoid it. Very large
messages must be fully parsed into memory; there's no streaming of one message.

**10. DON'T forget the compiler is code in your build.** `protoc` and its plugins
have versions and occasionally bugs; a regenerate can change generated output.
Pin versions, review the diff, don't auto-run it blindly in CI without a lockstep.

**11. DON'T skip a review process for schema changes.** A bad `.proto` edit is a
data-corruption bug that ships silently. Treat the file like a database migration.

**12. DON'T reach for Protobuf reflexively.** For a small internal REST API with a
human debugging it in devtools, JSON's zero setup often wins. See the trade-offs
below.

---

## 6. Advantages of Protocol Buffers

* **Small on the wire.** Field numbers instead of repeated key strings, varint
  encoding, no whitespace/quotes/braces. ~67% smaller per message in this repo's
  `LocationPing` (52 B vs 159 B).
* **Fast to encode/decode.** ~2× faster than `JSON.stringify`/`parse` here, more in
  languages without a hyper-optimised JSON parser, more as messages get complex.
* **A real, enforced schema.** The encoder rejects wrong types. New team members read
  one file instead of reverse-engineering example payloads.
* **Safe, cheap evolution.** Add a field → old clients ignore it, new clients see a
  default from old senders. No coordinated deploy, *if* you only add and never
  renumber.
* **Language-neutral.** One `.proto` → generated code for ~a dozen languages. The
  contract lives in one place.
* **Foundation for gRPC.** Streaming, deadlines, code-generated client stubs, all
  built on Protobuf messages.
* **Lower cost at scale.** Bandwidth, storage, and mobile data all scale down with
  message size — 21 GB/month saved in this repo's 500-driver example.

## 7. Disadvantages of Protocol Buffers

* **Not human-readable.** You can't `curl` an endpoint and read the response, or spot
  a bad value in browser devtools, without a decoder (`protoc --decode`, a plugin,
  custom logging).
* **Build-step friction.** `protoc` + language plugins to install, a compiler version
  to keep aligned across the team, generated code to regenerate on every schema edit.
  In this project the Protobuf path took noticeably more setup than "just call
  `JSON.stringify`".
* **A schema you must own.** Renumbering, type changes, and reused tags are silent
  data-corruption footguns. Schema changes need discipline and review.
* **Weak spots in the compression story.** gzip on a single tiny message makes it
  *bigger*; a large repetitive JSON batch over gzip can end up smaller than Protobuf.
  The win is per-message and pre-compression.
* **Latency benefit is conditional.** On a fast local network the size advantage does
  *not* show up as speed — this repo measures JSON and Protobuf within noise on
  localhost. It only converts to latency on slow/metered/far links.
* **Overkill for small/simple/internal APIs.** If volume is low, the payload is
  human-facing, and there's one team, the schema + toolchain is pure tax.
* **Tooling gaps.** Logging, testing fixtures, API explorers, and observability tools
  mostly assume JSON. You'll write a bit of glue.

---

## 8. A checklist before you commit a `.proto` change

- [ ] New fields use the next unused number, never a recycled one
- [ ] No existing field's number or type changed
- [ ] Deleted fields are `reserved` (number **and** name)
- [ ] Every enum starts at `0` with an `*_UNSPECIFIED` value
- [ ] Fields that need "set vs default-zero" are marked `optional`
- [ ] Binary data is `bytes`, not `string`
- [ ] Hot messages have their always-present fields in numbers 1–15
- [ ] No giant blobs in high-frequency messages
- [ ] The change was reviewed like a database migration
- [ ] Generated code regenerated, diff inspected, compiler version pinned
