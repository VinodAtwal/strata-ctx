import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import {
  TierManager,
  type BudgetView,
  type TieredBlock,
  defaultTierManager,
} from '../src/tiers.js';
import type { ContentBlock } from '@strata-ctx/core-types';

function makeBlock(overrides: Partial<ContentBlock> = {}): ContentBlock {
  return {
    type: 'text',
    text: overrides.text ?? 'test content',
    meta: {
      origin: 'assistant',
      sha256: 'a'.repeat(64),
      tier: overrides.meta?.tier ?? 'episodic',
      bytes: overrides.text?.length ?? 12,
      cacheable: false,
      ...overrides.meta,
    },
    ...overrides,
  };
}

function makeGovernanceBlock(text = 'governance constraint'): ContentBlock {
  return makeBlock({
    text,
    meta: {
      origin: 'system',
      sha256: 'b'.repeat(64),
      tier: 'governance',
      bytes: text.length,
      cacheable: true,
    },
  });
}

function makeTieredBlock(metaOverrides: Partial<TieredBlock['meta']> = {}, overrides: Partial<TieredBlock> = {}): TieredBlock {
  const baseMeta: TieredBlock['meta'] = {
    origin: 'assistant',
    sha256: 'a'.repeat(64),
    tier: 'episodic',
    bytes: 12,
    cacheable: false,
    memoryTier: 'ephemeral',
    tierTurn: 0,
    ...metaOverrides,
  };
  return {
    type: 'text',
    text: 'test content',
    meta: baseMeta,
    ...overrides,
  };
}

describe('TierManager - Classification', () => {
  let manager: TierManager;

  beforeEach(() => {
    manager = new TierManager({ ephemeralWindowTurns: 10, summarizedWindowTurns: 50 });
  });

  test('classifies governance blocks as governance tier regardless of age', () => {
    const block = makeGovernanceBlock();
    const result = manager.classify(block, 100);
    assert.equal(result, 'governance');
  });

  test('classifies recent episodic blocks as ephemeral', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const result = manager.classify(block, 10);
    assert.equal(result, 'ephemeral');
  });

  test('classifies older episodic blocks as summarized', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const result = manager.classify(block, 20);
    assert.equal(result, 'summarized');
  });

  test('classifies very old episodic blocks as archived', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const result = manager.classify(block, 60);
    assert.equal(result, 'archived');
  });

  test('respects custom ephemeral window', () => {
    const customManager = new TierManager({ ephemeralWindowTurns: 5, summarizedWindowTurns: 20 });
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 0 });
    assert.equal(customManager.classify(block, 5), 'ephemeral');
    assert.equal(customManager.classify(block, 6), 'summarized');
  });

  test('classifies tool_state blocks by age', () => {
    const block = makeTieredBlock({ tier: 'tool_state', tierTurn: 0 });
    assert.equal(manager.classify(block, 5), 'ephemeral');
    assert.equal(manager.classify(block, 15), 'summarized');
    assert.equal(manager.classify(block, 55), 'archived');
  });
});

describe('TierManager - Promotion', () => {
  let manager: TierManager;

  beforeEach(() => {
    manager = new TierManager();
  });

  test('promotes ephemeral to governance', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const promoted = manager.promote(block, 'ephemeral', 'governance', 10);

    assert.equal(promoted.meta.memoryTier, 'governance');
    assert.equal(promoted.meta.tierTurn, 10);
    assert.equal(promoted.meta.sha256, block.meta.sha256);
  });

  test('promotes summarized to ephemeral', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const promoted = manager.promote(block, 'summarized', 'ephemeral', 10);

    assert.equal(promoted.meta.memoryTier, 'ephemeral');
    assert.equal(promoted.meta.tierTurn, 10);
  });

  test('promotes archived to summarized', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const promoted = manager.promote(block, 'archived', 'summarized', 10);

    assert.equal(promoted.meta.memoryTier, 'summarized');
  });

  test('throws on invalid promotion (wrong direction)', () => {
    const block = makeTieredBlock();
    assert.throws(
      () => manager.promote(block, 'ephemeral', 'summarized', 10),
      /promote must move to higher priority/,
    );
  });

  test('throws on same-tier promotion', () => {
    const block = makeTieredBlock();
    assert.throws(
      () => manager.promote(block, 'ephemeral', 'ephemeral', 10),
      /promote must move to higher priority/,
    );
  });

  test('preserves all original block properties', () => {
    const block = makeTieredBlock(
      { tier: 'tool_state', tierTurn: 3, subject: { kind: 'file', ref: 'src/main.ts', version: 'v1' }, severity: 'info', cacheable: true },
      { id: 'tool-123', toolName: 'read_file', text: 'file content' },
    );

    const promoted = manager.promote(block, 'summarized', 'ephemeral', 10);

    assert.equal(promoted.id, 'tool-123');
    assert.equal(promoted.toolName, 'read_file');
    assert.equal(promoted.text, 'file content');
    assert.deepEqual(promoted.meta.subject, block.meta.subject);
    assert.equal(promoted.meta.severity, 'info');
    assert.equal(promoted.meta.cacheable, true);
  });
});

