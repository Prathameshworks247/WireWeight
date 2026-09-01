// link.js
//
// Optional network simulation so the size difference turns into a *latency*
// difference you can actually see. On localhost there is effectively infinite
// bandwidth, so JSON and Protobuf relay in the same sub-millisecond time and
// the size win is invisible. Real driver phones are on mobile links.
//
// Enable by setting env vars before running the server AND the driver sim:
//
//   LINK_KBPS=128     # one-way throughput of the simulated link (kilobits/s)
//   LINK_RTT_MS=60    # fixed base latency added to every hop
//
// With LINK_KBPS unset, these helpers are no-ops and everything runs full speed.

const KBPS = Number(process.env.LINK_KBPS || 0);
const BASE_RTT_MS = Number(process.env.LINK_RTT_MS || 0);

export const linkEnabled = KBPS > 0 || BASE_RTT_MS > 0;

export function linkLabel() {
  return linkEnabled ? `${KBPS || '∞'} kbps / +${BASE_RTT_MS} ms base` : 'localhost (unthrottled)';
}

/** Milliseconds it takes to put `bytes` on the simulated wire (one hop). */
export function hopDelayMs(bytes) {
  if (!linkEnabled) return 0;
  const serialize = KBPS > 0 ? (bytes * 8) / (KBPS * 1024) * 1000 : 0;
  return BASE_RTT_MS + serialize;
}

export const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
