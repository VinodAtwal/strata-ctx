import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  breakevenOk,
  budgetView,
  canonicalJson,
  DEFAULT_POLICY,
  estimateTokens,
  hashCanonical,
  StrataPolicySchema,
} from '../src/index.js';
import { block, message, state } from './fixtures.js';

test('DEFAULT_POLICY is fully populated by defaults', () => {
  assert.equal(DEFAULT_POLICY.version, 1);
  assert.equal(DEFAULT_POLICY.governance.pinning, 'required');
  assert.equal(DEFAULT_POLICY.pipeline.compaction, 'off', 'auto-compaction ships off');
  assert.equal(DEFAULT_POLICY.pipeline.tokenCompression, 'off', 'Tier 3 ships off');
  assert.equal(DEFAULT_POLICY.retention.keepPurgeLog, true);
  assert.deepEqual(DEFAULT_POLICY.constraints, []);
});

test('an empty constraint is rejected at load time', () => {
  const r = StrataPolicySchema.safeParse({
    version: 1,
    constraints: [{ id: 'c1', text: '   ', sha256: 'a'.repeat(64), source: 'user', kind: 'hard_safety', enforcement: 'block' }],
  });
  assert.equal(r.success, false, 'a blank constraint can never be enforced or detected as missing');
});

test('a constraint with a bad digest is rejected', () => {
  const r = StrataPolicySchema.safeParse({
    version: 1,
    constraints: [{ id: 'c1', text: 'x', sha256: 'ABC', source: 'user', kind: 'soft_policy', enforcement: 'block' }],
  });
  assert.equal(r.success, false);
});

test('keepPurgeLog cannot be switched off', () => {
  const r = StrataPolicySchema.safeParse({ version: 1, retention: { keepPurgeLog: false } });
  assert.equal(r.success, false, 'a purge with no record is indistinguishable from a cover-up');
});

test('an inverted trigger policy is rejected', () => {
  const soft = StrataPolicySchema.safeParse({ version: 1, pipeline: { trigger: { softTriggerFrac: 1.2 } } });
  assert.equal(soft.success, false);
});

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(hashCanonical({ b: 1, a: 2 }), hashCanonical({ a: 2, b: 1 }));
});

test('canonicalJson distinguishes structurally different values', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('breakeven: a big input cut affords generous output expansion', () => {
  // r=0.5, rho=4, k=0.1 -> allowance is 1 + 0.5/0.4 = 2.25x
  assert.equal(breakevenOk(0.5, 2.0, 4, 0.1), true);
  assert.equal(breakevenOk(0.5, 2.5, 4, 0.1), false);
});

test('breakeven: on an output-heavy workload the same cut affords almost nothing', () => {
  // k=0.5 -> allowance is 1 + 0.5/2.0 = 1.25x
  assert.equal(breakevenOk(0.5, 1.2, 4, 0.5), true);
  assert.equal(breakevenOk(0.5, 1.3, 4, 0.5), false);
});

test('breakeven with no attributable spend is vacuously fine', () => {
  assert.equal(breakevenOk(0.5, 10, 4, 0), true);
});

test('token estimation is monotonic in content size', () => {
  const small = state({ messages: [message('user', [block({ text: 'a'.repeat(10) })])] });
  const large = state({ messages: [message('user', [block({ text: 'a'.repeat(1000) })])] });
  assert.ok(estimateTokens(large) > estimateTokens(small));
});

test('budget view reserves output headroom before computing limits', () => {
  const b = budgetView(200_000, 8_192, 0.7, 0.85, 0.95);
  assert.equal(b.contextLimit, 200_000);
  assert.equal(b.softLimit, Math.floor(191_808 * 0.7));
  assert.ok(b.triggerAt < b.hardLimit, 'the sawtooth must fire before emergency eviction');
});

test('an unknown policy key is an error, not a silent default', () => {
  // zod strips unknown keys by default, so a typo would otherwise leave the
  // operator believing a feature is enabled when it is not.
  const r = StrataPolicySchema.safeParse({ version: 1, token_compression: true });
  assert.equal(r.success, false);
});

test('trigger policy is reachable from pipeline and is populated by default', () => {
  const d = StrataPolicySchema.parse({ version: 1 });
  assert.equal(d.pipeline.trigger.strategy, 'sawtooth');
  assert.equal(d.pipeline.trigger.softTriggerFrac, 0.85);
  assert.ok(d.pipeline.trigger.keepRecentTokens > 0);
});

test('an out-of-range softTriggerFrac is rejected', () => {
  assert.equal(
    StrataPolicySchema.safeParse({ version: 1, pipeline: { trigger: { softTriggerFrac: 1.2 } } }).success,
    false,
  );
  assert.equal(
    StrataPolicySchema.safeParse({ version: 1, pipeline: { trigger: { softTriggerFrac: 0 } } }).success,
    false,
  );
});

test('constraint text is trimmed so byte-equality checks are stable', () => {
  const p = StrataPolicySchema.parse({
    version: 1,
    constraints: [{ id: 'c1', text: '  no force push  ', sha256: 'a'.repeat(64), source: 'user', kind: 'soft_policy', enforcement: 'block' }],
  });
  assert.equal(p.constraints[0]?.text, 'no force push');
});
