import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ContentBlock,
  ContextState,
  LossyContext,
  LossyStage,
  LossyStageName,
  Message,
  NonGovernanceBlock,
  Role,
  StrataPolicy,
  TotalStage,
} from '@strata-ctx/core-types';
import {
  collectGovernanceText,
  enforcePins,
  estimateTokens,
  pinSetText,
  runId,
  sha256,
  StrataPolicySchema,
  verifyPinIntegrity,
} from '@strata-ctx/core-types';

import { LOSSY_TIER0_STAGES, PIPELINE_STAGE_ORDER } from '../src/order.js';
import { runPipeline } from '../src/runner.js';
import type { PipelineRun, StageResult } from '../src/runner.js';

/**
 * A-14 runner tests. Fixtures are inline by rule; nothing here imports another
 * package's test directory (development.md P2).
 */

const TIER_CAPS = { tool_state: 600, episodic: 900, artifact_ref: 400, user_intent: 2000 } as const;

type NonGovernanceMeta = NonGovernanceBlock['meta'];

function meta(over: Partial<NonGovernanceMeta> = {}): NonGovernanceMeta {
  return {
    origin: 'tool',
    sha256: sha256(over.subject?.ref ?? `seed-${over.tier ?? 'episodic'}`),
    tier: 'episodic',
    bytes: 100,
    cacheable: false,
    ...over,
  };
}

function block(over: Partial<NonGovernanceBlock> = {}): NonGovernanceBlock {
  const text = over.text ?? 'hello';
  return {
    type: 'text',
    text,
    meta: meta({ bytes: text.length }),
    ...over,
  };
}

function stateMessage(role: Role, content: readonly ContentBlock[], ts = 1_700_000_000_000): Message {
  return { role, content, ts };
}

function governanceBlock(text: string): ContentBlock {
  return {
    type: 'text',
    text,
    meta: {
      origin: 'system',
      sha256: sha256(text),
      tier: 'governance',
      bytes: text.length,
      cacheable: true,
    },
  };
}

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');
}

function lineArray(n: number, prefix = 'line'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
}

function toolResult(over: {
  readonly text: string;
  readonly kind?: NonNullable<NonGovernanceMeta['subject']>['kind'];
  readonly ref: string;
  readonly version?: string;
  readonly tier?: NonGovernanceMeta['tier'];
  readonly severity?: NonGovernanceMeta['severity'];
  readonly cacheable?: boolean;
  readonly id?: string;
}): NonGovernanceBlock {
  const subject: NonNullable<NonGovernanceMeta['subject']> = {
    kind: over.kind ?? 'command',
    ref: over.ref,
    ...(over.version === undefined ? {} : { version: over.version }),
  };
  return block({
    type: 'tool_result',
    text: over.text,
    id: over.id ?? `call-${over.ref}`,
    toolName: over.kind === 'file' ? 'Read' : 'Bash',
    meta: meta({
      subject,
      tier: over.tier ?? 'tool_state',
      bytes: over.text.length,
      sha256: sha256(`${over.ref}@${over.version ?? 'v0'}#${over.text.length}`),
      ...(over.severity === undefined ? {} : { severity: over.severity }),
      ...(over.cacheable === undefined ? {} : { cacheable: over.cacheable }),
    }),
  });
}

function state(over: Partial<ContextState> = {}): ContextState {
  return {
    messages: [
      stateMessage('system', [block({ text: 'CLAUDE.md' })]),
      stateMessage('user', [block({ text: 'do the thing' })]),
    ],
    pinned: [],
    tokenEstimate: 0,
    policyHash: sha256(''),
    runId: runId('run-1'),
    turn: 1,
    gists: [],
    artifacts: [],
    ...over,
  };
}

