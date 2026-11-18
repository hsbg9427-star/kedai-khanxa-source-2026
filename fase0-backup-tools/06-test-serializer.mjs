import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, GeoPoint } from 'firebase-admin/firestore';
import { serializeValue, deserializeValue, canonicalJson } from './lib/firestore-serializer.mjs';

const app = getApps().length ? getApps()[0] : initializeApp({ projectId: 'local-serializer-check' });
const db = getFirestore(app);

const sampleDoc = {
  sku: 'KK-0001',
  stock: 12.5,
  negativeZero: -0,
  isActive: true,
  emptyField: null,
  createdAt: new Timestamp(1763222400, 123456000),
  location: new GeoPoint(-6.2, 106.816666),
  ref: db.doc('products/prd_test_01'),
  bytes: Buffer.from('WOYA-WP58D-TEST', 'utf8'),
  __fsType: 'literal-key-collision-test',
  nested: [
    { a: 1, b: 'teks' },
    new Timestamp(1700000000, 0),
  ],
};

const serialized = serializeValue(sampleDoc);
const roundTripJson = JSON.parse(JSON.stringify(serialized));
const restored = deserializeValue(roundTripJson, db);
const reserialized = serializeValue(restored);

assert.equal(canonicalJson(serialized), canonicalJson(reserialized));
assert.ok(restored.createdAt instanceof Timestamp);
assert.equal(restored.createdAt.seconds, 1763222400);
assert.equal(restored.createdAt.nanoseconds, 123456000);
assert.ok(restored.location instanceof GeoPoint);
assert.equal(restored.ref.path, 'products/prd_test_01');
assert.equal(Buffer.from(restored.bytes).toString('utf8'), 'WOYA-WP58D-TEST');
assert.equal(restored.__fsType, 'literal-key-collision-test');

console.log('LULUS: Uji round-trip seluruh tipe data Firestore serializer (Timestamp, GeoPoint, DocumentReference, Bytes, -0, null, __fsType escape).');
