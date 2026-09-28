import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ContentBlock,
  ContextState,
  Message,
  NonGovernanceBlock,
  NonGovernanceMessage,
  Role,
  StrataPolicy,
  Tier,
  TriggerPolicy,
} from '@strata-ctx/core-types';
import {
  enforcePins,
  estimateMessageTokens,
  budgetView,
  partitionForLossy,
  runId,
  sha256,
  StrataPolicySchema,
  taskId,
} from '@strata-ctx/core-types';

import { evaluateTrigger, reserveFor } from '../src/trigger.js';
import type { TriggerDecision } from '../src/trigger.js';
import {
  SELF_GIST_DIRECTIVE,
  SELF_GIST_RETAIN_CHARS,
  SELF_GIST_TAIL_CHARS,
  buildGistDraft,
  createSelfGistScanner,
  parseSelfGistDirective,
  retainTail,
  shouldSelfGist,
  stripGovernance,
} from '../src/self-gist.js';
import type { GistDraft, SelfGistDirective } from '../src/self-gist.js';

/**
 * B-8. Self-gist plumbing.
 *
 * Fixtures are inline (development §2, rule P2: no cross-stream test fixtures,
 * and no second fixture file in this package). The point of building the
 * transcript by hand here rather than reusing a helper is that three of the
 * properties under test are about *what is in the context*: a governance block
 * ahead of the range, a governance block smuggled in by cast, and an ordinary
 * turn with no directive in it at all.
 */

const CONSTRAINTS = ['never force push to main', 'no secrets in commits'] as const;

const TRIGGER: TriggerPolicy = {
  strategy: 'sawtooth',
  softTriggerFrac: 0.6,
  hardTriggerFrac: 0.85,
  keepRecentTokens: 8192,
  userMessageTailTokens: 20_000,
  reserveTokens: 16_000,
  taskBoundarySignals: ['task_complete', 'result_extracted'],
};

const BUDGETS = {
  contextLimit: 100_000,
  maxOutputTokens: 8_000,
  targetUtilization: 0.7,
};

const policy = (over: Partial<StrataPolicy> = {}): StrataPolicy =>
  StrataPolicySchema.parse({
    version: 1,
    constraints: CONSTRAINTS.map((text, i) => ({
      id: `c${i + 1}`,
      text,
      sha256: sha256(text),
      source: 'org_policy',
      kind: 'soft_policy',
      enforcement: 'block',
    })),
    ...over,
  });

type NonGovernanceMeta = NonGovernanceBlock['meta'];

const meta = (over: Partial<NonGovernanceMeta> = {}): NonGovernanceMeta => ({
  origin: 'tool',
  sha256: sha256(over.subject?.ref ?? `seed-${over.tier ?? 'episodic'}`),
  tier: 'episodic',
  bytes: 100,
  cacheable: false,
  ...over,
});

const block = (text: string, over: Partial<NonGovernanceBlock> = {}): NonGovernanceBlock => ({
  type: 'text',
  text,
  meta: meta({ bytes: text.length, ...over.meta }),
  ...over,
});

const message = (
  role: Role,
  content: readonly NonGovernanceBlock[],
  ts = 1_700_000_000_000,
): NonGovernanceMessage => ({ role, content, ts });

const stateMessage = (role: Role, content: readonly ContentBlock[], ts = 1_700_000_000_000): Message => ({
  role,
  content,
  ts,
});

const governanceBlock = (text: string): ContentBlock => ({
  type: 'text',
  text,
  meta: { origin: 'system', sha256: sha256(text), tier: 'governance', bytes: text.length, cacheable: true },
});

/** A pinned context: constraints materialised as governance blocks, then partitioned. */
function pinnedCtx(over: Partial<ContextState> = {}): ReturnType<typeof partitionForLossy> {
  const p = policy();
  const state: ContextState = {
    messages: [stateMessage('system', [governanceBlock(CONSTRAINTS[0]), governanceBlock(CONSTRAINTS[1])]), ...(over.messages ?? [])],
    pinned: [],
    tokenEstimate: 0,
    policyHash: sha256(''),
    runId: runId('run-1'),
    turn: 7,
    taskId: taskId('task-42'),
    gists: [],
    artifacts: [],
    ...over,
  };
  return partitionForLossy(enforcePins(state, p).state, p);
}

/** A pinned context whose lossy range contains only ordinary conversation. */
function conversationCtx(): ReturnType<typeof partitionForLossy> {
  return pinnedCtx({
    messages: [
      stateMessage('user', [block('refactor the estimator so it never throws')]),
      stateMessage('assistant', [block('read src/estimator.ts, found a throw on an empty context')]),
      stateMessage('user', [block('tsc --build', { meta: meta({ tier: 'tool_state', subject: { kind: 'command', ref: 'tsc --build' } }) })]),
    ],
  });
}

