// Supabase persistence adapter kept separate from js/app.js during migration
// preparation. The app's full document payload is deliberately opaque here:
// do not whitelist fields, normalize it, or drop keys this version doesn't know.
const USER_DATA_TABLE = 'user_data';
const USER_DATA_COLUMNS = 'payload,schema_version,revision,updated_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isObjectRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function authenticatedSupabaseUserId(client) {
  if (!client?.auth || typeof client.auth.getUser !== 'function') {
    throw new TypeError('A Supabase client with Auth support is required.');
  }

  const result = await client.auth.getUser();
  if (result?.error) throw result.error;

  // Always derive row ownership from Supabase Auth. Never accept a Firebase UID
  // or an arbitrary caller-supplied user_id for this table.
  const userId = result?.data?.user?.id;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('A signed-in Supabase Auth user is required.');
  }
  return userId;
}

function unpackRow(row) {
  if (!row) return null;
  if (!isObjectRecord(row.payload)) {
    throw new Error('Supabase user_data.payload is not a JSON object.');
  }
  return {
    payload: row.payload,
    schemaVersion: row.schema_version,
    revision: row.revision,
    updatedAt: row.updated_at
  };
}

/**
 * Load the current Supabase user's complete persisted payload, or null when
 * that user's row has not been created. RLS remains the authorization boundary.
 */
export async function loadSupabaseUserData(client) {
  const userId = await authenticatedSupabaseUserId(client);
  const { data, error } = await client
    .from(USER_DATA_TABLE)
    .select(USER_DATA_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return unpackRow(data);
}

/**
 * Save the complete app payload using the current Supabase Auth UUID. This is
 * a full-row upsert (matching the current Firestore set semantics), not a
 * partial patch. Pass the complete buildPayload() result so app-owned and
 * unknown/future fields are all retained. Revision/schema metadata are only
 * written when explicitly supplied; the database defaults apply on insert.
 */
export async function saveSupabaseUserData(client, payload, { schemaVersion, revision } = {}) {
  if (!isObjectRecord(payload)) {
    throw new TypeError('The complete LIFTS payload must be a JSON object.');
  }
  if (schemaVersion !== undefined && (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)) {
    throw new TypeError('schemaVersion must be a positive safe integer.');
  }
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw new TypeError('revision must be a non-negative safe integer.');
  }

  const userId = await authenticatedSupabaseUserId(client);
  const row = {
    user_id: userId,
    payload,
    updated_at: new Date().toISOString()
  };
  if (schemaVersion !== undefined) row.schema_version = schemaVersion;
  if (revision !== undefined) row.revision = revision;

  const { data, error } = await client
    .from(USER_DATA_TABLE)
    .upsert(row, { onConflict: 'user_id' })
    .select(USER_DATA_COLUMNS)
    .single();

  if (error) throw error;
  return unpackRow(data);
}
