// route.js
//
// A deterministic synthetic delivery route, so every run of the benchmark and
// the driver simulator produces comparable numbers. Starts in downtown San
// Francisco and wanders roughly north-east.

// Tiny seeded PRNG (mulberry32) so the route is identical every run.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} count  number of pings to generate
 * @param {object} [opts]
 * @param {string} [opts.deliveryId]
 * @param {number} [opts.driverId]
 * @param {number} [opts.seed]
 * @param {number} [opts.startTs]  epoch ms of the first ping
 * @param {number} [opts.stepMs]   ms between pings
 * @returns {Array<object>} plain ping objects (camelCase keys)
 */
export function makeRoute(count, opts = {}) {
  const {
    deliveryId = 'd-8814',
    driverId = 42,
    seed = 1337,
    startTs = 1_735_689_600_000, // fixed so JSON timestamp width is stable
    stepMs = 2000,
  } = opts;

  const rand = mulberry32(seed);
  let lat = 37.7749295;
  let lng = -122.4194155;
  let heading = 45;
  const out = [];

  for (let i = 0; i < count; i++) {
    lat += (rand() - 0.45) * 0.00035;
    lng += (rand() - 0.4) * 0.00055;
    heading = (heading + (rand() - 0.5) * 18 + 360) % 360;
    out.push({
      deliveryId,
      driverId,
      lat: Number(lat.toFixed(7)),
      lng: Number(lng.toFixed(7)),
      heading: Number(heading.toFixed(1)),
      speedMps: Number((6 + rand() * 6).toFixed(2)),
      ts: startTs + i * stepMs,
      status: i === count - 1 ? 'ARRIVED' : 'EN_ROUTE',
      accuracyM: Number((3 + rand() * 8).toFixed(1)),
    });
  }
  return out;
}
