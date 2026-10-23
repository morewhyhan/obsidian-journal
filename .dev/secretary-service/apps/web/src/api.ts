export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export async function api<T = any>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api/v1" + url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.method && options.method !== "GET"
        ? { "Idempotency-Key": crypto.randomUUID() }
        : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok)
    throw new ApiError(
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "操作暂未完成",
      response.status,
      body.error?.details,
    );
  return body;
}
export const mutate = (url: string, body: unknown, method = "POST") =>
  api(url, { method, body: JSON.stringify(body) });
export type Document = {
  path: string;
  content: string;
  hash: string;
  version: number;
  updated_at: string;
};
export type Draft = {
  path: string;
  content: string;
  baseHash: string;
  updatedAt: number;
};
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("secretary-drafts", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("drafts", { keyPath: "path" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
async function draftOperation<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("drafts", mode),
      request = fn(tx.objectStore("drafts"));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export const drafts = {
  get: (p: string) =>
    draftOperation<Draft | undefined>("readonly", (s) => s.get(p)),
  put: (d: Draft) => draftOperation<IDBValidKey>("readwrite", (s) => s.put(d)),
  remove: (p: string) =>
    draftOperation<undefined>("readwrite", (s) => s.delete(p)),
};