const at = (frac: number): number => {
  const view = budgetView(
    BUDGETS.contextLimit,
    reserveFor(BUDGETS, TRIGGER),
    BUDGETS.targetUtilization,
    TRIGGER.softTriggerFrac,
    TRIGGER.hardTriggerFrac,
  );
  return Math.floor(frac * (view.contextLimit - view.reserveOutput));
};

const decide = (frac: number, signals: string[] = []): TriggerDecision =>
  evaluateTrigger({
    tokens: at(frac),
    signals,
    trigger: TRIGGER,
    budgets: BUDGETS,
    compaction: 'auto',
  });

const GOOD_DIRECTIVE = [
  'I refactored the estimator and the suite is green.',
  '',
  SELF_GIST_DIRECTIVE.open + ' status=complete>',
  'goal: make the token estimator total over an empty context',
  'decided: D1 - hoist the guard into a zero-context branch (why: one exit, no caller changes) [rejected: returning 0 | silently allocating an empty context]',
  'decided: D2 - keep the 4-bytes-per-token constant (why: it is what the provider adapter already assumes)',
  'unresolved: the pointer stub line count still disagrees with the file on CRLF checkouts',
  'next_question: does the CRLF case reach the pointer stub?',
  'next_command: npx tsc -p packages/pipeline/tsconfig.json --noEmit',
  'blockers: the fixture repo is not checked out',
  'tests_run: npx tsc --build, node --test packages/pipeline/test',
  'verification: passing',
  SELF_GIST_DIRECTIVE.close,
].join('\n');

const EXPECTED_BODY = [
  'goal: make the token estimator total over an empty context',
  'decided: D1 - hoist the guard into a zero-context branch (why: one exit, no caller changes) [rejected: returning 0 | silently allocating an empty context]',
  'decided: D2 - keep the 4-bytes-per-token constant (why: it is what the provider adapter already assumes)',
  'unresolved: the pointer stub line count still disagrees with the file on CRLF checkouts',
  'next_question: does the CRLF case reach the pointer stub?',
  'next_command: npx tsc -p packages/pipeline/tsconfig.json --noEmit',
  'blockers: the fixture repo is not checked out',
  'tests_run: npx tsc --build, node --test packages/pipeline/test',
  'verification: passing',
].join('\n');

const draftFor = (
  directive: SelfGistDirective | null,
  ctx: ReturnType<typeof partitionForLossy> = conversationCtx(),
): GistDraft => buildGistDraft({ ctx, directive, sourceTurnRange: [0, ctx.messages.length - 1] });

/* -------------------------------------------------------------------------- */

describe('B-8 directive: the markers', () => {
  it('exposes one open and one close marker, and they are the ones that are parsed', () => {
    assert.equal(SELF_GIST_DIRECTIVE.open, '<ctx-gist');
    assert.equal(SELF_GIST_DIRECTIVE.close, '</ctx-gist>');
    assert.equal(SELF_GIST_DIRECTIVE.fenceOpen, '```ctx-gist');
    assert.equal(SELF_GIST_DIRECTIVE.fenceClose, '```');
    assert.ok(SELF_GIST_DIRECTIVE.instruction.includes(SELF_GIST_DIRECTIVE.open));
  });

  it('derives the retained tail from the markers, so a longer marker cannot break split detection', () => {
    assert.equal(
      SELF_GIST_TAIL_CHARS,
      Math.max(SELF_GIST_DIRECTIVE.open.length, SELF_GIST_DIRECTIVE.fenceOpen.length) - 1,
    );
    assert.ok(SELF_GIST_TAIL_CHARS < SELF_GIST_RETAIN_CHARS);
  });
});