function policy(over: {
  readonly constraints?: readonly string[];
  readonly tierByteCaps?: Record<string, number>;
  readonly trigger?: Record<string, unknown>;
  readonly compaction?: StrataPolicy['pipeline']['compaction'];
  readonly stages?: StrataPolicy['pipeline']['stages'];
} = {}): StrataPolicy {
  return StrataPolicySchema.parse({
    version: 1,
    ...(over.constraints === undefined
      ? {}
      : {
          constraints: over.constraints.map((text, i) => ({
            id: `c${i + 1}`,
            text,
            sha256: sha256(text),
            source: 'org_policy',
            kind: 'soft_policy',
            enforcement: 'block',
          })),
        }),
    pipeline: {
      tierByteCaps: { ...TIER_CAPS, ...over.tierByteCaps },
      compaction: over.compaction ?? 'auto',
      ...(over.stages === undefined ? {} : { stages: over.stages }),
      ...(over.trigger === undefined ? {} : { trigger: over.trigger }),
    },
  });
}

const CONSTRAINTS = ['never force push to main', 'no secrets in commits'] as const;

/**
 * A transcript with most of the pipeline's hazards at once: pinned policy at
 * the head, a cacheable system prompt, the leading intent, an oversized failing
 * build log, an oversized file read, a re-read of that file (dedupe), and an
 * existing sub-cap read.
 */
function realisticState(over: Partial<ContextState> = {}): ContextState {
  const buildLog = [
    '> tsc --build',
    'src/a.ts(1,1): error TS2304: Cannot find name foo',
    ...lineArray(200, 'src/a.ts ok'),
    'src/b.ts(9,3): error TS2345: Argument of type string is not assignable',
    'Found 2 errors in 2 files.',
    'npm ERR! code ELIFECYCLE',
    ...lineArray(40, 'trailing noise'),
  ].join('\n');

  const fileBody = lines(400, 'export const value =');
  const secondRead = lines(400, 'export const value = ');

  return state({
    turn: 7,
    messages: [
      stateMessage('system', [
        governanceBlock(CONSTRAINTS[0]),
        block({
          text: 'project instructions: run the tests before claiming success',
          meta: meta({
            origin: 'system',
            tier: 'user_intent',
            bytes: 64,
            cacheable: true,
            sha256: sha256('system-prompt'),
          }),
        }),
      ]),
      stateMessage('user', [
        block({
          text: 'refactor the token estimator so it never throws on an empty context',
          meta: meta({ origin: 'user', tier: 'episodic', bytes: 70, cacheable: true, sha256: sha256('intent') }),
        }),
      ]),
      stateMessage('assistant', [
        block({
          type: 'tool_use',
          text: 'tsc --build',
          id: 'call-build',
          toolName: 'Bash',
          meta: meta({
            origin: 'assistant',
            tier: 'tool_state',
            bytes: 12,
            cacheable: true,
            sha256: sha256('tool_use-build'),
          }),
        }),
      ]),
      stateMessage('user', [
        toolResult({
          ref: 'tsc --build',
          text: buildLog,
          cacheable: true,
          id: 'call-build',
        }),
      ]),
      stateMessage('user', [toolResult({ ref: 'src/estimator.ts', kind: 'file', version: 'v1', text: fileBody })]),
      stateMessage('user', [toolResult({ ref: 'src/estimator.ts', kind: 'file', version: 'v2', text: secondRead })]),
      stateMessage('user', [toolResult({ ref: 'src/estimator.ts', kind: 'file', version: 'v2', text: secondRead })]),
      stateMessage('user', [
        toolResult({ ref: 'src/notes.md', kind: 'file', version: 'v1', text: 'small file, under the cap' }),
      ]),
      stateMessage('assistant', [
        block({
          text: 'the estimator is refactored; tests are green',
          meta: meta({ origin: 'assistant', tier: 'episodic', bytes: 45, sha256: sha256('assistant-reply') }),
        }),
      ]),
    ],
    ...over,
  });
}

const PINNED_POLICY = policy({ constraints: CONSTRAINTS });

/** The full Tier 0 registry, optionally overridden per name. */
function tier0Stages(
  over: Partial<Record<LossyStageName, LossyStage>> = {},
): Partial<Record<LossyStageName, LossyStage>> {
  const stages: Partial<Record<LossyStageName, LossyStage>> = {};
  for (const stage of LOSSY_TIER0_STAGES) stages[stage.name] = stage;
  for (const [name, stage] of Object.entries(over)) {
    if (stage !== undefined) stages[name as LossyStageName] = stage;
  }
  return stages;
}

