import { Timestamp, GeoPoint, DocumentReference } from 'firebase-admin/firestore';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function serializeValue(value) {
  if (value === null || value === undefined) {
    return value === undefined ? { __fsType: 'Undefined' } : null;
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { __fsType: 'Number', special: 'NaN' };
    if (value === Infinity) return { __fsType: 'Number', special: 'Infinity' };
    if (value === -Infinity) return { __fsType: 'Number', special: '-Infinity' };
    if (Object.is(value, -0)) return { __fsType: 'Number', special: '-0' };
    return value;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Timestamp) {
    return {
      __fsType: 'Timestamp',
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }

  if (value instanceof Date) {
    const ts = Timestamp.fromDate(value);
    return {
      __fsType: 'Timestamp',
      seconds: ts.seconds,
      nanoseconds: ts.nanoseconds,
    };
  }

  if (value instanceof GeoPoint) {
    return {
      __fsType: 'GeoPoint',
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }

  if (value instanceof DocumentReference) {
    return {
      __fsType: 'DocumentReference',
      path: value.path,
    };
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return {
      __fsType: 'Bytes',
      base64: Buffer.from(value).toString('base64'),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }

  if (isPlainObject(value)) {
    const out = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (value[key] === undefined) continue;
      if (key === '__fsType' || key === '__escapedFsType') {
        out.__escapedFsType = out.__escapedFsType || {};
        out.__escapedFsType[key] = serializeValue(value[key]);
      } else {
        out[key] = serializeValue(value[key]);
      }
    }
    return out;
  }

  if (typeof value.toArray === 'function') {
    return {
      __fsType: 'VectorValue',
      values: value.toArray(),
    };
  }

  throw new Error(`Tipe data Firestore tidak dikenali saat serialisasi: ${Object.prototype.toString.call(value)}`);
}

export function deserializeValue(value, db) {
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deserializeValue(item, db));
  }

  if (typeof value === 'object') {
    if (typeof value.__fsType === 'string') {
      switch (value.__fsType) {
        case 'Undefined':
          return undefined;
        case 'Number':
          if (value.special === 'NaN') return Number.NaN;
          if (value.special === 'Infinity') return Number.POSITIVE_INFINITY;
          if (value.special === '-Infinity') return Number.NEGATIVE_INFINITY;
          if (value.special === '-0') return -0;
          throw new Error(`Special number tidak dikenal: ${value.special}`);
        case 'Timestamp':
          return new Timestamp(value.seconds, value.nanoseconds);
        case 'GeoPoint':
          return new GeoPoint(value.latitude, value.longitude);
        case 'DocumentReference':
          return db.doc(value.path);
        case 'Bytes':
          return Buffer.from(value.base64, 'base64');
        default:
          throw new Error(`__fsType tidak didukung saat deserialisasi: ${value.__fsType}`);
      }
    }

    const out = {};
    for (const [key, rawVal] of Object.entries(value)) {
      if (key === '__escapedFsType' && rawVal && typeof rawVal === 'object') {
        for (const [escKey, escVal] of Object.entries(rawVal)) {
          out[escKey] = deserializeValue(escVal, db);
        }
      } else {
        const parsed = deserializeValue(rawVal, db);
        if (parsed !== undefined) {
          out[key] = parsed;
        }
      }
    }
    return out;
  }

  throw new Error(`Nilai terstruktur tidak valid saat deserialisasi: ${typeof value}`);
}

export function canonicalJson(serializedValue) {
  return JSON.stringify(serializedValue);
}