describe('B-8 directive: detection', () => {
  it('finds a directive in a whole response and parses every field', () => {
    const d = parseSelfGistDirective(GOOD_DIRECTIVE);
    assert.ok(d !== null);
    assert.equal(d.complete, true);
    assert.equal(d.form, 'angle');
    assert.equal(d.status, 'complete');
    assert.equal(d.body, EXPECTED_BODY);
    assert.equal(d.fields.goal, 'make the token estimator total over an empty context');
    assert.deepEqual(d.fields.unresolved, [
      'the pointer stub line count still disagrees with the file on CRLF checkouts',
    ]);
    assert.equal(d.fields.nextQuestion, 'does the CRLF case reach the pointer stub?');
    assert.equal(d.fields.nextCommand, 'npx tsc -p packages/pipeline/tsconfig.json --noEmit');
    assert.deepEqual(d.fields.blockers, ['the fixture repo is not checked out']);
    assert.deepEqual(d.fields.testsRun, [
      'npx tsc --build',
      'node --test packages/pipeline/test',
    ]);
    assert.equal(d.fields.verification, 'passing');
    assert.deepEqual(d.fields.decided[0], {
      id: 'D1',
      choice: 'hoist the guard into a zero-context branch',
      why: 'one exit, no caller changes',
      alternatives_rejected: ['returning 0', 'silently allocating an empty context'],
    });
    assert.equal(d.fields.decided[1]?.id, 'D2');
    assert.equal(d.defects.length, 0, JSON.stringify(d.defects));
  });

  it('finds the fenced form the architecture calls for', () => {
    const text = [
      'done.',
      '```ctx-gist status=blocked',
      'goal: land the contract',
      'blockers: legal review',
      '```',
    ].join('\n');
    const d = parseSelfGistDirective(text);
    assert.ok(d !== null);
    assert.equal(d.form, 'fence');
    assert.equal(d.complete, true);
    assert.equal(d.status, 'blocked');
    assert.equal(d.fields.goal, 'land the contract');
  });

  it('returns null for ordinary prose, including prose about compaction', () => {
    // The model writing the word "gist" is not a request for one.
    for (const text of [
      '',
      'I will summarise the turn once the tests pass.',
      'The context pipeline compacts at a task boundary; see architecture 5.',
      'a fenced code block that is not a gist\n```ts\nconst x = 1;\n```',
      'a truncated sentinel that never becomes one: <ctx-gis',
    ]) {
      assert.equal(parseSelfGistDirective(text), null, JSON.stringify(text));
    }
  });

  it('ignores an orphan close sentinel rather than inventing a directive', () => {
    // Any prose ending in a fence would otherwise trigger compaction.
    assert.equal(parseSelfGistDirective('unrelated\n```\n'), null);
    assert.equal(parseSelfGistDirective('</ctx-gist>'), null);
  });

  it('reports an unterminated block as incomplete instead of throwing or claiming null', () => {
    const d = parseSelfGistDirective(`${SELF_GIST_DIRECTIVE.open} status=partial>\ngoal: half a thought`);
    assert.ok(d !== null);
    assert.equal(d.complete, false);
    assert.equal(d.close, null);
    assert.equal(d.fields.goal, 'half a thought');
    assert.ok(d.defects.some((x) => x.kind === 'unterminated'));
  });

  it('reports an open sentinel with no header terminator as incomplete', () => {
    const d = parseSelfGistDirective('…and then <ctx-gist status=complete');
    assert.ok(d !== null);
    assert.equal(d.complete, false);
    assert.ok(d.defects.some((x) => x.kind === 'unterminated'));
    assert.ok(d.defects.some((x) => x.kind === 'no_goal'));
  });

  it('degrades an unknown status to partial and keeps the gist (fail toward more context)', () => {
    // Discarding a whole gist -- and the unresolved item in it -- over a bad
    // enum would be the opposite of fail-open.
    const d = parseSelfGistDirective(
      `${SELF_GIST_DIRECTIVE.open} status=banana>\ngoal: keep me\n${SELF_GIST_DIRECTIVE.close}`,
    );
    assert.ok(d !== null);
    assert.equal(d.status, 'partial');
    assert.equal(d.fields.goal, 'keep me');
    assert.ok(d.defects.some((x) => x.kind === 'unknown_status' && x.detail === 'banana'));
  });

  it('ignores malformed field lines and records them instead of guessing', () => {
    const d = parseSelfGistDirective(
      [
        SELF_GIST_DIRECTIVE.open + '>',
        'goal: parse defensively',
        'this line has no key',
        'decided: D1',
        'unresolved: the scary one survives',
        'budget: 40kB',
        SELF_GIST_DIRECTIVE.close,
      ].join('\n'),
    );
    assert.ok(d !== null);
    assert.equal(d.fields.goal, 'parse defensively');
    assert.deepEqual(d.fields.unresolved, ['the scary one survives']);
    assert.deepEqual(d.fields.decided, []);
    const kinds = d.defects.map((x) => x.kind);
    assert.ok(kinds.includes('unknown_field'));
    assert.ok(kinds.includes('malformed_decision'));
  });

  it('flags an empty body rather than passing it on as a gist', () => {
    const d = parseSelfGistDirective(
      `${SELF_GIST_DIRECTIVE.open}>${SELF_GIST_DIRECTIVE.close}`,
    );
    assert.ok(d !== null);
    assert.equal(d.complete, true);
    assert.ok(d.defects.some((x) => x.kind === 'empty_body'));
    assert.ok(d.defects.some((x) => x.kind === 'no_goal'));
  });
});

