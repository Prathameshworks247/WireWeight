// bench.js
//
// Headless comparison of the two wire formats. Measures, for the exact same
// data:
//   1. serialized size of one ping        (raw + gzip)
//   2. serialized size of a whole trip    (raw + gzip)
//   3. encode latency  (JSON.stringify vs protobuf encode)
//   4. decode latency  (JSON.parse     vs protobuf decode+toObject)
// then extrapolates the wire size to a fleet.
//
// Usage:  node src/bench.js [tripPings] [iterations]
//   node src/bench.js            # 750 pings/trip, 200k iterations
//   node src/bench.js 1500 500000

import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { makeRoute } from './route.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = await protobuf.load(path.join(__dirname, '..', 'proto', 'tracking.proto'));
const LocationPing = root.lookupType('tracking.LocationPing');
const Trip = root.lookupType('tracking.Trip');
const toObjOpts = { enums: String, longs: Number };

const TRIP_PINGS = Number(process.argv[2] || 750); // ~25 min at one ping / 2s
const ITER = Number(process.argv[3] || 200_000);

// ---------------------------------------------------------------- helpers ----
const jEncPing = (o) => Buffer.from(JSON.stringify(o));
const jDecPing = (b) => JSON.parse(b.toString());
const pEncPing = (o) => Buffer.from(LocationPing.encode(LocationPing.fromObject(o)).finish());
const pDecPing = (b) => LocationPing.toObject(LocationPing.decode(b), toObjOpts);

function timeit(fn, iterations) {
  for (let i = 0; i < Math.min(iterations, 10_000); i++) fn(); // warm up JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0);
  return { perOpUs: ns / iterations / 1e3, opsPerSec: iterations / (ns / 1e9) };
}

const n = (x, d = 0) => x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const kb = (bytes) => `${n(bytes / 1024, 1)} KB`;
// `a` is protobuf, `b` is JSON. Positive => protobuf is smaller.
const smaller = (a, b) => {
  const p = (1 - a / b) * 100;
  return p >= 0 ? `${n(p, 1)}% smaller` : `${n(-p, 1)}% LARGER`;
};
const faster = (a, b) => `${n(b / a, 2)}x`;

// ---------------------------------------------------------------- data -------
const route = makeRoute(TRIP_PINGS);
const sample = route[Math.floor(route.length / 2)];

const jPing = jEncPing(sample);
const pPing = pEncPing(sample);
const jPingGz = zlib.gzipSync(jPing);
const pPingGz = zlib.gzipSync(pPing);

const tripObj = { deliveryId: 'd-8814', driverId: 42, pings: route };
const jTrip = Buffer.from(JSON.stringify(tripObj));
const pTrip = Buffer.from(Trip.encode(Trip.fromObject(tripObj)).finish());
const jTripGz = zlib.gzipSync(jTrip);
const pTripGz = zlib.gzipSync(pTrip);

// sanity: round-trips must preserve the data
const rt = pDecPing(pPing);
if (Math.abs(rt.lat - sample.lat) > 1e-6 || rt.status !== sample.status) {
  throw new Error('protobuf round-trip mismatch');
}

// ---------------------------------------------------------------- latency ----
const jEnc = timeit(() => jEncPing(sample), ITER);
const pEnc = timeit(() => pEncPing(sample), ITER);
const jDec = timeit(() => jDecPing(jPing), ITER);
const pDec = timeit(() => pDecPing(pPing), ITER);

// ---------------------------------------------------------------- report -----
console.log(`
delivery-tracker  —  JSON vs Protocol Buffers
=============================================
sample ping fields : delivery_id, driver_id, lat, lng, heading, speed_mps, ts, status, accuracy_m
trip size          : ${TRIP_PINGS} pings  (~${n((TRIP_PINGS * 2) / 60, 0)} min at one ping / 2 s)
latency iterations : ${n(ITER)} per case
node               : ${process.version}
`);

console.log('SIZE — one location ping');
console.log('  format         raw        gzip');
console.log(`  JSON        ${String(jPing.length).padStart(5)} B    ${String(jPingGz.length).padStart(5)} B`);
console.log(`  Protobuf    ${String(pPing.length).padStart(5)} B    ${String(pPingGz.length).padStart(5)} B`);
console.log(`  delta       ${smaller(pPing.length, jPing.length).padStart(14)}  ${smaller(pPingGz.length, jPingGz.length)} gzipped`);

console.log(`\nSIZE — one full trip (${TRIP_PINGS} pings)`);
console.log('  format         raw          gzip');
console.log(`  JSON        ${kb(jTrip.length).padStart(9)}   ${kb(jTripGz.length).padStart(9)}`);
console.log(`  Protobuf    ${kb(pTrip.length).padStart(9)}   ${kb(pTripGz.length).padStart(9)}`);
console.log(`  delta       ${smaller(pTrip.length, jTrip.length).padStart(12)}   ${smaller(pTripGz.length, jTripGz.length)} gzipped`);

console.log('\nLATENCY — per message (lower is better)');
console.log('  operation           JSON          Protobuf       speedup');
console.log(`  encode        ${(n(jEnc.perOpUs, 3) + ' us').padStart(12)}  ${(n(pEnc.perOpUs, 3) + ' us').padStart(12)}   ${faster(pEnc.perOpUs, jEnc.perOpUs)}`);
console.log(`  decode        ${(n(jDec.perOpUs, 3) + ' us').padStart(12)}  ${(n(pDec.perOpUs, 3) + ' us').padStart(12)}   ${faster(pDec.perOpUs, jDec.perOpUs)}`);
console.log(`  encode ops/s  ${n(jEnc.opsPerSec).padStart(12)}  ${n(pEnc.opsPerSec).padStart(12)}`);
console.log(`  decode ops/s  ${n(jDec.opsPerSec).padStart(12)}  ${n(pDec.opsPerSec).padStart(12)}`);

// ---------------------------------------------------------------- fleet ------
const FLEET = 500;
const TRIPS_PER_DRIVER_DAY = 18;      // ~8 h of deliveries
const pingsPerDay = FLEET * TRIPS_PER_DRIVER_DAY * TRIP_PINGS;
const jDay = pingsPerDay * jPing.length;
const pDay = pingsPerDay * pPing.length;
console.log(`\nWIRE VOLUME — ${FLEET} drivers x ${TRIPS_PER_DRIVER_DAY} trips/day x ${TRIP_PINGS} pings`);
console.log(`  pings / day        ${n(pingsPerDay)}`);
console.log(`  JSON ingress       ${n(jDay / 1e9, 2)} GB/day   (${n((jDay / 1e9) * 30, 1)} GB/month)`);
console.log(`  Protobuf ingress   ${n(pDay / 1e9, 2)} GB/day   (${n((pDay / 1e9) * 30, 1)} GB/month)`);
console.log(`  saved              ${n((jDay - pDay) / 1e9, 2)} GB/day   (${smaller(pDay, jDay)})`);
console.log('');
