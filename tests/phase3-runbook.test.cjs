// Offline fixture tests for docs/phase-3c-rehearsal-rollback-runbook.md
// (Phase 3c O6). These tests pin the run-book's structure, approval gating,
// disclaimers, and redaction/safety properties — they execute no rehearsal
// and contact no service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOC = path.join(__dirname, '..', 'docs', 'phase-3c-rehearsal-rollback-runbook.md');
const src = () => fs.readFileSync(DOC, 'utf8');
const slice = (text, from, to) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `section anchors missing: ${from} … ${to}`);
  return text.slice(a, b);
};

test('run-book exists with both parts, part C, and the no-performance disclaimer', () => {
  const s = src();
  assert.match(s, /# LIFTS Phase 3c — O6/);
  assert.ok(s.includes('## Part A — Test-account authentication rehearsal'));
  assert.ok(s.includes('## Part B — Manual rollback run-book'));
  assert.ok(s.includes('## Part C — Open decision: `firebase_uid_map` population'));
  assert.ok(s.includes('**No step in this document has been performed.**'), 'explicit no-performance disclaimer present');
  assert.ok(s.includes('OFFLINE DOCUMENTATION ONLY'));
});

test('Part A: every rehearsal area A1–A8 exists and is approval-gated; nothing claimed run', () => {
  const s = src();
  const a = slice(s, '## Part A', '## Part B');
  for (const hdr of ['### A1 — Email sign-up', '### A2 — Email sign-in and sign-out',
    '### A3 — Session persistence', '### A4a — Password reset', '### A4b — Password reset via the app UI',
    '### A5 — Account recovery', '### A6 — Multi-provider', '### A7 — Google sign-in + auto-link',
    '### A8 — App smoke']) {
    assert.ok(a.includes(hdr), 'missing section: ' + hdr);
  }
  const sections = a.split(/\n### /).slice(1).filter(sec => /^A[1-8]/.test(sec));
  assert.equal(sections.length, 9, 'A1–A8 plus A4a/A4b subsections'); // 8 ids, A4 split into a+b
  for (const sec of sections) {
    assert.ok(sec.includes('APPROVAL-GATED'), 'section not approval-gated: ' + sec.slice(0, 60));
    assert.ok(/\*\*Expected|\| Expected \|/.test(sec), 'section lacks expected results: ' + sec.slice(0, 60));
    assert.ok(/Failure condition/.test(sec), 'section lacks failure conditions: ' + sec.slice(0, 60));
  }
  assert.ok(a.includes('has not been tested'), 'auto-link claim explicitly withheld');
  assert.ok(a.includes('BLOCKING GATE'), 'A7 marked blocking');
  assert.ok(a.includes('NOT RUN'), 'precondition status shown as not run');
});

test('Part B: T_cutover, updated_at selection, git-revert rationale, and full rollback arc', () => {
  const s = src().replace(/\s+/g, ' '); // prose checks tolerate hand-wrapped lines
  const b = slice(s, '## Part B', '## Part C');
  assert.ok(b.includes('UTC instant the L9 cutover deployment'), 'T_cutover defined');
  assert.ok(b.includes('updated_at > T_cutover'), 'post-cutover selector documented');
  assert.ok(b.includes('git revert -m 1'), 'git revert step documented');
  assert.ok(b.includes('What this does NOT do'), 'frontend-revert insufficiency explained');
  assert.ok(b.includes('zero database operations'), 'why revert does not reverse DB writes');
  assert.ok(b.includes('recovery source of truth'), 'Firebase kept as recovery source');
  assert.ok(b.includes('until the window closes'), 'source-of-truth held through rollback window');
  assert.ok(b.includes('Never modify or delete anything in Firebase'), 'Firebase preservation rule');
  assert.ok(b.includes('strictly newer'), 'newer-data preservation rule');
  assert.ok(b.includes('skip the row, log it as a conflict'), 'conflict never overwrites');
  for (const hdr of ['### B.1 — Define `T_cutover`', '### B.2 — Preconditions', '### B.3 — `git revert`',
    '### B.4 — Identify post-cutover changes', '### B.5 — Preserve newer data', '### B.6 — Backup requirements',
    '### B.7 — Verification steps', '### B.8 — Abort conditions', '### B.9 — Recovery confirmation']) {
    assert.ok(b.includes(hdr), 'missing rollback stage: ' + hdr);
  }
  const bSections = b.split(/### /).filter(sec => /^B\./.test(sec));
  assert.equal(bSections.length, 9, 'B.1–B.9 all present');
  assert.ok(bSections.filter(sec => sec.includes('APPROVAL-GATED')).length >= 4, 'live rollback steps gated');
});

test('Part C: firebase_uid_map population documented as unresolved, not invented', () => {
  const s = src();
  const c = slice(s, '## Part C', '## Scope attestation');
  assert.ok(c.includes('UNRESOLVED'));
  assert.ok(c.includes('before L8'), 'settlement deadline stated');
  assert.ok(c.includes('does not choose'), 'no rule invented');
  assert.ok(c.includes('staging-smoke') && c.includes('synthetic smoke rows only'), 'synthetic writer distinguished from the missing real mechanism');
  assert.ok(c.includes('O4'), 'gate dependency referenced');
});

test('no performance claims, no credentials, no live endpoints anywhere in the run-book', () => {
  const s = src();
  for (const forbidden of ['✅', 'has been tested', 'have been tested', 'rehearsal passed',
    'was executed on', 'were executed on', 'GOOGLE_LINK_PROOF: PASS',
    'sb_secret_', 'service_role', 'eyJ', 'supabase.co', 'firebaseapp.com']) {
    assert.ok(!s.includes(forbidden), 'run-book must not contain: ' + forbidden);
  }
  assert.ok(s.includes('Nothing in Parts A or B has been executed'), 'scope attestation present');
  assert.ok((s.match(/APPROVAL-GATED/g) || []).length >= 15, 'every live step marked');
});
