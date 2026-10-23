const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const stripExports = source => source.replace(/^export\s+/gm, '');

function loadAdapter() {
  const source = stripExports(read('js/supabase-data.js')) + `
    globalThis.__testExports = { loadSupabaseUserData, saveSupabaseUserData };
  `;
  const context = vm.createContext({ console, Date });
  vm.runInContext(source, context, { filename: 'supabase-data.js' });
  return context.__testExports;
}

function loadClientModule() {
  const source = stripExports(read('js/supabase-client.js')) + `
    globalThis.__testExports = { createSupabaseClient, validateClientConfig };
  `;
  const context = vm.createContext({ console, Date, URL, atob: global.atob });
  vm.runInContext(source, context, { filename: 'supabase-client.js' });
  return context.__testExports;
}

const SUPABASE_USER_ID = '11111111-1111-4111-8111-111111111111';
const FIREBASE_UID = 'firebase-user-uid-that-is-not-a-supabase-uuid';

function fakeClient({ user = { id: SUPABASE_USER_ID, uid: FIREBASE_UID }, row = null, authError = null, queryError = null } = {}) {
  const calls = { getUser: 0, table: null, select: null, eq: null, upsert: null, maybeSingle: 0, single: 0 };
  const client = {
    auth: {
      async getUser() {
        calls.getUser++;
        return { data: { user }, error: authError };
      }
    },
    from(table) {
      calls.table = table;
      const query = {
        select(columns) { calls.select = columns; return query; },
        eq(column, value) { calls.eq = [column, value]; return query; },
        async maybeSingle() {
          calls.maybeSingle++;
          return { data: row, error: queryError };
        },
        upsert(value, options) { calls.upsert = { value, options }; return query; },
        async single() {
          calls.single++;
          const saved = calls.upsert && calls.upsert.value;
          return {
            data: row || (saved && {
              payload: saved.payload,
              schema_version: saved.schema_version ?? 1,
              revision: saved.revision ?? 0,
              updated_at: saved.updated_at
            }),
            error: queryError
          };
        }
      };
      return query;
    }
  };
  return { client, calls };
}

const toPlain = value => JSON.parse(JSON.stringify(value));

test('Supabase client config accepts publishable keys without embedding credentials', () => {
  const { validateClientConfig } = loadClientModule();
  assert.deepEqual(
    toPlain(validateClientConfig({ url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test-key' })),
    { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test-key' }
  );
});

test('Supabase client config rejects secret/service-role and malformed keys before loading the SDK', async () => {
  const { createSupabaseClient, validateClientConfig } = loadClientModule();
  assert.throws(
    () => validateClientConfig({ url: 'https://project.supabase.co', publishableKey: 'sb_secret_do-not-use' }),
    /must never be used in browser code/
  );
  assert.throws(
    () => validateClientConfig({ url: 'https://project.supabase.co', publishableKey: 'not-a-supabase-key' }),
    /publishable key or a legacy anon key/
  );
  await assert.rejects(createSupabaseClient({ url: '', publishableKey: '' }), /project URL is required/);
});

test('load reads the complete row using the Supabase Auth UUID, never a Firebase UID', async () => {
  const { loadSupabaseUserData } = loadAdapter();
  const payload = {
    cats: [{ id: 'push', label: 'Push' }],
    data: { 'Bench Press': [{ date: '2026-10-15', sets: [{ weight: 80, reps: 5, unit: 'kg' }] }] },
    futureField: { keep: true, nested: ['opaque', 7] }
  };
  const row = { payload, schema_version: 3, revision: 12, updated_at: '2026-10-15T12:00:00.000Z' };
  const { client, calls } = fakeClient({ row });

  const result = await loadSupabaseUserData(client);

  assert.equal(calls.table, 'user_data');
  assert.equal(calls.select, 'payload,schema_version,revision,updated_at');
  assert.deepEqual(calls.eq, ['user_id', SUPABASE_USER_ID]);
  assert.equal(calls.eq[1] === FIREBASE_UID, false);
  assert.deepEqual(toPlain(result), {
    payload,
    schemaVersion: 3,
    revision: 12,
    updatedAt: '2026-10-15T12:00:00.000Z'
  });
});

test('load returns null for a Supabase user with no row', async () => {
  const { loadSupabaseUserData } = loadAdapter();
  const { client } = fakeClient({ row: null });
  assert.equal(await loadSupabaseUserData(client), null);
});

test('save upserts the opaque full payload under the current Supabase Auth UUID', async () => {
  const { saveSupabaseUserData } = loadAdapter();
  const payload = {
    cats: ['existing app data'],
    workouts: [{ id: 'workout-1', exercises: [] }],
    unknownLegacyField: { preserve: ['all', 'nested', 'values'] }
  };
  const { client, calls } = fakeClient();

  const result = await saveSupabaseUserData(client, payload, { schemaVersion: 2, revision: 14 });

  assert.equal(calls.table, 'user_data');
  assert.equal(calls.upsert.value.user_id, SUPABASE_USER_ID);
  assert.notEqual(calls.upsert.value.user_id, FIREBASE_UID);
  assert.strictEqual(calls.upsert.value.payload, payload);
  assert.equal(calls.upsert.value.schema_version, 2);
  assert.equal(calls.upsert.value.revision, 14);
  assert.equal(calls.upsert.options.onConflict, 'user_id');
  assert.equal(Number.isNaN(Date.parse(calls.upsert.value.updated_at)), false);
  assert.deepEqual(toPlain(result.payload), payload);
});

test('save leaves schema/revision defaults alone unless metadata is explicitly supplied', async () => {
  const { saveSupabaseUserData } = loadAdapter();
  const payload = { arbitraryUnknownField: { retained: true } };
  const { client, calls } = fakeClient();

  await saveSupabaseUserData(client, payload);

  assert.equal(Object.hasOwn(calls.upsert.value, 'schema_version'), false);
  assert.equal(Object.hasOwn(calls.upsert.value, 'revision'), false);
  assert.strictEqual(calls.upsert.value.payload, payload);
});

test('adapter rejects missing Supabase identity, bad payloads, and backend errors', async () => {
  const { loadSupabaseUserData, saveSupabaseUserData } = loadAdapter();
  const noSupabaseSession = fakeClient({ user: { uid: FIREBASE_UID } });
  await assert.rejects(loadSupabaseUserData(noSupabaseSession.client), /signed-in Supabase Auth user/);
  assert.equal(noSupabaseSession.calls.table, null);

  const noClient = {};
  await assert.rejects(loadSupabaseUserData(noClient), /Supabase client with Auth support/);

  const invalidPayload = fakeClient();
  await assert.rejects(saveSupabaseUserData(invalidPayload.client, ['not', 'an', 'object']), /payload must be a JSON object/);
  assert.equal(invalidPayload.calls.getUser, 0);

  const authFailure = fakeClient({ authError: new Error('auth unavailable') });
  await assert.rejects(loadSupabaseUserData(authFailure.client), /auth unavailable/);
  assert.equal(authFailure.calls.table, null);

  const readFailure = fakeClient({ queryError: new Error('select denied') });
  await assert.rejects(loadSupabaseUserData(readFailure.client), /select denied/);
});