describe('B-8 directive: the split-boundary sweep', () => {
  const FENCED = GOOD_DIRECTIVE.replace(SELF_GIST_DIRECTIVE.open, SELF_GIST_DIRECTIVE.fenceOpen).replace(
    SELF_GIST_DIRECTIVE.close,
    SELF_GIST_DIRECTIVE.fenceClose,
  );

  it('finds the directive no matter which byte the two chunks are split at', () => {
    for (const text of [GOOD_DIRECTIVE, FENCED]) {
      for (let k = 0; k <= text.length; k += 1) {
        const scanner = createSelfGistScanner();
        const first = scanner.push(text.slice(0, k));
        const second = scanner.push(text.slice(k));
        const d = second.directive ?? first.directive;
        assert.ok(d !== null, `no directive at split ${k}`);
        assert.equal(d.complete, true, `incomplete at split ${k}`);
        assert.equal(d.body, EXPECTED_BODY, `wrong body at split ${k}`);
      }
    }
  });

  it('finds the directive one character at a time', () => {
    const scanner = createSelfGistScanner();
    let found: SelfGistDirective | null = null;
    for (let i = 0; i < GOOD_DIRECTIVE.length; i += 1) {
      const scan = scanner.push(GOOD_DIRECTIVE[i] ?? '');
      if (scan.directive !== null) found = scan.directive;
      if (scan.complete) break;
    }
    assert.ok(found !== null);
    assert.equal(found.complete, true);
    assert.equal(found.body, EXPECTED_BODY);
  });

  it('gives the same answer through the single-shot parse plus the retained tail', () => {
    for (let k = 0; k <= GOOD_DIRECTIVE.length; k += 1) {
      const head = GOOD_DIRECTIVE.slice(0, k);
      const tail = GOOD_DIRECTIVE.slice(k);
      // With only the head, the block is at best unterminated -- never a gist.
      if (k < GOOD_DIRECTIVE.length) assert.notEqual(parseSelfGistDirective(head)?.complete, true);
      const d = parseSelfGistDirective(tail, { carried: retainTail(head) });
      assert.ok(d !== null, `no directive at split ${k}`);
      assert.equal(d.complete, true, `incomplete at split ${k}`);
      assert.equal(d.body, EXPECTED_BODY, `wrong body at split ${k}`);
    }
  });

  it('drives the single-shot parse chunk by chunk off the same retention rule', () => {
    const scanner = createSelfGistScanner();
    let carried = '';
    let found: SelfGistDirective | null = null;
    let forwarded = '';
    for (let i = 0; i < GOOD_DIRECTIVE.length; i += 7) {
      const chunk = GOOD_DIRECTIVE.slice(i, i + 7);
      const d = parseSelfGistDirective(chunk, { carried });
      if (d !== null) found = d;
      const scan = scanner.push(chunk);
      forwarded += scan.forward;
      carried = retainTail(chunk, carried);
    }
    const tail = parseSelfGistDirective('', { carried });
    if (tail !== null) found = tail;
    assert.ok(found !== null);
    assert.equal(found.complete, true);
    assert.equal(found.body, EXPECTED_BODY);
    // What the scanner did not forward is exactly the directive and nothing
    // after it, so the hand-driven path and the scanner split the same bytes.
    assert.ok(GOOD_DIRECTIVE.startsWith(forwarded));
    assert.equal(GOOD_DIRECTIVE.slice(forwarded.length), found.raw);
  });

  it('retains enough of the tail that a marker straddling a boundary is found', () => {
    // One byte short of the open marker, delivered in its own chunk. Forwarding
    // everything but the last SELF_GIST_TAIL_CHARS is the price of catching this,
    // and it is the only buffering that happens before a directive exists.
    const prose = 'prose before the block ';
    const head = prose + SELF_GIST_DIRECTIVE.open.slice(0, -1);
    const scanner = createSelfGistScanner();
    const first = scanner.push(head);
    assert.equal(first.directive, null);
    assert.equal(first.retain.length, SELF_GIST_TAIL_CHARS);
    assert.equal(first.forward, head.slice(0, head.length - SELF_GIST_TAIL_CHARS));
    assert.equal(first.forward + first.retain, head);

    const second = scanner.push(
      SELF_GIST_DIRECTIVE.open.slice(-1) + ' status=partial>\ngoal: x\n' + SELF_GIST_DIRECTIVE.close,
    );
    assert.ok(second.directive !== null);
    assert.equal(second.directive.complete, true);
    assert.equal(first.forward + second.forward, prose, 'every byte before the marker is out');
    assert.equal(second.retain, '', 'the block itself is consumed, not re-emitted');
    assert.equal(scanner.buffered, 0);
    assert.equal((first.forward + second.forward).includes(SELF_GIST_DIRECTIVE.open), false);
  });

  it('forwards everything before the sentinel and nothing after it', () => {
    // architecture §9: pass-through, or first-token delta is affected (N3).
    const scanner = createSelfGistScanner();
    const preamble = 'I read the file. I fixed the throw. Here is the summary.\n';
    const chunks = ['I read the file. ', 'I fixed the throw. ', 'Here is the summary.\n'];
    let forwarded = '';
    for (const c of chunks) {
      const scan = scanner.push(c);
      forwarded += scan.forward;
      assert.equal(scan.forward.includes(SELF_GIST_DIRECTIVE.open), false);
      assert.ok(scan.buffered <= SELF_GIST_TAIL_CHARS);
    }
    assert.equal(
      forwarded.length + scanner.buffered,
      preamble.length,
      'only the boundary tail is held back',
    );

    // The push that completes the open marker is also the one that releases the
    // last of the preamble; from the marker onwards nothing is forwarded until
    // the block closes. The carry is still inside the scanner, so only the bytes
    // past it are new.
    const unbuffered = preamble.slice(forwarded.length + scanner.buffered);
    assert.equal(unbuffered, '', 'the whole preamble is either forwarded or retained');
    const opened = scanner.push(`${unbuffered}${SELF_GIST_DIRECTIVE.open} status=partial>\ngoal: x`);
    forwarded += opened.forward;
    assert.equal(forwarded, preamble, 'the whole preamble is out before the block is');
    assert.equal(opened.retain.startsWith(SELF_GIST_DIRECTIVE.open), true);

    const closed = scanner.push(`\n${SELF_GIST_DIRECTIVE.close}\nand that is all.`);
    // The block is consumed exactly; the newline after it is ordinary text and
    // passes through with everything that follows.
    assert.equal(closed.forward, '\nand that is all.');
    assert.equal(closed.retain, '');
    assert.equal(scanner.buffered, 0);
  });

  it('stops buffering once the block closes', () => {
    const scanner = createSelfGistScanner();
    scanner.push('preamble');
    scanner.push(`${SELF_GIST_DIRECTIVE.open}>\ngoal: x\n${SELF_GIST_DIRECTIVE.close}`);
    assert.equal(scanner.done, true);
    const after = scanner.push('more prose');
    assert.equal(after.forward, 'more prose');
    assert.equal(after.retain, '');
  });

  it('bounds the buffer and marks an over-long block truncated', () => {
    const scanner = createSelfGistScanner({ retainChars: 64 });
    const scan = scanner.push(`${SELF_GIST_DIRECTIVE.open}>\ngoal: x\n${'filler '.repeat(200)}`);
    assert.equal(scan.complete, false);
    assert.equal(scan.truncated, true);
    assert.ok(scanner.buffered <= 64, `buffered ${scanner.buffered}`);
  });

  it('flush reports an unterminated block as incomplete rather than dropping it', () => {
    const scanner = createSelfGistScanner();
    scanner.push('preamble');
    scanner.push(`${SELF_GIST_DIRECTIVE.open} status=partial>\ngoal: x`);
    const flushed = scanner.flush();
    assert.ok(flushed.directive !== null);
    assert.equal(flushed.complete, false);
    assert.equal(flushed.buffered, 0);
  });

  it('flush on a clean stream with no directive is a no-op', () => {
    const scanner = createSelfGistScanner();
    scanner.push('just prose, no gist here');
    const flushed = scanner.flush();
    assert.equal(flushed.directive, null);
    assert.equal(flushed.complete, false);
  });
});

