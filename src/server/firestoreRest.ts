import firebaseConfig from '../../firebase-applet-config.json';

const DB_ROOT = `projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;
const BASE_URL = `https://firestore.googleapis.com/v1/${DB_ROOT}`;

function toFsValue(val: any): any {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFsValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = toFsValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFsValue(val: any): any {
  if (!val || typeof val !== 'object') return null;
  if ('nullValue' in val) return null;
  if ('stringValue' in val) return val.stringValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    return Array.isArray(val.arrayValue?.values)
      ? val.arrayValue.values.map((v: any) => fromFsValue(v))
      : [];
  }
  if ('mapValue' in val) {
    const out: Record<string, any> = {};
    const fields = val.mapValue?.fields ?? {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFsValue(v);
    }
    return out;
  }
  return null;
}

function decodeDocument(doc: any): Record<string, any> {
  const out: Record<string, any> = {};
  const fields = doc?.fields ?? {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fromFsValue(v);
  }
  return out;
}

function encodeFields(data: Record<string, any>, timestampStringFields: string[] = []): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (timestampStringFields.includes(k) && typeof v === 'string') {
      fields[k] = { timestampValue: v };
    } else {
      fields[k] = toFsValue(v);
    }
  }
  return fields;
}

async function fsFetch(idToken: string, url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.error?.message || json?.[0]?.error?.message || `Firestore REST error (${res.status})`;
    const err: any = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function fsGetDoc<T = Record<string, any>>(idToken: string, docPath: string): Promise<T | null> {
  const clean = docPath.replace(/^\/+/, '');
  const res = await fetch(`${BASE_URL}/${clean}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error?.message || `Firestore GET failed (${res.status})`);
  }
  return decodeDocument(json) as T;
}

export interface FsWriteOp {
  type: 'set' | 'delete';
  docPath: string;
  data?: Record<string, any>;
  serverTimeFields?: string[];
  timestampFields?: string[];
}

export async function fsCommit(idToken: string, ops: FsWriteOp[]) {
  if (ops.length === 0) return;

  // Batch in chunks of 400 writes (Firestore limit is 500)
  for (let i = 0; i < ops.length; i += 400) {
    const chunk = ops.slice(i, i + 400);
    const writes = chunk.map((op) => {
      const fullName = `${DB_ROOT}/${op.docPath.replace(/^\/+/, '')}`;
      if (op.type === 'delete') {
        return { delete: fullName };
      }
      const dataCopy = { ...(op.data ?? {}) };
      for (const sf of op.serverTimeFields ?? []) {
        delete dataCopy[sf];
      }
      const write: any = {
        update: {
          name: fullName,
          fields: encodeFields(dataCopy, op.timestampFields ?? []),
        },
      };
      if (op.serverTimeFields && op.serverTimeFields.length > 0) {
        write.updateTransforms = op.serverTimeFields.map((fieldPath) => ({
          fieldPath,
          setToServerValue: 'REQUEST_TIME',
        }));
      }
      return write;
    });

    await fsFetch(idToken, `${BASE_URL}:commit`, {
      method: 'POST',
      body: JSON.stringify({ writes }),
    });
  }
}

export async function fsSetDoc(
  idToken: string,
  docPath: string,
  data: Record<string, any>,
  options?: { serverTimeFields?: string[]; timestampFields?: string[] }
) {
  await fsCommit(idToken, [
    {
      type: 'set',
      docPath,
      data,
      serverTimeFields: options?.serverTimeFields,
      timestampFields: options?.timestampFields,
    },
  ]);
}

export async function fsDeleteDoc(idToken: string, docPath: string) {
  await fsCommit(idToken, [{ type: 'delete', docPath }]);
}

export async function fsListOwnedCollection<T = Record<string, any>>(
  idToken: string,
  parentDocPath: string | null,
  collectionId: string,
  ownerUid: string,
  limit = 200
): Promise<T[]> {
  const parentUrl = parentDocPath
    ? `${BASE_URL}/${parentDocPath.replace(/^\/+/, '')}:runQuery`
    : `${BASE_URL}:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'ownerUid' },
          op: 'EQUAL',
          value: { stringValue: ownerUid },
        },
      },
      limit,
    },
  };

  const rows = await fsFetch(idToken, parentUrl, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => Boolean(r?.document))
    .map((r) => decodeDocument(r.document) as T);
}
