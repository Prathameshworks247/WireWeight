// codec.js
//
// One interface, two wire formats. Every other file in the project encodes and
// decodes through this module and never touches JSON.stringify or protobufjs
// directly. Pick the format with the FORMAT env var:
//
//   FORMAT=json   node src/server.js
//   FORMAT=proto  node src/server.js
//
// This is the whole point of the project: the application code is identical,
// only `codec` changes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, '..', 'proto', 'tracking.proto');

// protobufjs loads the .proto at runtime — no codegen / build step. A codegen
// workflow (protoc + ts-proto) is faster and gives you types, but this keeps
// the demo to `npm install && node`.
const root = await protobuf.load(PROTO_PATH);
const LocationPing = root.lookupType('tracking.LocationPing');
const TrackUpdate = root.lookupType('tracking.TrackUpdate');
const Trip = root.lookupType('tracking.Trip');

export const FORMAT = (process.env.FORMAT || 'json').toLowerCase();
if (!['json', 'proto'].includes(FORMAT)) {
  throw new Error(`FORMAT must be "json" or "proto" (got "${FORMAT}")`);
}

// --- JSON -------------------------------------------------------------------
const jsonCodec = {
  encodePing: (o) => Buffer.from(JSON.stringify(o), 'utf8'),
  decodePing: (b) => JSON.parse(b.toString('utf8')),
  encodeTrackUpdate: (o) => Buffer.from(JSON.stringify(o), 'utf8'),
  decodeTrackUpdate: (b) => JSON.parse(b.toString('utf8')),
  encodeTrip: (o) => Buffer.from(JSON.stringify(o), 'utf8'),
  decodeTrip: (b) => JSON.parse(b.toString('utf8')),
};

// --- Protobuf -------------------------------------------------------------
// `enums: String` gives you "EN_ROUTE" instead of 1; `longs: Number` turns the
// int64 `ts` back into a plain JS number (safe for millisecond timestamps).
const toObjOpts = { enums: String, longs: Number };
const protoCodec = {
  encodePing: (o) => Buffer.from(LocationPing.encode(LocationPing.fromObject(o)).finish()),
  decodePing: (b) => LocationPing.toObject(LocationPing.decode(b), toObjOpts),
  encodeTrackUpdate: (o) => Buffer.from(TrackUpdate.encode(TrackUpdate.fromObject(o)).finish()),
  decodeTrackUpdate: (b) => TrackUpdate.toObject(TrackUpdate.decode(b), toObjOpts),
  encodeTrip: (o) => Buffer.from(Trip.encode(Trip.fromObject(o)).finish()),
  decodeTrip: (b) => Trip.toObject(Trip.decode(b), toObjOpts),
};

export const codec = FORMAT === 'proto' ? protoCodec : jsonCodec;
export const types = { LocationPing, TrackUpdate, Trip };