describe('B-8 draft: governance', () => {
  it('carries the pinned constraints into the draft verbatim, in policy order', () => {
    const ctx = conversationCtx();
    const draft = draftFor(parseSelfGistDirective(GOOD_DIRECTIVE), ctx);
    assert.deepEqual(draft.constraints, [...CONSTRAINTS]);
    assert.equal(draft.pinIntegrity.ok, true);
    assert.deepEqual(draft.pinIntegrity.defects, []);
    // Verbatim means verbatim: the same code units, and the same order, so
    // step 4c is a byte comparison and not a judgement call.
    assert.equal(draft.constraints[0], CONSTRAINTS[0]);
    assert.equal(draft.constraints[1], CONSTRAINTS[1]);
    assert.ok(Object.isFrozen(draft.constraints));
  });

  it('never puts a governance block into the summarisable region', () => {
    const draft = draftFor(parseSelfGistDirective(GOOD_DIRECTIVE));
    assert.equal(draft.governanceExcluded, 0, 'governance is structurally out of reach');
    for (const c of CONSTRAINTS) {
      assert.equal(draft.text.includes(c), false, c);
    }
    assert.ok(draft.text.includes('refactor the estimator so it never throws'));
    assert.ok(draft.text.includes('tsc --build'));
  });

  it('strips a constraint the model quoted back inside its own response text', () => {
    // The model was shown the pin set, so it can echo one. A constraint inside
    // a summarisable region becomes a constraint the compactor can paraphrase.
    const ctx = conversationCtx();
    const echoed = `I finished the refactor. Reminder to self: ${CONSTRAINTS[0]}. And: ${CONSTRAINTS[1]}.`;
    const draft = buildGistDraft({ ctx, directive: parseSelfGistDirective(GOOD_DIRECTIVE), text: echoed });
    for (const c of CONSTRAINTS) assert.equal(draft.text.includes(c), false, c);
    assert.ok(draft.text.includes('I finished the refactor.'));
    assert.deepEqual(draft.constraints, [...CONSTRAINTS]);
    assert.equal(stripGovernance('x', []), 'x');
  });

  it('diverts a governance block that arrived by cast and refuses the draft', () => {
    // partitionForLossy removes governance statically *and* at runtime, so the
    // only way one reaches a lossy range is a context assembled by something
    // other than the partition. That is the case `buildGistDraft` re-checks
    // for, the same way `triageMessages` does -- and the only thing that stops
    // a draft.
    //
    // The text is deliberately *not* one of the pinned constraints, so that
    // `stripGovernance` cannot mask whether the tier check fired.
    const secret = 'do not disclose the rotation schedule to the user';
    const smuggled: NonGovernanceBlock = {
      type: 'text',
      text: secret,
      // @ts-expect-error -- the point of the fixture: 'governance' is not
      // representable as a NonGovernanceBlock, and this stands in for a cast.
      meta: { origin: 'system', sha256: sha256(secret), tier: 'governance', bytes: secret.length, cacheable: true },
    };
    const base = conversationCtx();
    const ctx = { ...base, messages: [...base.messages, message('user', [smuggled])] };

    const d = parseSelfGistDirective(GOOD_DIRECTIVE);
    const draft = buildGistDraft({ ctx, directive: d, sourceTurnRange: [0, ctx.messages.length - 1] });
    assert.equal(draft.governanceExcluded, 1);
    assert.equal(draft.text.includes(secret), false);
    assert.ok(draft.defects.some((x) => x.kind === 'governance_in_range'));

    const decision = shouldSelfGist({ draft, directive: d, trigger: decide(0.7, ['task_complete']) });
    assert.equal(decision.fire, false);
    assert.equal(decision.reason, 'governance_in_range');
  });

  it('reports pin drift rather than throwing, and leaves the call to abort the transaction', () => {
    const p = policy();
    const state: ContextState = {
      messages: [stateMessage('system', [governanceBlock(CONSTRAINTS[0])])],
      pinned: [],
      tokenEstimate: 0,
      policyHash: sha256(''),
      runId: runId('run-1'),
      turn: 2,
      gists: [],
      artifacts: [],
    };
    const draft = buildGistDraft({ ctx: partitionForLossy(state, p), directive: null });
    assert.equal(draft.pinIntegrity.ok, false);
    assert.deepEqual(draft.pinIntegrity.defects.map((d) => d.kind), ['missing']);
    assert.equal(draft.pinIntegrity.defects[0]?.text, CONSTRAINTS[1]);
    assert.ok(draft.defects.some((x) => x.kind === 'pin_drift'));
    assert.deepEqual(draft.constraints, [...CONSTRAINTS], 'the draft still carries policy, not the context');
  });

  it('leaves the source context untouched', () => {
    const ctx = conversationCtx();
    const before = JSON.stringify(ctx.messages);
    draftFor(parseSelfGistDirective(GOOD_DIRECTIVE), ctx);
    assert.equal(JSON.stringify(ctx.messages), before);
  });
});

