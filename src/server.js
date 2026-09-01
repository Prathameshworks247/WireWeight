// server.js
//
// The ingest + relay server. Drivers connect and stream LocationPings; customers
// connect and receive TrackUpdates for the delivery they're watching. When a
// trip ends (status ARRIVED, or the driver disconnects) the whole thing is
// written to ../trips/ so you can `ls -lh` the on-disk size difference.
//
//   FORMAT=json  node src/server.js
//   FORMAT=proto node src/server.js
//
// Connect as:
//   driver   ->  ws://localhost:8080/?role=driver&deliveryId=d-8814
//   customer ->  ws://localhost:8080/?role=customer&deliveryId=d-8814

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { codec, FORMAT } from './codec.js';
import { hopDelayMs, sleep, linkLabel } from './link.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRIPS_DIR = path.join(__dirname, '..', 'trips');
mkdirSync(TRIPS_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port: PORT });

/** deliveryId -> { pings: [], seq, customers: Set<ws> } */
const deliveries = new Map();
const stats = { bytesIn: 0, bytesOut: 0, pings: 0, since: Date.now() };

function getDelivery(id) {
  let d = deliveries.get(id);
  if (!d) {
    d = { pings: [], seq: 0, customers: new Set() };
    deliveries.set(id, d);
  }
  return d;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role') || 'driver';
  const deliveryId = url.searchParams.get('deliveryId') || 'd-8814';
  const d = getDelivery(deliveryId);

  if (role === 'customer') {
    d.customers.add(ws);
    ws.on('close', () => d.customers.delete(ws));
    return;
  }

  // role === 'driver'
  ws.on('message', async (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    stats.bytesIn += buf.length;
    stats.pings += 1;

    let ping;
    try {
      ping = codec.decodePing(buf);
    } catch (err) {
      // Almost always a client using the other FORMAT than this server.
      console.error(`[server ${FORMAT}] dropped an undecodable message: ${err.message}`);
      return;
    }
    d.pings.push(ping);
    d.seq += 1;

    const update = codec.encodeTrackUpdate({
      ping,
      pingSeq: d.seq,
      etaSeconds: Math.max(0, 600 - d.seq * 2),
    });
    // simulated downlink to the customer: bigger message => more time on the wire
    await sleep(hopDelayMs(update.length));
    for (const c of d.customers) {
      if (c.readyState === c.OPEN) {
        c.send(update);
        stats.bytesOut += update.length;
      }
    }

    if (ping.status === 'ARRIVED') finishTrip(deliveryId);
  });

  ws.on('close', () => {
    if (deliveries.get(deliveryId)?.pings.length) finishTrip(deliveryId);
  });
});

function finishTrip(deliveryId) {
  const d = deliveries.get(deliveryId);
  if (!d || d.pings.length === 0) return;

  const trip = { deliveryId, driverId: d.pings[0].driverId, pings: d.pings };
  const bytes = codec.encodeTrip(trip);
  const ext = FORMAT === 'proto' ? 'pb' : 'json';
  const file = path.join(TRIPS_DIR, `${deliveryId}-${Date.now()}.${ext}`);
  writeFileSync(file, bytes);

  console.log(
    `[trip ${FORMAT}] ${deliveryId}: ${d.pings.length} pings -> ` +
      `${path.basename(file)} (${bytes.length} bytes, ${(bytes.length / d.pings.length).toFixed(1)} B/ping)`,
  );
  deliveries.delete(deliveryId);
}

setInterval(() => {
  const secs = (Date.now() - stats.since) / 1000 || 1;
  if (stats.pings === 0) return;
  console.log(
    `[stats ${FORMAT}] pings=${stats.pings} ` +
      `in=${(stats.bytesIn / 1024).toFixed(1)}KB out=${(stats.bytesOut / 1024).toFixed(1)}KB ` +
      `avg=${(stats.bytesIn / stats.pings).toFixed(1)}B/ping rate=${(stats.pings / secs).toFixed(1)}/s`,
  );
}, 5000).unref();

console.log(
  `delivery-tracker server on ws://localhost:${PORT}  (FORMAT=${FORMAT}, link: ${linkLabel()})`,
);
