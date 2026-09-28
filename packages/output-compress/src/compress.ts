import type { ArtifactRef, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';

import type { MachineClassification } from './classify.js';
import { classifyMachineBlock } from './classify.js';
import type { EpsInput, EpsReport, FormatSavings } from './cost.js';
import { measureEps, measureFormatSavings } from './cost.js';
import type { JsonValue } from './json-value.js';
import { assertJsonValue } from './json-value.js';
import type { MachineFormat, ModelRegistry } from './registry.js';
import { DEFAULT_REGISTRY } from './registry.js';
import type { ReferenceReport } from './reference.js';
import { referenceOversized } from './reference.js';
import type { Selection } from './select.js';
import { DEFAULT_MIN_SAVINGS_FRAC, selectMachineFormat } from './select.js';

/**
 * Stage 7. SERIALIZE, and the end of the output-compression stream.
 *
 * ## The stage order here, and the reason for it
 *
 *   1. reference oversized blocks (H-6)
 *   2. classify each remaining block (H-3)
 *   3. select a format for the machine ones (H-2 + H-8)
 *   4. measure, and report a verdict (H-5)
 *
 * Referencing before serializing is not a performance detail. A 40kB table
 * compressed to 18kB is still 18kB sitting in the middle of a transcript, and
 * rot is about attention, not about structure. The coarse budget decision should
 * not depend on how well the fine one happens to work.
 *
 * ## Fail-open, at every level (N5, ADR-8, definition-of-done #4)
 *
 * The stage returns the context unmodified if it throws. A block that throws is
 * passed through unmodified. A format that throws loses only its own block. A
 * classifier that throws does not stop the next block from being tried. The cost
 * of getting this wrong is a user's tool result silently replaced by something
 * wrong; the cost of getting it too eager is a few tokens.
 *
 * ## What is not decided here
 *
 * Governance. The argument is `NonGovernanceMessage[]`, so a governance block is
 * not representable. That is the narrowing from core-types doing the work, and it
 * is why there is no `if (tier === 'governance')` guard here to get wrong.
 */

export interface OutputCompressPolicy {
  /**
   * The model this request is for. H-8's registry is keyed on it, and an
   * unrecognised id means JSON only -- see the note in ./registry.ts for why
   * that is the right default rather than a pessimistic one.
   */
  readonly model: string;
  /** `SerializationPolicy.machineFormat` from core-types, mapped through H-8. */
  readonly machineFormat: MachineFormat;
  readonly registry: ModelRegistry;
  readonly allowUnverifiedFormats: boolean;
  readonly minSavingsFrac: number;
  /** Optional table name, carried in the header. Omitted when absent. */
  readonly tableName?: string;
  readonly reference: { readonly enabled: boolean; readonly maxInlineBytes: number };
  /**
   * Serve format statistics (`rho`, `k`) for the breakeven verdict.
   *
   * Part of the policy rather than an argument: a stage that cannot be measured
   * is not done (definition-of-done #3), and a caller without them yet gets no
   * cost report rather than a made-up number.
   */
  readonly cost: { readonly rho: number; readonly k: number };
  /**
   * When a live `observed` measurement is supplied, let its verdict gate this
   * run. Off by default. A single request cannot measure `eps` about itself, so
   * gating without a paired comparison would be a coin flip presented as policy.
   */
  readonly gateOnCost: boolean;
}

export const DEFAULT_POLICY: OutputCompressPolicy = Object.freeze({
  model: '',
  machineFormat: 'toon',
  registry: DEFAULT_REGISTRY,
  allowUnverifiedFormats: false,
  minSavingsFrac: DEFAULT_MIN_SAVINGS_FRAC,
  reference: Object.freeze({ enabled: false, maxInlineBytes: 0 }),
  cost: Object.freeze({ rho: 4, k: 1 }),
  gateOnCost: false,
});

export type BlockAction = 'passthrough' | 'compressed' | 'referenced' | 'failed_open' | 'gated';

export interface BlockDecision {
  readonly sha256: string;
  readonly action: BlockAction;
  readonly format: MachineFormat;
  readonly reason: string;
  readonly charsBefore: number;
  readonly charsAfter: number;
}

export interface CompressReport {
  readonly blocks: number;
  readonly compressed: number;
  readonly referenced: number;
  readonly passthrough: number;
  readonly failedOpen: number;
  readonly gated: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  /**
   * Against the JSON the *same compressed blocks* would have carried, and
   * against nothing else.
   *
   * Narrow on purpose. The reference operator saves a great deal and is not
   * serialization's work, so crediting it here would let one stage be paid twice
   * and the other never measured.
   */
  readonly savings: FormatSavings;
  /**
   * `undefined` when no live measurement was supplied. A fixture-derived `eps`
   * must never be reported as a production number (R17), so absent measurement
   * means absent cost report, not a default verdict.
   */
  readonly cost: EpsReport | undefined;
  readonly reference: ReferenceReport;
  readonly decisions: readonly BlockDecision[];
  /** True when any block or artifact differs from the input. */
  readonly changed: boolean;
}

export interface CompressInput {
  readonly messages: readonly NonGovernanceMessage[];
  readonly artifacts: readonly ArtifactRef[];
  readonly policy: OutputCompressPolicy;
  /**
   * Paired token counts from a live A/B (E5). Absent on a normal request.
   */
  readonly observed?: EpsInput;
}

export interface CompressResult {
  readonly messages: readonly NonGovernanceMessage[];
  readonly artifacts: readonly ArtifactRef[];
  readonly report: CompressReport;
}

/**
 * `meta.sha256` is deliberately *not* updated on a compressed block.
 *
 * Same reasoning as B-3's pointer stub: the hash identifies the content the block
 * represents, so the dedupe and staleness keys upstream keep working across a
 * re-serialisation and `assertPrefixPreserved` still sees the same block rather
 * than a removal followed by an insertion. Re-hashing the stub would make every
 * compressed tool result look like a new subject to the next stage's dedupe.
 */
const withText = (block: NonGovernanceBlock, text: string): NonGovernanceBlock => ({
  ...block,
  text,
  meta: { ...block.meta, bytes: text.length },
});

/**
 * `JSON.parse` behind a declared return type, validated rather than asserted.
 *
 * The classifier has already established that the text is one JSON value, so the
 * validation cannot fail in practice -- which is exactly why it belongs here
 * rather than in a comment: `JSON.parse` returns `any`; handing that straight to
 * the selector would make the selector's first line untested, and the failure it
 * guards is a value we would then serialize into someone else's transcript.
 */
function parsePayload(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  // `JSON.parse` returns `any`; handing that straight to the selector would make
  // the selector's first line untested, and the failure it guards is a value we
  // would then serialize into someone else's transcript.
  assertJsonValue(parsed, 'the payload of a block classified as machine');
  return parsed;
}

interface BlockOutcome {
  readonly block: NonGovernanceBlock;
  readonly decision: BlockDecision;
  /** The original text, retained only when the block was compressed. */
  readonly baseline: string | undefined;
  readonly replacement: string | undefined;
}

function compressBlock(
  block: NonGovernanceBlock,
  policy: OutputCompressPolicy,
  gated: boolean,
): BlockOutcome {
  const before = block.text ?? '';
  const same: BlockDecision = {
    sha256: block.meta.sha256,
    action: 'passthrough',
    format: 'json',
    reason: '',
    charsBefore: before.length,
    charsAfter: before.length,
  };
  const hold = (decision: BlockDecision): BlockOutcome => ({
    block,
    decision,
    baseline: undefined,
    replacement: undefined,
  });

  if (gated) {
    return hold({
      ...same,
      action: 'gated',
      reason: 'the cost verdict said do_not_compress',
    });
  }
  if (policy.machineFormat === 'json') {
    return hold({ ...same, reason: 'the policy asks for plain JSON' });
  }

  let classification: MachineClassification;
  try {
    classification = classifyMachineBlock(block);
  } catch (error) {
    return hold({
      ...same,
      action: 'failed_open',
      reason: `the classifier threw, and was passed through: ${String(error)}`,
    });
  }
  if (!classification.machine) {
    return hold({ ...same, reason: `${classification.reason}: ${classification.detail}` });
  }

  let selection: Selection;
  try {
    selection = selectMachineFormat({
      value: parsePayload(before),
      model: policy.model,
      registry: policy.registry,
      preferred: policy.machineFormat,
      minSavingsFrac: policy.minSavingsFrac,
      jsonText: before,
      ...(policy.tableName === undefined ? {} : { name: policy.tableName }),
      allowUnverified: policy.allowUnverifiedFormats,
    });
  } catch (error) {
    return hold({
      ...same,
      action: 'failed_open',
      reason: `the selector threw, and was passed through: ${String(error)}`,
    });
  }

  if (selection.format === 'json' || selection.text === before) {
    return hold({ ...same, format: selection.format, reason: selection.reason });
  }
  return {
    block: withText(block, selection.text),
    decision: {
      sha256: block.meta.sha256,
      action: 'compressed',
      format: selection.format,
      reason: selection.reason,
      charsBefore: before.length,
      charsAfter: selection.text.length,
    },
    baseline: before,
    replacement: selection.text,
  };
}

const totalChars = (messages: readonly NonGovernanceMessage[]): number =>
  messages.reduce((n, m) => n + m.content.reduce((k, b) => k + (b.text ?? '').length, 0), 0);

/**
 * The unchanged-context result, for the fail-open path.
 *
 * `savings` is zero and the report is complete, because a stage that reports
 * nothing when it gives up is a stage nobody can debug.
 */
function unchangedResult(
  input: CompressInput,
  cost: EpsReport | undefined,
  reference: ReferenceReport,
  reason: string,
): CompressResult {
  const blocks = input.messages.reduce((n, m) => n + m.content.length, 0);
  return {
    messages: input.messages,
    artifacts: input.artifacts,
    report: {
      blocks,
      compressed: 0,
      referenced: reference.referenced,
      passthrough: blocks,
      failedOpen: blocks,
      gated: 0,
      charsBefore: totalChars(input.messages),
      charsAfter: totalChars(input.messages),
      savings: measureFormatSavings('', ''),
      cost,
      reference,
      decisions: Object.freeze(
        input.messages.flatMap((m) =>
          m.content.map((b) => ({
            sha256: b.meta.sha256,
            action: 'failed_open' as const,
            format: 'json' as const,
            reason,
            charsBefore: (b.text ?? '').length,
            charsAfter: (b.text ?? '').length,
          })),
        ),
      ),
      changed: false,
    },
  };
}

export function applyOutputCompression(input: CompressInput): CompressResult {
  const { policy } = input;
  const cost = input.observed === undefined ? undefined : measureEps(input.observed);
  const gated = policy.gateOnCost && cost !== undefined && cost.verdict === 'do_not_compress';

  let referenced: ReturnType<typeof referenceOversized>;
  try {
    referenced = referenceOversized(input.messages, input.artifacts, policy.reference);
  } catch (error) {
    return unchangedResult(
      input,
      cost,
      {
        referenced: 0,
        charsFreed: 0,
        artifactsAdded: 0,
        skippedDisabled: 0,
        skippedUnderCap: 0,
        skippedNotEligible: 0,
        skippedHighSeverity: 0,
        skippedAlreadyReference: 0,
        references: Object.freeze([]),
      },
      `the reference operator threw, so the context is unchanged: ${String(error)}`,
    );
  }

  // Which blocks the reference operator already handled, and what each one cost.
  // Keyed by sha because that is the identity the operator rewrote on, and read
  // once here rather than re-derived by sniffing stub text per block.
  const referencedBySha = new Map(
    referenced.report.references.map((r) => [r.sha256, r.originalChars] as const),
  );

  const decisions: BlockDecision[] = [];
  const baselines: string[] = [];
  const replacements: string[] = [];
  let compressed = 0;
  let passthrough = 0;
  let failedOpen = 0;
  let gatedCount = 0;
  let referencedCount = 0;
  let mutated = referenced.artifacts !== input.artifacts;

  const messages = referenced.messages.map((m) => {
    let touched = false;
    const content = m.content.map((block) => {
      const originalChars = referencedBySha.get(block.meta.sha256);
      if (originalChars !== undefined) {
        referencedCount += 1;
        decisions.push({
          sha256: block.meta.sha256,
          action: 'referenced',
          format: 'json',
          reason: 'the block was over the inline cap',
          charsBefore: originalChars,
          charsAfter: (block.text ?? '').length,
        });
        return block;
      }

      const outcome = compressBlock(block, policy, gated);
      decisions.push(outcome.decision);
      if (outcome.block === block) {
        passthrough += 1;
        if (outcome.decision.action === 'failed_open') failedOpen += 1;
        if (outcome.decision.action === 'gated') gatedCount += 1;
        return block;
      }
      compressed += 1;
      touched = true;
      if (outcome.baseline !== undefined && outcome.replacement !== undefined) {
        baselines.push(outcome.baseline);
        replacements.push(outcome.replacement);
      }
      return outcome.block;
    });
    if (touched) mutated = true;
    return touched ? { ...m, content } : m;
  });

  return {
    // Untouched messages are the very objects the reference operator returned, so
    // identity is preserved for free and `mutated` is the honest answer to "did
    // anything change", rather than a deep compare of a context that is mostly
    // large and mostly unchanged.
    messages,
    artifacts: referenced.artifacts,
    report: {
      blocks: decisions.length,
      compressed,
      referenced: referencedCount,
      passthrough,
      failedOpen,
      gated: gatedCount,
      charsBefore: totalChars(input.messages),
      charsAfter: totalChars(messages),
      savings: measureFormatSavings(baselines.join(''), replacements.join('')),
      cost,
      reference: referenced.report,
      decisions: Object.freeze(decisions),
      changed: mutated,
    },
  };
}
