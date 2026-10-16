// Fixture-based tests for scripts/migration/build-manifest.mjs (Phase 3a).
// Everything here is synthetic: uids/emails/uuids are made-up fixtures, no
// real account data, no network, no Firebase/Supabase contact. The script is
// loaded as an ES module via file URL (Node 18+) and additionally exercised
// end-to-end as a CLI child process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migration', 'build-manifest.mjs');

let modPromise = null;
function mod() {
  if (!modPromise) modPromise = import(pathToFileURL(SCRIPT).href);
  return modPromise;
}

// ── synthetic fixtures (fake, example.com/.org addresses only) ─────────────
const passwordRec = (uid, email, extra = {}) => ({
  uid,
  email,
  providerData: [{ providerId: 'password' }],
  ...extra
});

function validRecords() {
  return [
    passwordRec('fixture-uid-alpha', 'Alpha.User@Example.COM'),
    {
      uid: 'fixture-uid-bravo',
      email: ' bravo@example.com ',
      providerData: [{ providerId: 'password' }, { providerId: 'google.com' }]
    },
    {
      uid: 'fixture-uid-google',
      email: 'g@example.org',
      providerData: [{ providerId: 'google.com' }],
      disabled: true
    }
  ];
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function withTempInput(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifts-manifest-test-'));
  const input = path.join(dir, 'auth-export.jsonl');
  fs.writeFileSync(input, lines.join('\n') + '\n', 'utf8');
  return { dir, input, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ── pinning foundation ─────────────────────────────────────────────────────
test('uuidv5 pins follow RFC 4122 (vector cross-checked against Python stdlib)', async () => {
  const { uuidv5, pinForUid, UUID_RE } = await mod();
  // python3: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
  assert.equal(
    uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    '886313e1-3b8a-5372-9b90-0c9aee199e5d'
  );
  assert.match(pinForUid('fixture-uid-alpha'), UUID_RE);
  assert.match(pinForUid('fixture-uid-alpha'), /^[0-9a-f-]{36}$/);
  assert.equal(pinForUid('fixture-uid-alpha')[14], '5'); // deterministic v5 pin
});

// ── valid input ────────────────────────────────────────────────────────────
test('valid export builds exactly one row per user with hints, statuses and normalization', async () => {
  const { buildManifestFromText, formatManifest, UUID_RE } = await mod();
  const { rows, summary } = buildManifestFromText(JSON.stringify(validRecords()));

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.firebase_uid), [
    'fixture-uid-alpha',
    'fixture-uid-bravo',
    'fixture-uid-google'
  ]);
  assert.deepEqual(rows.map(r => r.provider_hint), [
    'password',
    'password+google.com',
    'google.com'
  ]);
  assert.deepEqual(rows.map(r => r.status), ['planned', 'planned', 'skipped']);
  assert.equal(rows[0].email, 'alpha.user@example.com'); // lowercased
  assert.equal(rows[1].email, 'bravo@example.com');      // trimmed + lowercased
  for (const r of rows) assert.match(r.supabase_uuid, UUID_RE);
  assert.deepEqual(Object.keys(rows[0]), [
    'firebase_uid', 'supabase_uuid', 'email', 'provider_hint', 'status'
  ]);
  assert.deepEqual(summary, {
    total: 3,
    byStatus: { planned: 2, provisioned: 0, data_imported: 0, verified: 0, conflict: 0, skipped: 1 }
  });
  const text = formatManifest(rows);
  assert.ok(text.endsWith('\n'));
  assert.equal(text.trim().split('\n').length, 3);
});

// ── uid is the only pin source; email never maps ───────────────────────────
test('pin depends only on the firebase uid, never on the email', async () => {
  const { buildManifestFromText, pinForUid } = await mod();
  const a = buildManifestFromText(JSON.stringify([passwordRec('fixture-uid-alpha', 'one@example.com')]));
  const b = buildManifestFromText(JSON.stringify([passwordRec('fixture-uid-alpha', 'totally.different@example.org')]));
  assert.equal(a.rows[0].supabase_uuid, b.rows[0].supabase_uuid);
  assert.equal(a.rows[0].supabase_uuid, pinForUid('fixture-uid-alpha'));
  assert.notEqual(
    a.rows[0].supabase_uuid,
    buildManifestFromText(JSON.stringify([passwordRec('fixture-uid-beta', 'one@example.com')])).rows[0].supabase_uuid
  );
});

test('same normalized email claimed by two uids is rejected as a conflicting mapping', async () => {
  const { buildManifestFromText } = await mod();
  const records = [
    passwordRec('fixture-uid-alpha', 'same@example.com'),
    passwordRec('fixture-uid-bravo', 'Same@Example.COM')
  ];
  assert.throws(
    () => buildManifestFromText(JSON.stringify(records)),
    err => err.name === 'ManifestBuildError'
      && /conflicting mapping/.test(err.message)
      && /refusing to guess/.test(err.message)
  );
});

// ── duplicates ─────────────────────────────────────────────────────────────
test('duplicate firebase uids are rejected', async () => {
  const { buildManifestFromText } = await mod();
  const records = [
    passwordRec('fixture-uid-alpha', 'first@example.com'),
    passwordRec('fixture-uid-alpha', 'second@example.com')
  ];
  assert.throws(
    () => buildManifestFromText(JSON.stringify(records)),
    err => err.name === 'ManifestBuildError'
      && /duplicate firebase uid "fixture-uid-alpha"/.test(err.message)
      && /one mapping per uid/.test(err.message)
  );
});

test('duplicate supabase uuids are rejected (explicit override vs explicit override)', async () => {
  const { buildManifestFromText } = await mod();
  const SHARED = '11111111-2222-4333-8444-555555555555';
  const records = [
    passwordRec('fixture-uid-alpha', 'first@example.com', { supabase_uuid: SHARED }),
    passwordRec('fixture-uid-bravo', 'second@example.com', { supabase_uuid: SHARED })
  ];
  assert.throws(
    () => buildManifestFromText(JSON.stringify(records)),
    err => err.name === 'ManifestBuildError'
      && /duplicate supabase uuid/.test(err.message)
      && /one-to-one/.test(err.message)
  );
});

test('duplicate supabase uuids are rejected (override colliding with a derived pin)', async () => {
  const { buildManifestFromText, pinForUid } = await mod();
  const records = [
    passwordRec('fixture-uid-alpha', 'first@example.com'),
    passwordRec('fixture-uid-bravo', 'second@example.com', {
      supabase_uuid: pinForUid('fixture-uid-alpha')
    })
  ];
  assert.throws(
    () => buildManifestFromText(JSON.stringify(records)),
    err => err.name === 'ManifestBuildError' && /duplicate supabase uuid/.test(err.message)
  );
});

// ── missing / malformed ────────────────────────────────────────────────────
test('a record with a missing firebase uid is rejected', async () => {
  const { buildManifestFromText } = await mod();
  assert.throws(
    () => buildManifestFromText(JSON.stringify([{ email: 'no-uid@example.com', providerData: [{ providerId: 'password' }] }])),
    err => err.name === 'ManifestBuildError' && /missing firebase uid/.test(err.message)
  );
});

test('a record with a missing email is rejected', async () => {
  const { buildManifestFromText } = await mod();
  assert.throws(
    () => buildManifestFromText(JSON.stringify([{ uid: 'fixture-uid-alpha', providerData: [{ providerId: 'password' }] }])),
    err => err.name === 'ManifestBuildError' && /missing email/.test(err.message)
  );
  assert.throws(
    () => buildManifestFromText(JSON.stringify([{ uid: 'fixture-uid-alpha', email: '   ', providerData: [{ providerId: 'password' }] }])),
    err => err.name === 'ManifestBuildError' && /missing email/.test(err.message)
  );
});

test('malformed supabase uuid overrides are rejected', async () => {
  const { buildManifestFromText } = await mod();
  for (const bad of ['not-a-uuid', '12345678-1234-5234-1234-567812345678' /* bad variant */, 42]) {
    assert.throws(
      () => buildManifestFromText(JSON.stringify([
        passwordRec('fixture-uid-alpha', 'first@example.com', { supabase_uuid: bad })
      ])),
      err => err.name === 'ManifestBuildError' && /malformed supabase_uuid/.test(err.message),
      `expected rejection for ${JSON.stringify(bad)}`
    );
  }
});

test('provider data must exist and be limited to known providers (nothing is inferred)', async () => {
  const { buildManifestFromText } = await mod();
  assert.throws(
    () => buildManifestFromText(JSON.stringify([{ uid: 'fixture-uid-alpha', email: 'a@example.com' }])),
    err => err.name === 'ManifestBuildError' && /missing provider data/.test(err.message)
  );
  assert.throws(
    () => buildManifestFromText(JSON.stringify([
      { uid: 'fixture-uid-alpha', email: 'a@example.com', providerData: [{ providerId: 'facebook.com' }] }
    ])),
    err => err.name === 'ManifestBuildError' && /unsupported sign-in provider "facebook.com"/.test(err.message)
  );
  assert.throws(
    () => buildManifestFromText(JSON.stringify([
      { uid: 'fixture-uid-alpha', email: 'a@example.com', providerData: [] }
    ])),
    err => err.name === 'ManifestBuildError' && /no supported sign-in providers/.test(err.message)
  );
});

test('empty manifests are refused', async () => {
  const { buildManifestFromText, buildManifest, parseExport } = await mod();
  for (const empty of ['', '   \n\n', '[]']) {
    assert.throws(
      () => buildManifestFromText(empty),
      err => err.name === 'ManifestBuildError' && /no user records/.test(err.message),
      `expected rejection for ${JSON.stringify(empty)}`
    );
  }
  assert.throws(() => buildManifest([]), /no user records/);
  assert.deepEqual(parseExport(''), []);
});

test('all validation problems are reported together, not one at a time', async () => {
  const { buildManifestFromText } = await mod();
  const records = [
    passwordRec('fixture-uid-alpha', 'alpha@example.com'),
    { email: 'missing-uid@example.com', providerData: [{ providerId: 'password' }] },
    { uid: 'fixture-uid-alpha', providerData: [{ providerId: 'password' }] }
  ];
  assert.throws(
    () => buildManifestFromText(JSON.stringify(records)),
    err => err.name === 'ManifestBuildError'
      && err.errors.length >= 2
      && /missing firebase uid/.test(err.message)
      && /missing email/.test(err.message)
  );
});

// ── input parsing ──────────────────────────────────────────────────────────
test('parseExport accepts JSON arrays and JSONL, and pinpoints invalid JSON lines', async () => {
  const { parseExport, buildManifest } = await mod();
  const arr = parseExport(JSON.stringify(validRecords()));
  assert.equal(arr.length, 3);
  assert.equal(arr[0].where, 'record 1');

  const jsonl = validRecords().map(r => JSON.stringify(r)).join('\n');
  const lines = parseExport(jsonl);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].where, 'line 1');

  assert.throws(
    () => parseExport('{"uid":"fixture-uid-alpha"}\n{oops\n'),
    err => err.name === 'ManifestBuildError' && /line 2: invalid JSON/.test(err.message)
  );
  assert.throws(
    () => parseExport('"just a string"'),
    err => err.name === 'ManifestBuildError' && /expected a JSON object/.test(err.message)
  );
  // bad JSONL lines abort the build — valid lines before them never yield rows
  assert.throws(() => buildManifest(parseExport('{"uid":"a@example"}\n')));
});

