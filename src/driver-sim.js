// driver-sim.js
//
// Pretends to be a driver's phone: streams the synthetic route to the server as
// LocationPings, and at the same time connects as a customer so it can measure
// the real relay round-trip (encode -> socket -> server decode -> re-encode ->
// socket -> decode). Prints bytes sent and RTT percentiles at the end.
//
//   FORMAT=json  node src/driver-sim.js
//   FORMAT=proto node src/driver-sim.js
//
// Env knobs:  PORT (8080)  DELIVERY_ID (d-8814)  HZ (2)  PINGS (120)

import { WebSocket } from 'ws';
import { codec, FORMAT } from './codec.js';
import { makeRoute } from './route.js';
import { hopDelayMs, sleep as linkSleep, linkLabel } from './link.js';

const PORT = Number(process.env.PORT || 8080);
const DELIVERY_ID = process.env.DELIVERY_ID || 'd-8814';
const HZ = Number(process.env.HZ || 2);
const PINGS = Number(process.env.PINGS || 120);
const base = `ws://localhost:${PORT}`;

const driver = new WebSocket(`${base}/?role=driver&deliveryId=${DELIVERY_ID}`);
const customer = new WebSocket(`${base}/?role=customer&deliveryId=${DELIVERY_ID}`);

const sentAt = new Map(); // pingSeq -> hrtime bigint
const rtts = [];
let bytesSent = 0;
let seq = 0;

customer.on('message', (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const upd = codec.decodeTrackUpdate(buf);
  const t0 = sentAt.get(upd.pingSeq);
  if (t0 !== undefined) {
    rtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    sentAt.delete(upd.pingSeq);
  }
});

let open = 0;
const maybeRun = () => { if (++open === 2) run(); };
driver.on('open', maybeRun);
customer.on('open', maybeRun);
for (const s of [driver, customer]) {
  s.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const route = makeRoute(PINGS, { deliveryId: DELIVERY_ID });
  console.log(
    `[driver-sim ${FORMAT}] streaming ${PINGS} pings at ${HZ} Hz to ${base}  (link: ${linkLabel()})`,
  );

  for (const ping of route) {
    ping.ts = Date.now();
    const buf = codec.encodePing(ping);
    bytesSent += buf.length;
    seq += 1;                       // server assigns the same seq, in order
    sentAt.set(seq, process.hrtime.bigint());
    await linkSleep(hopDelayMs(buf.length)); // simulated uplink from the phone
    driver.send(buf);
    await sleep(1000 / HZ);
  }

  await sleep(250); // let the last relay come back
  report();
  process.exit(0);
}

function report() {
  rtts.sort((a, b) => a - b);
  const q = (p) => (rtts.length ? rtts[Math.floor((rtts.length - 1) * p)] : NaN);
  const f = (x) => (Number.isNaN(x) ? 'n/a' : x.toFixed(3) + ' ms');
  console.log(`
=== driver-sim result  (FORMAT=${FORMAT}) ===
pings sent        : ${PINGS}
bytes sent        : ${bytesSent}   (avg ${(bytesSent / PINGS).toFixed(1)} B/ping)
relay RTT  p50    : ${f(q(0.5))}
relay RTT  p95    : ${f(q(0.95))}
relay RTT  max    : ${f(q(1))}
replies matched   : ${rtts.length}/${PINGS}
`);
}