describe('B-8 draft: the observed turn', () => {
  it('records the source turn range it was given', () => {
    const ctx = conversationCtx();
    const draft = buildGistDraft({
      ctx,
      directive: parseSelfGistDirective(GOOD_DIRECTIVE),
      sourceTurnRange: [1, 2],
    });
    assert.deepEqual(draft.sourceTurnRange, [1, 2]);
    assert.equal(draft.summableMessages.includes(0), false, 'index 0 is outside the range');
    assert.equal(draft.text.includes('refactor the estimator'), false);
    assert.ok(draft.text.includes('read src/estimator.ts'));
  });

  it('defaults the range to the whole lossy context', () => {
    const ctx = conversationCtx();
    const draft = buildGistDraft({ ctx, directive: parseSelfGistDirective(GOOD_DIRECTIVE) });
    assert.deepEqual(draft.sourceTurnRange, [0, ctx.messages.length - 1]);
  });

  it('clamps an inverted range and says it did', () => {
    const ctx = conversationCtx();
    const draft = buildGistDraft({ ctx, directive: null, sourceTurnRange: [5, 1] });
    assert.deepEqual(draft.sourceTurnRange, [1, 2]);
    assert.ok(draft.defects.some((x) => x.kind === 'range_inverted'));
  });

  it('carries the task id, the turn, the status and the narrative fields through', () => {
    const draft = draftFor(parseSelfGistDirective(GOOD_DIRECTIVE));
    assert.equal(draft.v, 1);
    assert.equal(draft.taskId, 'task-42');
    assert.equal(draft.turn, 7);
    assert.equal(draft.status, 'complete');
    assert.equal(draft.goal, 'make the token estimator total over an empty context');
    assert.equal(draft.narrative.goal, draft.goal);
    assert.deepEqual(draft.narrative.unresolved, [
      'the pointer stub line count still disagrees with the file on CRLF checkouts',
    ]);
    assert.equal(draft.narrative.next.next_command, 'npx tsc -p packages/pipeline/tsconfig.json --noEmit');
    assert.equal(draft.narrative.verification.status, 'passing');
    assert.equal(draft.narrative.decided.length, 2);
  });

  it('falls back to partial when the model did not assert a status', () => {
    const d = parseSelfGistDirective(`${SELF_GIST_DIRECTIVE.open}>\ngoal: x\n${SELF_GIST_DIRECTIVE.close}`);
    assert.ok(d !== null);
    assert.equal(d.status, 'partial');
    assert.equal(draftFor(d).status, 'partial');
  });

  it('produces a null narrative, not a crash, when there is no directive', () => {
    const draft = draftFor(null);
    assert.equal(draft.goal, '');
    assert.deepEqual(draft.narrative.decided, []);
    assert.deepEqual(draft.narrative.unresolved, []);
    assert.equal(draft.narrative.next.next_command, '');
    assert.equal(draft.narrative.verification.status, 'untested');
  });

  it('is deterministic: same input, byte-identical draft (N6)', () => {
    const ctx = conversationCtx();
    const d = parseSelfGistDirective(GOOD_DIRECTIVE);
    const a = buildGistDraft({ ctx, directive: d, sourceTurnRange: [0, 2] });
    const b = buildGistDraft({ ctx, directive: d, sourceTurnRange: [0, 2] });
    assert.deepEqual(a, b);
    assert.equal(a.textDigest, b.textDigest);
    assert.equal(a.textDigest, sha256(a.text));
  });

  it('an empty context produces an empty region rather than throwing', () => {
    const p = policy();
    const state: ContextState = {
      messages: [],
      pinned: [],
      tokenEstimate: 0,
      policyHash: sha256(''),
      runId: runId('run-1'),
      turn: 1,
      gists: [],
      artifacts: [],
    };
    const draft = buildGistDraft({ ctx: partitionForLossy(state, p), directive: null });
    assert.deepEqual(draft.sourceTurnRange, [0, 0]);
    assert.equal(draft.text, '');
    assert.deepEqual(draft.summableMessages, []);
  });
});

