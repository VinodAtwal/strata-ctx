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
  StageName,
  StrataPolicy,
  TotalStage,
} from '@strata-ctx/core-types';
import {
  collectGovernanceText,
  enforcePins,
  estimateTokens,
  GistSchema,
  pinSetText,
  runId,
  sha256,
  StrataPolicySchema,
  verifyPinIntegrity,
} from '@strata-ctx/core-types';

import { LOSSY_TIER0_STAGES, PIPELINE_STAGE_ORDER } from '../src/order.js';
import { asStageCode, runPipeline } from '../src/runner.js';
import type { AsyncLossyStage, PipelineRun, StageResult } from '../src/runner.js';

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

describe('A-14 runner: happy path', async () => {
  const run = await runPipeline(realisticState(), { policy: PINNED_POLICY });

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

  it('runs all seven stages in order when the tunnel stages are wired', async () => {
    const wired = await runPipeline(realisticState(), {
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

  it('does not mutate the state it was given', async () => {
    const input = realisticState();
    const before = structuredClone(input);
    await runPipeline(input, { policy: PINNED_POLICY });
    assert.deepEqual(input, before);
  });
});

describe('A-14 runner: per-stage error isolation (fail-open)', () => {
  const input = realisticState();

  it('isolates a throwing stage and still runs the later stages', async () => {
    const run = await runPipeline(input, {
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

  it('passes the context through unmodified when a stage throws', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    const failed = run.stageResults[1];
    assert.ok(failed);
    assert.equal(failed.ok, false);
    assert.equal(failed.tokensOut, failed.tokensIn, 'tokensOut == tokensIn on fail-open');
  });

  it('reports only a typed code on failure, never a stack trace', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    const failed = run.stageResults[1];
    assert.ok(failed);
    assert.deepEqual(Object.keys(failed), ['name', 'ok', 'durationMs', 'tokensIn', 'tokensOut', 'code']);
    assert.equal('message' in failed, false);
    assert.equal('stack' in failed, false);
  });

  it('codes a stage that reorders the cached prefix', async () => {
    const reorder: LossyStage = {
      name: 'dedupe',
      run: (c) => ({ ...c, messages: [...c.messages].reverse() }),
    };
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ dedupe: reorder }),
    });
    assert.equal(run.stageResults[0]?.ok, false);
    assert.equal(run.stageResults[0]?.code, 'prefix_reordered');
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage'], 'later stages still run');
  });

  it('codes a stage that hands back something that is not a LossyContext', async () => {
    const forged: LossyStage = {
      name: 'triage',
      run: () => ({ messages: 'not messages' } as unknown as LossyContext),
    };
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ triage: forged }),
    });
    assert.equal(run.stageResults[2]?.ok, false);
    assert.equal(run.stageResults[2]?.code, 'not_a_lossy_context');
  });

  it('isolates a throwing total stage and still runs the later one', async () => {
    const throwingPin: TotalStage = {
      name: 'pin',
      run: () => {
        throw new Error('governance exploded');
      },
    };
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      totalStages: { pin: throwingPin, serialize: identityTotalStage('serialize') },
    });
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage', 'pin', 'serialize']);
    assert.equal(run.stageResults[3]?.code, 'stage_threw');
    assert.equal(run.stageResults[4]?.ok, true, 'serialize still ran');
  });

  it('codes a total stage that returns a forged ContextState', async () => {
    const forged: TotalStage = {
      name: 'pin',
      run: () => ({ messages: 'junk' } as unknown as ContextState),
    };
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      totalStages: { pin: forged, serialize: identityTotalStage('serialize') },
    });
    assert.equal(run.stageResults[3]?.ok, false);
    assert.equal(run.stageResults[3]?.code, 'not_a_context_state');
    assert.equal(run.stageResults[4]?.ok, true);
  });

  it('records every one of several independent failures', async () => {
    const run = await runPipeline(input, {
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

  it('is fail-open by default even when told nothing about failing', async () => {
    const run = await runPipeline(input, {
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

  it('halts the run at the first failure', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      stopOnFailure: true,
    });
    assert.equal(run.halted, true);
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate'], 'triage never ran');
  });

  it('still records the failing stage in the report', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      stopOnFailure: true,
    });
    assert.equal(run.stageResults[1]?.ok, false);
    assert.equal(run.stageResults[1]?.code, 'stage_threw');
  });

  it('does not fire the hook for stages it never ran', async () => {
    const seen: string[] = [];
    await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
      stopOnFailure: true,
      onStage: (result) => seen.push(result.name),
    });
    assert.deepEqual(seen, ['dedupe', 'truncate']);
  });

  it('runs everything when nothing fails', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      stopOnFailure: true,
    });
    assert.equal(run.halted, false);
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
  });
});

