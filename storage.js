// File-storage abstraction for the Video Publishing App.
//
// ALL Supabase Storage calls live in this module behind a small interface.
// server.js and the UI must never import @supabase/supabase-js directly —
// they only use the functions exported here.
//
// Backend swap: the active backend is chosen by STORAGE_BACKEND (default
// 'supabase'). To move to R2/S3 later, add lib/storage-r2.js implementing
// the same six functions (isConfigured, ensureBucket, createUploadUrl,
// verifyObject, createDownloadUrl, deleteObject) and have getBackend()
// return it when STORAGE_BACKEND === 'r2'. No route or UI changes needed.
//
// Fail-closed: when SUPABASE_URL / SUPABASE_SERVICE_KEY are not set, every
// operation throws StorageNotConfiguredError. Routes translate that to
// HTTP 503 "storage not configured" — the server always boots fine.

const BUCKET = process.env.STORAGE_BUCKET || 'client-uploads';

class StorageNotConfiguredError extends Error {
  constructor() {
    super('File storage is not configured (set SUPABASE_URL and SUPABASE_SERVICE_KEY)');
    this.name = 'StorageNotConfiguredError';
  }
}

function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

let supabaseClient = null;
function sb() {
  if (!isConfigured()) throw new StorageNotConfiguredError();
  if (!supabaseClient) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

let bucketReady = false;
// Idempotent: creates the private bucket if missing; treats "already exists" as OK.
async function ensureBucket() {
  if (bucketReady) return;
  const client = sb();
  const { error } = await client.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
  bucketReady = true;
}

// Returns { uploadUrl, path }. The browser PUTs the raw file bytes directly
// to uploadUrl (no server proxying, so large files never touch the app server).
async function createUploadUrl(path, contentType) {
  await ensureBucket();
  const client = sb();
  const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { uploadUrl: data.signedUrl, path: data.path || path };
}

// Returns { exists, bytes, mime }. Used to confirm the bytes really landed
// before a files row is written.
async function verifyObject(path) {
  const client = sb();
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const { data, error } = await client.storage.from(BUCKET).list(dir, { search: name, limit: 10 });
  if (error) throw error;
  const hit = (data || []).find((f) => f.name === name);
  if (!hit) return { exists: false, bytes: 0, mime: '' };
  return { exists: true, bytes: hit.metadata && hit.metadata.size ? Number(hit.metadata.size) : 0, mime: (hit.metadata && hit.metadata.mimetype) || '' };
}

// Short-expiry signed download URL for an authorized user.
async function createDownloadUrl(path, expiresInSeconds) {
  const client = sb();
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds || 300);
  if (error) throw error;
  return data.signedUrl;
}

async function deleteObject(path) {
  const client = sb();
  const { error } = await client.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}

module.exports = {
  BUCKET,
  StorageNotConfiguredError,
  isConfigured,
  ensureBucket,
  createUploadUrl,
  verifyObject,
  createDownloadUrl,
  deleteObject,
};