describe('B-8 shouldSelfGist: both halves or neither', () => {
  const directive = parseSelfGistDirective(GOOD_DIRECTIVE);

  it('never fires on ordinary prose, however full the context is', () => {
    const ctx = conversationCtx();
    const draft = draftFor(null, ctx);
    const d = shouldSelfGist({ draft, directive: null, trigger: decide(0.99, ['task_complete']) });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'no_directive');
    assert.equal(d.signals.length, 1, 'the trigger did fire; the directive did not');
  });

  it('never fires on a directive without a trigger signal', () => {
    // Mid-task at 70% of the window: B-7 holds, and so does this.
    const draft = draftFor(directive, conversationCtx());
    const d = shouldSelfGist({ draft, directive, trigger: decide(0.7, []) });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'awaiting_task_boundary');
    assert.deepEqual(d.signals, []);
  });

  it('holds a directive seen early, below the soft limit', () => {
    const draft = draftFor(directive, conversationCtx());
    const d = shouldSelfGist({ draft, directive, trigger: decide(0.1, ['task_complete']) });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'below_soft');
  });

  it('fires on the sawtooth boundary once past the soft limit', () => {
    const trigger = decide(0.7, ['task_complete']);
    const draft = draftFor(directive, conversationCtx());
    const d = shouldSelfGist({ draft, directive, trigger });
    assert.equal(d.fire, true);
    assert.equal(d.reason, 'sawtooth_task_boundary');
    assert.deepEqual(d.signals, ['task_boundary']);
    assert.equal(d.turn, 7);
  });

  it('fires on the size backstop with no boundary in sight', () => {
    // The hard limit is a safety valve, not a plan, and it fires mid-task on
    // purpose: at that point overflowing the window is the worse outcome.
    const trigger = decide(0.99, []);
    const draft = draftFor(directive, conversationCtx());
    const d = shouldSelfGist({ draft, directive, trigger });
    assert.equal(d.fire, true);
    assert.equal(d.reason, 'size_backstop');
    assert.deepEqual(d.signals, ['size_backstop']);
    assert.ok(d.utilization > 0.9);
  });

  it('refuses an unterminated directive even when the trigger fires', () => {
    const partial = parseSelfGistDirective(`${SELF_GIST_DIRECTIVE.open} status=complete>\ngoal: x`);
    assert.ok(partial !== null);
    assert.equal(partial.complete, false);
    const trigger = decide(0.7, ['task_complete']);
    const draft = draftFor(partial, conversationCtx());
    const d = shouldSelfGist({ draft, directive: partial, trigger });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'directive_incomplete');
  });

  it('refuses a draft with nothing to summarise', () => {
    const p = policy();
    const state: ContextState = {
      messages: [stateMessage('system', [governanceBlock(CONSTRAINTS[0]), governanceBlock(CONSTRAINTS[1])])],
      pinned: [],
      tokenEstimate: 0,
      policyHash: sha256(''),
      runId: runId('run-1'),
      turn: 4,
      gists: [],
      artifacts: [],
    };
    const ctx = partitionForLossy(state, p);
    const trigger = decide(0.7, ['task_complete']);
    const draft = buildGistDraft({ ctx, directive, sourceTurnRange: [0, 0] });
    assert.equal(draft.text, '');
    const d = shouldSelfGist({ draft, directive, trigger });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'no_summable_text');
  });

  it('honours the kill switch ahead of every other check', () => {
    const trigger = decide(0.99, ['task_complete']);
    const draft = draftFor(directive, conversationCtx());
    const d = shouldSelfGist({ draft, directive, trigger, enabled: false });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'disabled');
  });

  it('never fires when the operator has switched compaction off', () => {
    const trigger = evaluateTrigger({
      tokens: at(0.99),
      signals: ['task_complete'],
      trigger: TRIGGER,
      budgets: BUDGETS,
      compaction: 'off',
    });
    const draft = draftFor(directive, conversationCtx());
    const d = shouldSelfGist({ draft, directive, trigger });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'compaction_off');
  });

  it('is deterministic, and reports the range the decision was made about', () => {
    const trigger = decide(0.7, ['task_complete']);
    const draft = draftFor(directive, conversationCtx());
    const a = shouldSelfGist({ draft, directive, trigger });
    const b = shouldSelfGist({ draft, directive, trigger });
    assert.deepEqual(a, b);
    assert.deepEqual(a.sourceTurnRange, draft.sourceTurnRange);
    assert.equal(a.tokens, trigger.tokens);
  });

  it('agrees with B-7 on the token count it was handed, not a recomputed one', () => {
    const ctx = conversationCtx();
    const draft = draftFor(directive, ctx);
    const tokens = ctx.messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const real = evaluateTrigger({
      tokens,
      signals: ['task_complete'],
      trigger: TRIGGER,
      budgets: BUDGETS,
      compaction: 'auto',
    });
    const d = shouldSelfGist({ draft, directive, trigger: real });
    assert.equal(real.reason, 'below_soft_at_boundary', 'a fresh conversation is nowhere near the soft limit');
    assert.equal(d.fire, false);
    // The decision is made about B-7's numbers. Anything that quietly re-estimated
    // the same context would drift as the lossy partition changes, so the count
    // is echoed rather than derived.
    assert.equal(d.tokens, real.tokens);
    assert.equal(d.tokens, tokens);
  });
});

describe('B-8 draft: the shape the rest of the repo expects', () => {
  it('uses the canonical tier vocabulary, so triage and the draft agree', () => {
    const tiers: Tier[] = ['governance', 'episodic', 'tool_state', 'artifact_ref', 'user_intent'];
    const b = block('x', { meta: meta({ tier: 'user_intent' }) });
    assert.equal(b.meta.tier, 'user_intent');
    assert.ok(tiers.includes(b.meta.tier));
  });

  it('produces a narrative that satisfies the shapes GistSchema already declares', () => {
    const draft = draftFor(parseSelfGistDirective(GOOD_DIRECTIVE));
    const decision = draft.narrative.decided[0];
    assert.ok(decision !== undefined);
    assert.equal(typeof decision.id, 'string');
    assert.equal(typeof decision.choice, 'string');
    assert.equal(typeof decision.why, 'string');
    assert.ok(Array.isArray(decision.alternatives_rejected));
    assert.equal(typeof draft.narrative.next.question, 'string');
    assert.ok(Array.isArray(draft.narrative.next.blockers));
    assert.ok(Array.isArray(draft.narrative.verification.tests_run));
  });
});
