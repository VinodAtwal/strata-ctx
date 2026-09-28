import type { ContentBlock } from '@strata-ctx/core-types';

/**
 * Memory storage tiers — distinct from pipeline triage tiers.
 * See docs/architecture.md §6.3.
 */
export type MemoryTier = 'governance' | 'ephemeral' | 'summarized' | 'archived';

/**
 * Budget view for compaction decisions.
 * See docs/architecture.md §5 (TriggerPolicy).
 */
export interface BudgetView {
  readonly usedTokens: number;
  readonly capacityTokens: number;
  readonly softTriggerFrac: number;
  readonly hardTriggerFrac: number;
}

/**
 * Block with memory-tier metadata attached.
 */
export interface TieredBlock extends ContentBlock {
  readonly meta: ContentBlock['meta'] & {
    readonly memoryTier: MemoryTier;
    /** Turn when this block was promoted/demoted to its current tier. */
    readonly tierTurn: number;
  };
}

/**
 * Configuration for tier classification.
 */
export interface TierClassificationConfig {
  /** Turns after which ephemeral blocks become summarized. */
  readonly ephemeralWindowTurns: number;
  /** Turns after which summarized blocks become archived. */
  readonly summarizedWindowTurns: number;
}

/**
 * TierManager handles classification, promotion, demotion, and compaction eligibility
 * for the four memory tiers.
 *
 * Governance: pinned constraints, never compacted, never evicted
 * Ephemeral: recent turns (tail window), compacted only under hard budget
 * Summarized: replaced by gist, recoverable via source_turn_range
 * Archived: cold storage, evicted from memory, on-disk only
 */
export class TierManager {
  private readonly config: TierClassificationConfig;

  constructor(config: Partial<TierClassificationConfig> = {}) {
    this.config = {
      ephemeralWindowTurns: config.ephemeralWindowTurns ?? 10,
      summarizedWindowTurns: config.summarizedWindowTurns ?? 50,
    };
  }

  /**
   * Classify a block into a memory tier based on its pipeline tier and age.
   *
   * @param block - The block to classify
   * @param currentTurn - The current turn number (for age calculation)
   * @returns The memory tier for this block
   */
  classify(block: ContentBlock, currentTurn: number): MemoryTier {
    const pipelineTier = block.meta.tier;
    const blockTurn = (block.meta as ContentBlock['meta'] & { tierTurn?: number }).tierTurn ?? 0;
    const age = currentTurn - blockTurn;

    // Governance blocks are always governance tier
    if (pipelineTier === 'governance') {
      return 'governance';
    }

    // Age-based classification for non-governance blocks
    if (age <= this.config.ephemeralWindowTurns) {
      return 'ephemeral';
    }
    if (age <= this.config.summarizedWindowTurns) {
      return 'summarized';
    }
    return 'archived';
  }

  /**
   * Promote a block to a higher-priority memory tier.
   * Adds tier metadata but preserves block identity (sha256).
   *
   * @param block - The block to promote
   * @param from - Source memory tier
   * @param to - Target memory tier (must be higher priority)
   * @param currentTurn - Current turn number for tierTurn
   * @returns New block with updated memory tier metadata
   * @throws If promotion direction is invalid
   */
  promote(block: ContentBlock, from: MemoryTier, to: MemoryTier, currentTurn: number): TieredBlock {
    this.assertValidTransition(from, to, 'promote');

    const tieredBlock = this.attachTierMetadata(block, to, currentTurn);
    return tieredBlock;
  }

  /**
   * Demote a block to a lower-priority memory tier.
   * Adds tier metadata and marks for potential eviction.
   *
   * @param block - The block to demote
   * @param from - Source memory tier
   * @param to - Target memory tier (must be lower priority)
   * @param currentTurn - Current turn number for tierTurn
   * @returns New block with updated memory tier metadata
   * @throws If demotion direction is invalid or attempting to demote governance
   */
  demote(block: ContentBlock, from: MemoryTier, to: MemoryTier, currentTurn: number): TieredBlock {
    if (from === 'governance') {
      throw new Error('cannot demote governance tier blocks');
    }
    this.assertValidTransition(from, to, 'demote');

    const tieredBlock = this.attachTierMetadata(block, to, currentTurn);
    return tieredBlock;
  }

  /**
   * Determine if a tier should be compacted given the current budget.
   *
   * Governance: never
   * Ephemeral: only under hard budget
   * Summarized: under soft budget
   * Archived: never (already evicted)
   *
   * @param tier - The memory tier to check
   * @param budget - Current budget view
   * @returns True if compaction should run for this tier
   */
  shouldCompact(tier: MemoryTier, budget: BudgetView): boolean {
    const usageFrac = budget.usedTokens / budget.capacityTokens;

    switch (tier) {
      case 'governance':
        return false; // Never compacted
      case 'ephemeral':
        return usageFrac >= budget.hardTriggerFrac; // Only under hard budget
      case 'summarized':
        return usageFrac >= budget.softTriggerFrac; // Under soft budget
      case 'archived':
        return false; // Already evicted from memory
    }
  }

  /**
   * Attach memory tier metadata to a block.
   */
  private attachTierMetadata(block: ContentBlock, tier: MemoryTier, currentTurn: number): TieredBlock {
    const existingMeta = block.meta;
    const newMeta: ContentBlock['meta'] & { readonly memoryTier: MemoryTier; readonly tierTurn: number } = {
      ...existingMeta,
      memoryTier: tier,
      tierTurn: currentTurn,
    };

    return {
      ...block,
      meta: newMeta,
    };
  }

  /**
   * Validate that a tier transition is in the correct direction.
   */
  private assertValidTransition(from: MemoryTier, to: MemoryTier, direction: 'promote' | 'demote'): void {
    const order: MemoryTier[] = ['governance', 'ephemeral', 'summarized', 'archived'];
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);

    if (fromIdx === -1 || toIdx === -1) {
      throw new Error(`invalid memory tier: ${from} -> ${to}`);
    }

    if (direction === 'promote' && toIdx >= fromIdx) {
      throw new Error(`promote must move to higher priority: ${from} -> ${to}`);
    }
    if (direction === 'demote' && toIdx <= fromIdx) {
      throw new Error(`demote must move to lower priority: ${from} -> ${to}`);
    }
  }
}

/**
 * Default tier manager instance with standard configuration.
 */
export const defaultTierManager = new TierManager();