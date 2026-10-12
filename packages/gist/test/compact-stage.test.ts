import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LossyContext, StrataPolicy } from '@strata-ctx/core-types';
import { partitionForLossy } from '@strata-ctx/core-types';
import { createCompactStage } from '../src/compact-stage.js';
import type { TransactionArtifactStore } from '../src/transaction.js';
import {
  createTestContextState,
  createTestPolicy,
  createMockArtifactStore,
  createTelemetryCapture,
} from './fixtures.js';

/** A test policy whose trigger fires almost immediately, so the stage runs. */
const triggeringPolicy = (overock: Partial<StrataPolicy['pipeline']> = {}): StrataPolicy => {
  const base = createTestPolicy();
  return {
    ...base,
    pipeline: {
      ...base.pipeline,
      compaction: 'auto',
      trigger: { ...base.pipeline.trigger, softTriggerFrac: 0.5, hardTriggerFrac: 0.9 },
      ...overock,
    },
    budgets: { contextLimit: 8, maxOutputTokens: 1, targetUtilization: 0.7 },
  };
};

const lossyOf = (policy: StrataPolicy): LossyContext =>
  partitionForLossy(createTestContextState(), policy);

describe('createCompactStage', () => {
  it('is a no-op when policy disables compaction', async () => {
    const policy = { ...triggeringPolicy(), pipeline: { ...triggeringPolicy().pipeline, compaction: 'off' as const } };
    const ctx = lossyOf(policy);
    const stage = createCompactStage({ store: createMockArtifactStore(), emit: () => {} });

    const out = await stage.run(ctx);

    assert.equal(out, ctx, 'off must return the same object, not a copy');
  });

  it('is a no-op below the sawtooth trigger', async () => {
    const policy: StrataPolicy = {
      ...createTestPolicy(),
      pipeline: { ...createTestPolicy().pipeline, compaction: 'auto' },
      // A window so large the context cannot approach the trigger.
      budgets: { contextLimit: 2_000_000, maxOutputTokens: 1, targetUtilization: 0.7 },
    };
    const ctx = lossyOf(policy);
    const stage = createCompactStage({ store: createMockArtifactStore(), emit: () => {} });

    assert.equal(await stage.run(ctx), ctx);
  });

  it('commits a gist and appends it to the context', async () => {
    const policy = triggeringPolicy();
    const ctx = lossyOf(policy);
    const telemetry = createTelemetryCapture();
    const store = createMockArtifactStore();
    const stage = createCompactStage({ store, emit: telemetry.emit, now: () => 1_000 });

    const out = await stage.run(ctx);

    assert.notEqual(out, ctx, 'a committed compaction returns a new context');
    assert.equal(out.gists.length, 1, 'exactly one gist is committed');
    const gist = out.gists[0];
    assert.ok(gist !== undefined);
    assert.equal(gist.raw_recoverable, true, 'the transaction stamps recoverability');
    assert.ok(
      out.messages.some((m) => m.content.some((b) => b.text === `gist://${gist.task_id}`)),
      'the gist message is resident',
    );
    assert.ok(
      telemetry.events.some((e) => e.type === 'compaction'),
      'the transaction emitted a compaction event',
    );
  });

  it('fails open, unchanged, when the store cannot be written', async () => {
    const policy = triggeringPolicy();
    const ctx = lossyOf(policy);
    const throwing: TransactionArtifactStore = {
      put: () => Promise.reject(new Error('store is read-only')),
      exists: () => Promise.resolve(false),
      read: () => Promise.reject(new Error('store is read-only')),
    };
    const stage = createCompactStage({ store: throwing, emit: () => {} });

    assert.equal(await stage.run(ctx), ctx, 'a refused flush must not drop anything');
  });
});