describe('A-14 runner: governance invariant', () => {
  const input = realisticState();

  it('leaves pins byte-identical on the output when pin runs clean', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    const integrity = verifyPinIntegrity(pinSetText(PINNED_POLICY), collectGovernanceText(run.state));
    assert.equal(integrity.ok, true);
    assert.deepEqual(integrity.defects, []);
  });

  it('re-pins despite a stage failing before the pin position', async () => {
    const run = await runPipeline(input, {
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

  it('keeps pins byte-identical when a lossy stage after pin fails', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ compact: throwingLossy('compact') }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    assert.equal(run.stageResults[4]?.ok, false, 'compact failed after pin');
    const integrity = verifyPinIntegrity(pinSetText(PINNED_POLICY), collectGovernanceText(run.state));
    assert.equal(integrity.ok, true);
    assert.deepEqual(integrity.defects, []);
  });

  it('holds inbound governance verbatim when no pin stage is wired', async () => {
    const run = await runPipeline(input, { policy: PINNED_POLICY });
    assert.deepEqual(collectGovernanceText(run.state), [CONSTRAINTS[0]]);
  });
});

describe('A-14 runner: onStage observability', () => {
  it('fires once per run stage, in order, with the same records', async () => {
    const seen: StageResult[] = [];
    const run = await runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      onStage: (result) => seen.push(result),
    });
    assert.equal(seen.length, run.stageResults.length);
    assert.deepEqual(seen, run.stageResults);
    assert.deepEqual(seen.map((r) => r.name), ['dedupe', 'truncate', 'triage']);
  });

  it('hands the failure verdict to the hook', async () => {
    const verdicts: { name: string; ok: boolean; code?: string }[] = [];
    await runPipeline(realisticState(), {
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

  it('fires once for each stage even when the tunnel stages are wired', async () => {
    const seen: string[] = [];
    await runPipeline(realisticState(), {
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
  it('treats an empty stage list as a no-op', async () => {
    const input = realisticState();
    const run = await runPipeline(input, { policy: PINNED_POLICY, lossyStages: {}, totalStages: {} });
    assert.equal(run.state, input, 'the very same object comes back');
    assert.deepEqual(run.stageResults, []);
    assert.deepEqual(run.stagesRun, []);
    assert.equal(run.failed, 0);
    assert.equal(run.halted, false);
  });

  it('skips tunnel stages that are not wired instead of crashing', async () => {
    const run = await runPipeline(realisticState(), { policy: PINNED_POLICY });
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
    assert.deepEqual(run.stagesRun, PIPELINE_STAGE_ORDER.slice(0, 3));
  });

  it('is deterministic: two runs produce identical state and reports', async () => {
    const a = await runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    const b = await runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    assert.deepEqual(shape(a), shape(b));
  });

  it('is deterministic with a failure too', async () => {
    const a = await runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    const b = await runPipeline(realisticState(), {
      policy: PINNED_POLICY,
      lossyStages: tier0Stages({ truncate: throwingLossy('truncate') }),
    });
    assert.deepEqual(shape(a), shape(b));
  });

  it('handles an empty context', async () => {
    const empty = state({ messages: [] });
    const run = await runPipeline(empty, {
      policy: PINNED_POLICY,
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage', 'pin']);
    assert.equal(run.failed, 0);
    assert.deepEqual(collectGovernanceText(run.state), pinSetText(PINNED_POLICY));
  });

  it('reports monotonic, non-negative token counts', async () => {
    const run = await runPipeline(realisticState(), { policy: PINNED_POLICY });
    for (const result of run.stageResults) {
      assert.ok(Number.isInteger(result.tokensIn));
      assert.ok(Number.isInteger(result.tokensOut));
      assert.ok(result.tokensIn >= 0);
      assert.ok(result.tokensOut >= 0);
    }
  });
});

it('exports a runner whose default stage set is exactly the packaged Tier 0', async () => {
  const run = await runPipeline(realisticState(), { policy: PINNED_POLICY });
  assert.deepEqual(run.stagesRun, LOSSY_TIER0_STAGES.map((s) => s.name));
});
// ------------------------------------------------- P0-1: the cause is not dropped
//
// `asStageCode` is what the gateway reports lossy and total stage failures
// with. Before this it ended in `return 'stage_threw'`, so four distinct causes
// left this function as one code and the real condition was never reported. The
// test is written as a falsification: it asserts the mapping is total and
// injective, and then asserts the *property that actually broke* -- that no
// code this function does not recognise is reported as one it does.

describe('P0-1: asStageCode keeps causes distinct and never invents one', () => {
  const KNOWN = [
    'stage_threw',
    'prefix_reordered',
    'not_a_lossy_context',
    'not_a_context_state',
  ] as const;

  it('maps each known cause to itself, so the four stay four', () => {
    const mapped = KNOWN.map((code) => asStageCode(code));
    assert.deepEqual(mapped, [...KNOWN]);
    // Injective. Four causes, four codes: the property P0-1 was about.
    assert.equal(new Set(mapped).size, KNOWN.length);
  });

  it('has no code: undefined is not a failure', () => {
    // A stage that succeeded reports `undefined`. Mapping that to a failure
    // code would turn every clean run into an error event.
    assert.equal(asStageCode(undefined), undefined);
  });

  it('does not report an unrecognised cause as stage_threw', () => {
    // The mutation this test exists to catch. The old code returned
    // 'stage_threw' here, which is a different condition with a different fix:
    // an operator following it would debug a stage that works.
    assert.equal(asStageCode('something_order_ts_grew_a_new_code'), 'unrecognised_stage_code');
    // And it must not be one of the four either, or the same lie in a new coat.
    assert.ok(!KNOWN.includes(asStageCode('something_order_ts_grew_a_new_code') as never));
  });

  it('never returns undefined for a string, so a failure is never silently dropped', () => {
    for (const code of [...KNOWN, '', 'null', 'undefined', 'STAGE_THREW']) {
      const out = asStageCode(code);
      assert.notEqual(out, undefined, `code ${JSON.stringify(code)} was dropped`);
      assert.ok(typeof out === 'string' && out.length > 0);
    }
  });

  it('is case-sensitive, so a renamed code surfaces rather than resolving by luck', () => {
    assert.equal(asStageCode('Stage_Threw'), 'unrecognised_stage_code');
  });
});

// --------------------------------------------- C-13: the async stage port
//
// `compact` is the first stage that has to wait: its work is a transaction over
// a filesystem store, and `LossyStage.run` is in the frozen contract, so the
// wait belongs here rather than in a widening of core-types.
//
// "It awaits" is the easy half, so nothing below tests that a promise is
// awaited. What the suite is for is that a wait did not buy itself a second
// set of behavior: the order, the isolation of a failing stage, the closed set
// of codes, `stopOnFailure` and the telemetry all have to be the same for a
// stage that returned a promise as for one that did not, and a rejection has
// to be classified where a throw would be. Where the behavior did change --
// a `LossyStage` that returns a promise is now awaited instead of being coded
// `not_a_lossy_context` -- the test says so by name.

describe('C-13: runPipeline waits for a lossy stage, and isolates a rejection the way it isolates a throw', () => {
  const input = realisticState();

  const asyncStage = (
    name: LossyStageName,
    fn: (ctx: LossyContext) => LossyContext | Promise<LossyContext>,
  ): AsyncLossyStage => ({ name, run: fn });

  /**
   * The Tier 0 registry with the tunnel slots this suite exercises filled in.
   * One helper, not one per shape: `lossyStages` takes `LossyStage |
   * AsyncLossyStage`, and a suite that needed two names for it would be
   * asserting the old split rather than the behavior.
   */
  const tunnel = (
    over: Partial<Record<LossyStageName, LossyStage | AsyncLossyStage>>,
  ): Partial<Record<LossyStageName, LossyStage | AsyncLossyStage>> => ({
    ...tier0Stages(),
    ...over,
  });

  const dropLast = (ctx: LossyContext): LossyContext => ({
    ...ctx,
    messages: ctx.messages.slice(0, -1),
  });

  it('runs an async stage in its documented slot, after pin, and commits what it returned', async () => {
    const asyncRun = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({
        compact: asyncStage('compact', async (ctx) => {
          await Promise.resolve();
          return dropLast(ctx);
        }),
      }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    const syncRun = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({ compact: { name: 'compact', run: dropLast } }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });

    assert.deepEqual(asyncRun.stagesRun, ['dedupe', 'truncate', 'triage', 'pin', 'compact']);
    assert.equal(asyncRun.stageResults[4]?.ok, true, 'a stage that has to wait is not a failed stage');
    // The point of waiting. An unawaited promise is a forged return, so a
    // green run with the input's messages would mean the port is decorative.
    assert.deepEqual(shape(asyncRun), shape(syncRun));
    assert.notEqual(asyncRun.state.messages.length, input.messages.length);
  });

  it('runs a registry of plain LossyStages without the caller re-typing anything', async () => {
    // Every stage wired before C-13 returns a `LossyContext`, not a promise.
    // Widening the registry to admit `AsyncLossyStage` must not change what
    // they do or force a caller to convert them: the packaged Tier 0 stages run
    // in the documented order and commit normally.
    const run = await runPipeline(input, { policy: PINNED_POLICY });
    assert.deepEqual(run.stagesRun, LOSSY_TIER0_STAGES.map((s) => s.name));
    assert.ok(run.stageResults.every((result) => result.ok));
    assert.equal(run.failed, 0);
  });

  it('classifies a rejection exactly as it classifies a synchronous throw', async () => {
    const rejected = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({
        compact: asyncStage('compact', () => Promise.reject(new Error('boom'))),
      }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });
    const threw = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({ compact: throwingLossy('compact') }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
    });

    assert.equal(rejected.stageResults[4]?.code, 'stage_threw');
    // Same codes, same reverted state, same token counts: one classification
    // table for a stage that threw and a stage that rejected, or a caller would
    // get two answers to the same bug depending on which way it failed.
    assert.deepEqual(shape(rejected), shape(threw));
    const integrity = verifyPinIntegrity(pinSetText(PINNED_POLICY), collectGovernanceText(rejected.state));
    assert.equal(integrity.ok, true, 'fail-open must not cost a pin');
  });

  it('maps a rejection carrying the prefix-reorder cause to prefix_reordered', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({
        compact: asyncStage('compact', () =>
          Promise.reject(new Error('stage reordered blocks inside the cached prefix')),
        ),
      }),
    });
    // The mutation this test exists to catch: a second copy of the table in the
    // async path that ended in `return 'stage_threw'` would send an operator to
    // a stage that works, and the distinction R4 depends on would be gone.
    assert.equal(run.stageResults[3]?.code, 'prefix_reordered');
  });

  it('codes an async stage that resolves to something that is not a LossyContext', async () => {
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({
        compact: asyncStage('compact', () =>
          Promise.resolve({ messages: 'junk' } as unknown as LossyContext),
        ),
      }),
    });
    assert.equal(run.stageResults[3]?.ok, false);
    assert.equal(run.stageResults[3]?.code, 'not_a_lossy_context');
    const syncish = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({
        compact: { name: 'compact', run: () => ({ messages: 'junk' } as unknown as LossyContext) },
      }),
    });
    assert.equal(run.state.messages.length, syncish.state.messages.length);
  });

  it('commits the gists a lossy stage produced, not only its messages', async () => {
    const gist = GistSchema.parse({
      v: 1,
      task_id: 'task-1',
      status: 'complete',
      goal: 'ship the fix',
      next: { question: 'what breaks it?', next_command: 'npm run check' },
      log_gist: { raw_uri: 'gist://task-1' },
      constraints: [],
      source_turn_range: [0, 0],
      raw_recoverable: true,
      compressed_by: 'self-gist',
    });
    const commit = (ctx: LossyContext): Promise<LossyContext> =>
      Promise.resolve({ ...ctx, gists: [...ctx.gists, gist] });

    const asyncRun = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({ compact: asyncStage('compact', commit) }),
    });
    const syncRun = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({ compact: { name: 'compact', run: (ctx) => ({ ...ctx, gists: [...ctx.gists, gist] }) } }),
    });

    // `compact` is the first stage that writes to `gists`. Dropping it here
    // would leave a gist:// message in the transcript with no record in the
    // state that governance's type guard and ctx_status read.
    assert.equal(asyncRun.state.gists.length, 1);
    assert.deepEqual(asyncRun.state.gists[0], gist);
    assert.equal(syncRun.state.gists.length, 1);
  });

  it('halts after a rejected async stage when stopOnFailure is set', async () => {
    const seen: StageName[] = [];
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({
        compact: asyncStage('compact', () => Promise.reject(new Error('boom'))),
        compress: identityLossy('compress'),
      }),
      totalStages: { pin: pinStage(PINNED_POLICY) },
      stopOnFailure: true,
      onStage: (result) => seen.push(result.name),
    });
    assert.equal(run.halted, true);
    assert.deepEqual(seen, ['dedupe', 'truncate', 'triage', 'pin', 'compact']);
    assert.ok(!seen.includes('compress'));
    assert.equal(run.failed, 1);
  });

  it('awaits the promise a stage typed LossyStage returned instead of calling it forged', async () => {
    // This is the behavior that changed when the two runners merged. The sync
    // runner had no way to wait, so a promise out of a `LossyStage` was coded
    // `not_a_lossy_context` -- correct for a runner that cannot await, and a
    // trap once there is only one runner and it can. The forged-return guard is
    // about the value the stage *resolved to*, not about the shape of the
    // promise it returned.
    const promiseStage = {
      name: 'compact',
      run: (ctx: LossyContext) => Promise.resolve(dropLast(ctx)),
    } as unknown as LossyStage;
    const run = await runPipeline(input, {
      policy: PINNED_POLICY,
      lossyStages: tunnel({ compact: promiseStage }),
    });
    assert.equal(run.stageResults[3]?.ok, true, JSON.stringify(run.stageResults[3]));
    assert.equal(run.failed, 0);
    assert.notEqual(run.state.messages.length, input.messages.length, 'the awaited output was not committed');
  });
});