// ── determinism ────────────────────────────────────────────────────────────
test('output is deterministic: reruns and shuffled input are byte-identical', async () => {
  const { buildManifestFromText, formatManifest } = await mod();
  const records = validRecords();
  const text = JSON.stringify(records);
  const run1 = formatManifest(buildManifestFromText(text).rows);
  const run2 = formatManifest(buildManifestFromText(text).rows);
  assert.equal(run1, run2);

  const shuffled = JSON.stringify([records[2], records[0], records[1]]);
  const runShuffled = formatManifest(buildManifestFromText(shuffled).rows);
  assert.equal(run1, runShuffled);
  assert.ok(run1.includes('fixture-uid-alpha'));
});

// ── CLI ────────────────────────────────────────────────────────────────────
test('CLI: emits a pure JSONL manifest, a matching sha256, and identical bytes on rerun and --out', () => {
  const records = validRecords();
  const { dir, input, cleanup } = withTempInput(records.map(r => JSON.stringify(r)));
  try {
    const r1 = run([input]);
    assert.equal(r1.status, 0, r1.stderr);
    const lines = r1.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    lines.forEach(l => JSON.parse(l));

    const sha = /sha256=([0-9a-f]{64})/.exec(r1.stderr);
    assert.ok(sha, `stderr should carry a sha256 summary: ${r1.stderr}`);
    assert.equal(sha[1], crypto.createHash('sha256').update(r1.stdout, 'utf8').digest('hex'));
    assert.match(r1.stderr, /total=3/);
    assert.match(r1.stderr, /skipped=1/);

    const r2 = run([input]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r1.stdout, r2.stdout);

    const outPath = path.join(dir, 'manifest.jsonl');
    const r3 = run([input, '--out', outPath]);
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(fs.readFileSync(outPath, 'utf8'), r1.stdout);
  } finally {
    cleanup();
  }
});

test('CLI: refuses to write a manifest inside the repository', () => {
  const { input, cleanup } = withTempInput([JSON.stringify(passwordRec('fixture-uid-alpha', 'alpha@example.com'))]);
  const target = path.join(ROOT, 'should-never-exist-manifest.jsonl');
  try {
    const r = run([input, '--out', target]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /outside the repository/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    cleanup();
  }
});

test('CLI: usage and I/O problems exit 2 without side effects', () => {
  assert.equal(run([]).status, 2);
  const bogus = run(['--bogus-flag', 'whatever.jsonl']);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /unknown option/);
  const missing = run([path.join(os.tmpdir(), 'does-not-exist-lifts-export.jsonl')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read export/);
});