/** Stage builders for the tunnel stages other workstreams will wire in. */
const pinStage = (p: StrataPolicy): TotalStage => ({
  name: 'pin',
  run: (s) => enforcePins(s, p).state,
});

const identityTotalStage = (name: 'pin' | 'serialize'): TotalStage => ({ name, run: (s) => s });

const throwingLossy = (name: LossyStageName): LossyStage => ({
  name,
  run: () => {
    throw new Error('boom');
  },
});

const identityLossy = (name: LossyStageName): LossyStage => ({ name, run: (c) => c });

/** The majority of the result without the nondeterministic clock measure. */
function shape(run: PipelineRun): unknown {
  return {
    ...run,
    stageResults: run.stageResults.map(({ name, ok, tokensIn, tokensOut, code }) => ({
      name,
      ok,
      tokensIn,
      tokensOut,
      code,
    })),
  };
}

describe('A-14 runner: happy path', () => {
  const run = runPipeline(realisticState(), { policy: PINNED_POLICY });

  it('runs the packaged Tier 0 stages in the documented order', () => {
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
    assert.deepEqual(
      run.stageResults.map((r) => r.name),
      PIPELINE_STAGE_ORDER.slice(0, 3),
    );
    assert.equal(run.failed, 0);
    assert.equal(run.halted, false);
  });

  it('records per-stage telemetry on every run stage', () => {
    assert.equal(run.stageResults.length, 3);
    for (const result of run.stageResults) {
      assert.equal(result.ok, true);
      assert.ok(result.durationMs >= 0);
      assert.ok(result.tokensIn >= 0);
      assert.ok(result.tokensOut >= 0);
      assert.equal(result.code, undefined);
    }
  });

  it('shrinks the context and chains tokenIn == previous tokenOut', () => {
    assert.ok(run.state.tokenEstimate < estimateTokens(realisticState()));
    for (let i = 1; i < run.stageResults.length; i += 1) {
      assert.equal(run.stageResults[i]?.tokensIn, run.stageResults[i - 1]?.tokensOut);
    }
  });

  it('runs all seven stages in order when the tunnel stages are wired', () => {
    const wired = runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({
        compact: identityLossy('compact'),
        compress: identityLossy('compress'),
      }),
      totalStages: {
        pin: pinStage(PINNED_POLICY),
        serialize: identityTotalStage('serialize'),
      },
    });
    assert.deepEqual(wired.stagesRun, PIPELINE_STAGE_ORDER);
    assert.deepEqual(wired.stagesRun, [
      'dedupe',
      'truncate',
      'triage',
      'pin',
      'compact',
      'compress',
      'serialize',
    ]);
    assert.equal(wired.stagesRun.length, 7);
  });

  it('does not mutate the state it was given', () => {
    const input = realisticState();
    const before = structuredClone(input);
    runPipeline(input, { policy: PINNED_POLICY });
    assert.deepEqual(input, before);
  });
});