describe('TierManager - Demotion', () => {
  let manager: TierManager;

  beforeEach(() => {
    manager = new TierManager();
  });

  test('demotes ephemeral to summarized', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const demoted = manager.demote(block, 'ephemeral', 'summarized', 20);

    assert.equal(demoted.meta.memoryTier, 'summarized');
    assert.equal(demoted.meta.tierTurn, 20);
  });

  test('demotes summarized to archived', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const demoted = manager.demote(block, 'summarized', 'archived', 60);

    assert.equal(demoted.meta.memoryTier, 'archived');
  });

  test('throws when demoting governance', () => {
    const block = makeGovernanceBlock();
    assert.throws(
      () => manager.demote(block, 'governance', 'ephemeral', 10),
      /cannot demote governance tier blocks/,
    );
  });

  test('throws on invalid demotion (wrong direction)', () => {
    const block = makeTieredBlock();
    assert.throws(
      () => manager.demote(block, 'summarized', 'ephemeral', 10),
      /demote must move to lower priority/,
    );
  });

  test('preserves block identity on demotion', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 5 });
    const demoted = manager.demote(block, 'ephemeral', 'summarized', 20);

    assert.equal(demoted.meta.sha256, block.meta.sha256);
  });
});

describe('TierManager - Compaction Eligibility', () => {
  let manager: TierManager;
  const baseBudget: BudgetView = {
    usedTokens: 50000,
    capacityTokens: 100000,
    softTriggerFrac: 0.85,
    hardTriggerFrac: 0.95,
  };

  beforeEach(() => {
    manager = new TierManager();
  });

  test('never compacts governance tier', () => {
    const budget = { ...baseBudget, usedTokens: 99000 };
    assert.equal(manager.shouldCompact('governance', budget), false);
  });

  test('compacts ephemeral only under hard budget', () => {
    const softBudget = { ...baseBudget, usedTokens: 86000 };
    const hardBudget = { ...baseBudget, usedTokens: 96000 };

    assert.equal(manager.shouldCompact('ephemeral', softBudget), false);
    assert.equal(manager.shouldCompact('ephemeral', hardBudget), true);
  });

  test('compacts summarized under soft budget', () => {
    const underSoft = { ...baseBudget, usedTokens: 80000 };
    const overSoft = { ...baseBudget, usedTokens: 86000 };

    assert.equal(manager.shouldCompact('summarized', underSoft), false);
    assert.equal(manager.shouldCompact('summarized', overSoft), true);
  });

  test('never compacts archived tier', () => {
    const budget = { ...baseBudget, usedTokens: 99000 };
    assert.equal(manager.shouldCompact('archived', budget), false);
  });

  test('handles edge case at exact trigger thresholds', () => {
    const atSoft = { ...baseBudget, usedTokens: 85000 };
    const atHard = { ...baseBudget, usedTokens: 95000 };

    assert.equal(manager.shouldCompact('summarized', atSoft), true);
    assert.equal(manager.shouldCompact('ephemeral', atHard), true);
    assert.equal(manager.shouldCompact('ephemeral', atSoft), false);
  });
});

describe('TierManager - Default Instance', () => {
  test('exports a default instance with standard config', () => {
    assert.ok(defaultTierManager instanceof TierManager);
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 0 });
    assert.equal(defaultTierManager.classify(block, 5), 'ephemeral');
    assert.equal(defaultTierManager.classify(block, 15), 'summarized');
  });
});

describe('TierManager - Block Identity Preservation', () => {
  let manager: TierManager;

  beforeEach(() => {
    manager = new TierManager();
  });

  test('promote preserves sha256 (block identity)', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 0 });
    const promoted = manager.promote(block, 'summarized', 'ephemeral', 10);
    assert.equal(promoted.meta.sha256, block.meta.sha256);
  });

  test('demote preserves sha256 (block identity)', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 0 });
    const demoted = manager.demote(block, 'ephemeral', 'summarized', 20);
    assert.equal(demoted.meta.sha256, block.meta.sha256);
  });

  test('promote/demote round-trip preserves identity', () => {
    const block = makeTieredBlock({ tier: 'episodic', tierTurn: 0 });
    const promoted = manager.promote(block, 'summarized', 'ephemeral', 10);
    const demoted = manager.demote(promoted, 'ephemeral', 'summarized', 20);
    assert.equal(demoted.meta.sha256, block.meta.sha256);
  });
});