describe('A-14 runner: per-stage error isolation (fail-open)', () => {
  const input = realisticState();

  it('isolates a throwing stage and still runs the later stages', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });

    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
    assert.deepEqual(run.stageResults.map((r) => r.ok), [true, false, true]);
    assert.equal(run.stageResults[1]?.code, 'stage_threw');
    assert.equal(run.failed, 1);
    assert.equal(run.halted, false);
    assert.ok(run.state.messages.length > 0, 'the request is not taken down');
  });

  it('passes the context through unmodified when a stage throws', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    const failed = run.stageResults[1];
    assert.ok(failed);
    assert.equal(failed.ok, false);
    assert.equal(failed.tokensOut, failed.tokensIn, 'tokensOut == tokensIn on fail-open');
  });

  it('reports only a typed code on failure, never a stack trace', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    const failed = run.stageResults[1];
    assert.ok(failed);
    assert.deepEqual(Object.keys(failed), ['name', 'ok', 'durationMs', 'tokensIn', 'tokensOut', 'code']);
    assert.equal('message' in failed, false);
    assert.equal('stack' in failed, false);
  });

  it('codes a stage that reorders the cached prefix', () => {
    const reorder: LossyStage = {
      name: 'dedupe',
      run: (c) => ({ ...c, messages: [...c.messages].reverse() }),
    };
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ dedupe: reorder }),
    });
    assert.equal(run.stageResults[0]?.ok, false);
    assert.equal(run.stageResults[0]?.code, 'prefix_reordered');
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage'], 'later stages still run');
  });

  it('codes a stage that hands back something that is not a LossyContext', () => {
    const forged: LossyStage = {
      name: 'triage',
      run: () => ({ messages: 'not messages' } as unknown as LossyContext),
    };
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ triage: forged }),
    });
    assert.equal(run.stageResults[2]?.ok, false);
    assert.equal(run.stageResults[2]?.code, 'not_a_lossy_context');
  });

  it('isolates a throwing total stage and still runs the later one', () => {
    const throwingPin: TotalStage = {
      name: 'pin',
      run: () => {
        throw new Error('governance exploded');
      },
    };
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      totalStages: { pin: throwingPin, serialize: identityTotalStage('serialize') },
    });
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage', 'pin', 'serialize']);
    assert.equal(run.stageResults[3]?.code, 'stage_threw');
    assert.equal(run.stageResults[4]?.ok, true, 'serialize still ran');
  });

  it('codes a total stage that returns a forged ContextState', () => {
    const forged: TotalStage = {
      name: 'pin',
      run: () => ({ messages: 'junk' } as unknown as ContextState),
    };
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      totalStages: { pin: forged, serialize: identityTotalStage('serialize') },
    });
    assert.equal(run.stageResults[3]?.ok, false);
    assert.equal(run.stageResults[3]?.code, 'not_a_context_state');
    assert.equal(run.stageResults[4]?.ok, true);
  });

  it('records every one of several independent failures', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({
        truncate: throwingLossy('truncate'),
        compact: throwingLossy('compact'),
      }),
    });
    assert.equal(run.failed, 2);
    assert.equal(run.stageResults.filter((r) => !r.ok).length, 2);
    assert.ok(run.stageResults.every((r, i) => (i === 1 || i === 3 ? !r.ok : r.ok)));
  });

  it('is fail-open by default even when told nothing about failing', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    assert.equal(run.halted, false);
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
    assert.ok(run.state.messages.length > 0);
  });
});

describe('A-14 runner: stopOnFailure (fail-closed opt-in)', () => {
  const input = realisticState();

  it('halts the run at the first failure', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      stopOnFailure: true,
    });
    assert.equal(run.halted, true);
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate'], 'triage never ran');
  });

  it('still records the failing stage in the report', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      stopOnFailure: true,
    });
    assert.equal(run.stageResults[1]?.ok, false);
    assert.equal(run.stageResults[1]?.code, 'stage_threw');
  });

  it('does not fire the hook for stages it never ran', () => {
    const seen: string[] = [];
    runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      stopOnFailure: true,
      onStage: (result) => seen.push(result.name),
    });
    assert.deepEqual(seen, ['dedupe', 'truncate']);
  });

  it('runs everything when nothing fails', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      stopOnFailure: true,
    });
    assert.equal(run.halted, false);
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
  });
});

describe('A-14 runner: governance invariant', () => {
  const input = realisticState();

  it('leaves pins byte-identical on the output when pin runs clean', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    const integrity = verifyPinIntegrity(pinSetText(PINNED_POLICY), collectGovernanceText(run.state));
    assert.equal(integrity.ok, true);
    assert.deepEqual(integrity.defects, []);
  });

  it('re-pins despite a stage failing before the pin position', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage', 'pin']);
    assert.equal(run.stageResults[1]?.ok, false);

    const integrity = verifyPinIntegrity(pinSetText(PINNED_POLICY), collectGovernanceText(run.state));
    assert.equal(integrity.ok, true, 'a failing earlier stage must not unpin the output');
    assert.deepEqual(integrity.defects, []);
  });

  it('keeps pins byte-identical when a lossy stage after pin fails', () => {
    const run = runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ compact: throwingLossy('compact') }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    assert.equal(run.stageResults[4]?.ok, false, 'compact failed after pin');
    const integrity = verifyPinIntegrity(pinSetText(PINNED_POLICY), collectGovernanceText(run.state));
    assert.equal(integrity.ok, true);
    assert.deepEqual(integrity.defects, []);
  });

  it('holds inbound governance verbatim when no pin stage is wired', () => {
    const run = runPipeline(input, { policy: PINNED_POLICY });
    assert.deepEqual(collectGovernanceText(run.state), [CONSTRAINTS[0]]);
  });
});

describe('A-14 runner: onStage observability', () => {
  it('fires once per run stage, in order, with the same records', () => {
    const seen: StageResult[] = [];
    const run = runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      onStage: (result) => seen.push(result),
    });
    assert.equal(seen.length, run.stageResults.length);
    assert.deepEqual(seen, run.stageResults);
    assert.deepEqual(seen.map((r) => r.name), ['dedupe', 'truncate', 'triage']);
  });

  it('hands the failure verdict to the hook', () => {
    const verdicts: { name: string; ok: boolean; code?: string }[] = [];
    runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      onStage: (result) =>
        verdicts.push({
          name: result.name,
          ok: result.ok,
          ...(result.code === undefined ? {} : { code: result.code }),
        }),
    });
    assert.deepEqual(verdicts, [
      { name: 'dedupe', ok: true },
      { name: 'truncate', ok: false, code: 'stage_threw' },
      { name: 'triage', ok: true },
    ]);
  });

  it('fires once for each stage even when the tunnel stages are wired', () => {
    const seen: string[] = [];
    runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({
        compact: identityLossy('compact'),
        compress: identityLossy('compress'),
      }),
      totalStages: {
        pin: pinStage(PINNED_POLICY),
        serialize: identityTotalStage('serialize'),
      },
      onStage: (result) => seen.push(result.name),
    });
    assert.deepEqual(Object.keys(seen).length ? seen : [], PIPELINE_STAGE_ORDER);
  });
});

describe('A-14 runner: hygiene', () => {
  it('treats an empty stage list as a no-op', () => {
    const input = realisticState();
    const run = runPipeline(input, { policy: PINNED_POLICY, lossyStages: {}, totalStages: {} });
    assert.equal(run.state, input, 'the very same object comes back');
    assert.deepEqual(run.stageResults, []);
    assert.deepEqual(run.stagesRun, []);
    assert.equal(run.failed, 0);
    assert.equal(run.halted, false);
  });

  it('skips tunnel stages that are not wired instead of crashing', () => {
    const run = runPipeline(realisticState(), { policy: PINNED_POLICY });
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
    assert.deepEqual(run.stagesRun, PIPELINE_STAGE_ORDER.slice(0, 3));
  });

  it('is deterministic: two runs produce identical state and reports', () => {
    const a = runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    const b = runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    assert.deepEqual(shape(a), shape(b));
  });

  it('is deterministic with a failure too', () => {
    const a = runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    const b = runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    assert.deepEqual(shape(a), shape(b));
  });

  it('handles an empty context', () => {
    const empty = state({ messages: [] });
    const run = runPipeline(empty, {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage', 'pin']);
    assert.equal(run.failed, 0);
    assert.deepEqual(collectGovernanceText(run.state), pinSetText(PINNED_POLICY));
  });

  it('reports monotonic, non-negative token counts', () => {
    const run = runPipeline(realisticState(), { policy: PINNED_POLICY });
    for (const result of run.stageResults) {
      assert.ok(Number.isInteger(result.tokensIn));
      assert.ok(Number.isInteger(result.tokensOut));
      assert.ok(result.tokensIn >= 0);
      assert.ok(result.tokensOut >= 0);
    }
  });
});

it('exports a runner whose default stage set is exactly the packaged Tier 0', () => {
  const run = runPipeline(realisticState(), { policy: PINNED_POLICY });
  assert.deepEqual(run.stagesRun, LOSSY_TIER0_STAGES.map((s) => s.name));
});