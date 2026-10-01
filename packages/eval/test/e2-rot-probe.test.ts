import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { unitValue } from '../src/index.js';

import {
  E2_ARMS,
  E2_BASELINE_ARM,
  E2_CASES_PER_TIER_TARGET,
  E2_CHANCE_ACCURACY,
  E2_CHARS_PER_TOKEN,
  E2_DEGRADATION_AXIS,
  E2_FAMILIES,
  E2_NEEDLE_DEPTH,
  E2_NEEDLE_SPAN_LINES,
  E2_NIAH_MAGIC_IDS,
  E2_OPTION_COUNT,
  E2_PROBES,
  E2_ROT_FAMILIES,
  E2_SLOPE_THRESHOLD,
  E2_TIER_FILL_TOLERANCE,
  E2_TIER_IDS,
  E2_TIERS,
  E2_TRUNCATED_ARM,
  E2_TRUNCATION_BUDGET_TOKENS,
  E2_WINDOW_TOKENS,
  E2FixtureError,
  assertE2Presented,
  auditE2Calls,
  bootstrapE2SlopeDifference,
  buildE2Document,
  buildE2Fixture,
  checkE2Rules,
  countE2Records,
  countOccurrences,
  createE2ArmRunner,
  deriveE2Answer,
  e2NeedleAnchorLine,
  evaluateE2Gate,
  evaluateE2ProbeValidity,
  extractE2EmittedAnswer,
  lintE2Probes,
  renderE2Context,
  renderE2QuestionBlock,
  runE2Suite,
  sharedWordSpan,
  summariseE2Curves,
} from '../src/suites/e2-rot-probe.js';
import type { Arm } from '../src/types.js';
import type {
  E2Cell,
  E2Family,
  E2PresentedContext,
  E2Probe,
  E2Subject,
  E2SubjectView,
  E2TierId,
} from '../src/suites/e2-rot-probe.js';

const tokensOf = (text: string): number => Math.ceil(text.length / E2_CHARS_PER_TOKEN);
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const probeById = (probes: readonly E2Probe[]): ReadonlyMap<string, E2Probe> =>
  new Map(probes.map((probe) => [probe.id, probe]));

/**
 * The line at which a probe becomes answerable.
 *
 * Found by bisection on the line count at which `deriveE2Answer` starts returning
 * the authored answer, measured against the tier's needle anchor. Lines rather
 * than characters because lines are what the geometry controls: a needle that
 * drifts with the tier moves this number and nothing else has to change for the
 * test to notice.
 */
const answerLine = (probe: E2Probe): number => {
  const lines = renderE2Context(probe.tier).split('\n');
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (deriveE2Answer(probe, lines.slice(0, mid).join('\n')) === probe.correctAnswer) high = mid;
    else low = mid + 1;
  }
  return low;
};

/**
 * The offline degradation model, and the only subject in this file.
 *
 * **It lives in the test, not in `src/`.** `runE2Suite` requires an injected
 * subject with no default, for the same reason E1's `runE1Suite` requires a
 * compaction strategy: a suite that ships its own subject can produce a green
 * report nobody earned. A *declared* model in `src/` would eventually be quoted
 * as a measurement of something, and nothing in the file would say otherwise.
 *
 * The model is deliberately simple and every constant is stated:
 *
 * - **noise** — the probe's declared `key=value` cue is counted in the context
 *   the arm actually received, and each occurrence costs a fixed slice of
 *   accuracy. Counting occurrences rather than density is the point: a longer
 *   context holds *more competing records*, and normalising by length would make
 *   four tiers of the same noise, which is a flat curve by construction.
 * - **evidence** — the model resolves the answer from the presented context with
 *   the same oracle the audit uses, and when the evidence is gone it answers at
 *   chance. A real model gets no oracle; F2 replaces this subject. What is being
 *   tested here is that the *apparatus* reports the difference between a subject
 *   that degrades and one that does not, not that a plausible model exists.
 * - **treatment** — `recovery` closes a share of the remaining error. It is a
 *   partial recovery, not a cure, so the treatment curve is a shallower curve
 *   rather than a flat one; a flat treatment would make the slope comparison
 *   vacuous.
 * - **the drop is floored at chance** — accuracy never falls below the guess
 *   rate, because a model that has lost the evidence is guessing, not doing
 *   worse than guessing. Without the floor, a long context would drive accuracy
 *   toward zero and the curve would be measuring the floor, not the rot.
 * - **the draw** — one seeded unit value per (case, arm) decides whether a
 *   correct read is emitted. Deterministic, so the numbers asserted below are
 *   facts about the declared model rather than one lucky seed. With three rot
 *   cases per tier a single draw moves a tier by a third, which is why the
 *   statistics and gate tests fit constructed curves instead of these.
 */
interface E2ModelOptions {
  readonly id?: string;
  readonly dropPerDistractor?: number;
  readonly treatmentRecovery?: number;
  /** Make `present` return a summary instead of a subset. */
  readonly lossy?: boolean;
  /** Invert the model's evidence claim, to prove the audit catches it. */
  readonly lieAboutEvidence?: boolean;
  /** Skip truncation entirely, so the truncated arm keeps the whole context. */
  readonly neverTruncate?: boolean;
  /** Add a line the input never carried, to prove the verbatim check fires. */
  readonly injectLine?: string;
  readonly pointerTo?: string;
}

/**
 * Accuracy lost per competing record, and the share of it the treatment closes.
 *
 * 0.012 puts the declared control near 25% at the top two tiers, which is what
 * makes the NIAH control informative: the rot families fail while the magic-key
 * family does not, so the probe-validity check has something to separate.
 */
const DEFAULT_DROP_PER_DISTRACTOR = 0.012;
const DEFAULT_RECOVERY = 0.8;
const MODEL_SEED = 0x5eed_02;

const makeModel = (probes: readonly E2Probe[], options: E2ModelOptions = {}): E2Subject => {
  const byId = probeById(probes);
  const dropPer = options.dropPerDistractor ?? DEFAULT_DROP_PER_DISTRACTOR;
  const recovery = options.treatmentRecovery ?? DEFAULT_RECOVERY;
  return {
    id: options.id ?? 'offline-degradation-model',
    // The stage keeps a *prefix* of the input: head truncation is what deletes a
    // needle at 60% depth, and pointerisation is the addition E4 will need.
    //
    // The cut is at a line boundary, and that is not cosmetic. Cutting mid-record
    // would leave a half line the input never carried, and the suite refuses a
    // lossless claim it cannot verify line by line — correctly. A truncating stage
    // that emits a mangled record is a bug the harness is supposed to catch, so
    // the model drops the partial tail the way a record-aware pipeline would.
    present(view: E2SubjectView): E2PresentedContext {
      const truncate = view.arm === E2_TRUNCATED_ARM && options.neverTruncate !== true;
      const budgetChars = E2_TRUNCATION_BUDGET_TOKENS * E2_CHARS_PER_TOKEN;
      const cut = truncate ? view.context.slice(0, budgetChars).lastIndexOf('\n') : view.context.length;
      const kept = truncate ? view.context.slice(0, cut + 1) : view.context;
      const extra: string[] = [];
      if (options.injectLine !== undefined) extra.push(options.injectLine);
      if (options.pointerTo !== undefined) extra.push(`PTR-${options.pointerTo}`);
      return {
        stage: truncate ? 'head-truncate' : extra.length === 0 ? 'verbatim' : 'verbatim+pointer',
        context: options.lossy === true ? `# summary: ${view.tier} extract summarised\n` : `${kept}${extra.join('\n')}${extra.length === 0 ? '' : '\n'}`,
        // Claimed, not checked here. The suite checks it against the bytes, which
        // is the point: a stage that deletes records while claiming to be
        // lossless would otherwise have its deletions scored as rot.
        lossy: options.lossy === true,
      };
    },
    answer(view: E2SubjectView, presented: E2PresentedContext) {
      const probe = byId.get(view.caseId);
      if (probe === undefined) throw new Error(`e2 test model: no probe for ${view.caseId}`);
      const resolved = deriveE2Answer(probe, presented.context);
      const hasEvidence = resolved === probe.correctAnswer;
      const drop = Math.min(1 - E2_CHANCE_ACCURACY, dropPer * countOccurrences(presented.context, probe.noiseCue));
      const effective = view.arm === 'treatment' ? drop * (1 - recovery) : drop;
      const probability = hasEvidence ? clamp01(1 - effective) : E2_CHANCE_ACCURACY;
      const draw = unitValue(MODEL_SEED, `e2-model|${view.caseId}|${view.arm}`);
      const correct = draw < probability;
      const wrong = probe.options.filter((option) => option !== probe.correctAnswer);
      const guess = wrong[Math.floor(draw * wrong.length) % wrong.length] ?? probe.correctAnswer;
      return {
        answer: correct ? probe.correctAnswer : guess,
        evidenceRetained: options.lieAboutEvidence === true ? !hasEvidence : hasEvidence,
        freeText: undefined,
      };
    },
  };
};

// A run of the default model, shared by the tests that assert on its numbers.
let cachedDefault: Awaited<ReturnType<typeof runE2Suite>> | undefined;
const defaultRun = async (): Promise<Awaited<ReturnType<typeof runE2Suite>>> => {
  cachedDefault ??= await runE2Suite({ subject: makeModel(E2_PROBES) });
  return cachedDefault;
};

describe('e2 corpus: four tiers at 5/20/50/80% of the window', () => {
  it('renders every tier inside the declared fill tolerance', () => {
    for (const tier of E2_TIER_IDS) {
      const text = renderE2Context(tier);
      const fill = tokensOf(text) / E2_WINDOW_TOKENS;
      assert.ok(
        Math.abs(fill - E2_TIERS[tier].fill) <= E2_TIER_FILL_TOLERANCE,
        `tier ${tier} rendered ${fill.toFixed(4)} of the window, outside the ${E2_TIER_FILL_TOLERANCE} tolerance`,
      );
    }
  });

  it('puts more records in the context as the tier grows, and never fewer', () => {
    let previous = 0;
    for (const tier of E2_TIER_IDS) {
      const lines = renderE2Context(tier).split('\n').length;
      assert.ok(lines > previous, `tier ${tier} has ${lines} lines, not more than the previous tier's ${previous}`);
      previous = lines;
    }
  });

  it('re-derives every probe answer from the tier context it ships with', () => {
    for (const probe of E2_PROBES) {
      const derived = deriveE2Answer(probe, renderE2Context(probe.tier));
      assert.equal(derived, probe.correctAnswer, `${probe.id} re-derives to ${String(derived)}`);
    }
  });

  it('places every family in the pinned needle region, so the sweep varies noise and nothing else', () => {
    for (const tier of E2_TIER_IDS) {
      const anchor = e2NeedleAnchorLine(tier);
      for (const family of E2_ROT_FAMILIES) {
        const probe = E2_PROBES.find((candidate) => candidate.tier === tier && candidate.family === family);
        assert.ok(probe !== undefined);
        const at = answerLine(probe);
        assert.ok(
          Math.abs(at - anchor) <= E2_NEEDLE_SPAN_LINES,
          `${probe.id} becomes answerable at line ${at}, which is ${at - anchor} lines from the anchor at ` +
            `tier ${tier}, outside the ${E2_NEEDLE_SPAN_LINES}-line region`,
        );
      }
    }
  });

  it('keeps the answerability offsets identical across tiers, so a tier cannot move the answer', () => {
    const offsets = new Map<string, Set<number>>();
    for (const probe of E2_PROBES) {
      const relative = answerLine(probe) - e2NeedleAnchorLine(probe.tier);
      const key = `${probe.family}`;
      const bucket = offsets.get(key) ?? new Set<number>();
      bucket.add(relative);
      offsets.set(key, bucket);
    }
    for (const [family, seen] of offsets) {
      assert.equal(seen.size, 1, `${family} sits at ${[...seen].join(' and ')} lines from the anchor across tiers`);
    }
  });

  it('shares one haystack per tier across all four families', () => {
    const prompts = new Map<E2TierId, Set<string>>();
    for (const probe of E2_PROBES) {
      const prompt = `${renderE2Context(probe.tier)}${renderE2QuestionBlock(probe)}`;
      const bucket = prompts.get(probe.tier) ?? new Set<string>();
      bucket.add(prompt.slice(0, prompt.length - renderE2QuestionBlock(probe).length));
      prompts.set(probe.tier, bucket);
    }
    for (const [tier, contexts] of prompts) {
      assert.equal(contexts.size, 1, `tier ${tier} rendered ${contexts.size} different haystacks`);
    }
  });

  it('keeps the NIAH key unique inside its own context and the decoy stamps elsewhere', () => {
    for (const tier of E2_TIER_IDS) {
      const context = renderE2Context(tier);
      assert.equal(countOccurrences(context, `magic_for=${E2_NIAH_MAGIC_IDS[tier]}`), 1);
      const niah = E2_PROBES.find((probe) => probe.family === 'niah' && probe.tier === tier);
      assert.ok(niah !== undefined);
      assert.equal(countE2Records(context, niah.derivation.kind === 'aggregate' ? {} : niah.derivation.keys), 1);
    }
  });

  it('keeps each rot family on its own noise cue, and grows that cue with the tier', () => {
    const byTier = new Map<E2TierId, Map<string, number>>();
    for (const tier of E2_TIER_IDS) {
      const context = renderE2Context(tier);
      const row = new Map<string, number>();
      for (const family of E2_ROT_FAMILIES) {
        const probe = E2_PROBES.find((candidate) => candidate.family === family && candidate.tier === tier);
        assert.ok(probe !== undefined);
        row.set(family, countOccurrences(context, probe.noiseCue));
      }
      byTier.set(tier, row);
    }
    for (const family of E2_ROT_FAMILIES) {
      const counts = E2_TIER_IDS.map((tier) => byTier.get(tier)?.get(family) ?? 0);
      for (let i = 1; i < counts.length; i += 1) {
        assert.ok(
          (counts[i] ?? 0) > (counts[i - 1] ?? 0),
          `${family} noise is flat from tier ${E2_TIER_IDS[i - 1]} to ${E2_TIER_IDS[i]}: ${JSON.stringify(counts)}`,
        );
      }
    }
    // Equal to within one cycle of the 64-value pool, which is all this generator
    // can promise: a context that stops mid-cycle sees some pool values and not
    // others. A hand-tuned asymmetry — one family handed twice the noise — is many
    // cycles wide and cannot pass this.
    for (const [tier, row] of byTier) {
      const counts = [...row.values()];
      const spread = Math.max(...counts) - Math.min(...counts);
      assert.ok(spread <= 4, `tier ${tier} cue counts differ by ${spread}, more than one pool cycle: ${JSON.stringify(row)}`);
    }
    const top = byTier.get('t80');
    assert.ok(top !== undefined);
    for (const [family, count] of top) assert.ok(count > 50, `${family} cue count ${count} is too small to be noise`);
  });
});

describe('e2 lint: a synthetic task means a task with a known answer', () => {
  it('accepts the shipped probes', () => {
    assert.deepEqual(lintE2Probes(E2_PROBES), []);
  });

  it('refuses a distractor that occurs nowhere in the context', () => {
    const probe = E2_PROBES[0];
    assert.ok(probe !== undefined);
    const broken = {
      ...probe,
      options: ['3.50', '9.99', '3.25', '5.75'],
      distractors: [
        { value: '9.99', kind: 'near_miss_literal' as const },
        { value: '3.25', kind: 'near_miss_literal' as const },
        { value: '5.75', kind: 'near_miss_literal' as const },
      ],
    };
    const issues = lintE2Probes([broken]);
    assert.ok(issues.some((issue) => issue.code === 'unverifiable_distractor' && issue.message.includes('9.99')));
  });

  it('refuses a wrong_count the context does not reproduce', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'aggregate');
    assert.ok(probe !== undefined);
    const broken = {
      ...probe,
      options: ['15', '14', '16', '41'],
      distractors: [
        { value: '14', kind: 'off_by_one' as const },
        { value: '16', kind: 'off_by_one' as const },
        { value: '41', kind: 'wrong_count' as const, countKeys: { section: 's2', status: 'blocked' } },
      ],
    };
    const issues = lintE2Probes([broken]);
    assert.ok(issues.some((issue) => issue.code === 'unverifiable_distractor' && issue.message.includes('41')));
  });

  it('refuses an off_by_one that is not off by one', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'aggregate');
    assert.ok(probe !== undefined);
    const broken = {
      ...probe,
      options: ['15', '14', '22', '12'],
      distractors: [
        { value: '14', kind: 'off_by_one' as const },
        { value: '22', kind: 'off_by_one' as const },
        { value: '12', kind: 'wrong_count' as const, countKeys: { section: 's2', status: 'blocked' } },
      ],
    };
    const issues = lintE2Probes([broken]);
    assert.ok(issues.some((issue) => issue.code === 'unverifiable_distractor' && issue.message.includes('22')));
  });

  it('refuses an answer the corpus does not support', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'lookup');
    assert.ok(probe !== undefined);
    const broken = { ...probe, correctAnswer: '4.00' };
    const issues = lintE2Probes([broken]);
    assert.ok(issues.some((issue) => issue.code === 'answer_not_derivable'));
  });

  it('refuses a derivation that matches more than one record', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'lookup');
    assert.ok(probe !== undefined);
    // A filler triple, which recurs across the corpus: the question would have
    // as many readings as the haystack has copies of that row.
    const broken = {
      ...probe,
      derivation: { kind: 'field' as const, keys: { check: 'retry-budget', service: 'checkout-api' }, field: 'limit' },
    };
    const issues = lintE2Probes([broken]);
    assert.ok(issues.some((issue) => issue.code === 'ambiguous_derivation'));
    assert.ok(countE2Records(renderE2Context(probe.tier), { check: 'retry-budget', service: 'checkout-api' }) > 1);
  });

  it('refuses an option that copies four words out of the question', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'multihop');
    assert.ok(probe !== undefined);
    const broken = {
      ...probe,
      options: ['team-halyard@pdf-render', 'its escalation field points at another', 'x', 'y'],
      distractors: [
        { value: 'its escalation field points at another', kind: 'near_miss_literal' as const },
        { value: 'x', kind: 'off_by_one' as const },
        { value: 'y', kind: 'off_by_one' as const },
      ],
    };
    const issues = lintE2Probes([broken]);
    assert.ok(issues.some((issue) => issue.code === 'question_overlaps_option'));
  });

  it('measures a shared span, not a shared vocabulary', () => {
    const shared = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    // A contiguous run is findable by a keyword scorer; the same five words in the
    // opposite order are not, because no window contains two of them in a row.
    assert.equal(sharedWordSpan(['the', 'limit', 'is', '3.50'], ['x', 'the', 'limit', 'is', '3.50', 'y']), 4);
    assert.equal(sharedWordSpan(shared, [...shared].reverse()), 1);
    assert.equal(sharedWordSpan(shared, ['one', 'two', 'three']), 0);
    assert.equal(sharedWordSpan([], shared), 0);
  });

  it('refuses a question that prints its own answer', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'niah');
    assert.ok(probe !== undefined);
    const broken = { ...probe, question: `Report the stamp 48213 on the line magic_for=${E2_NIAH_MAGIC_IDS[probe.tier]}.` };
    const issues = lintE2Probes([broken]);
    assert.ok(issues.some((issue) => issue.code === 'question_contains_answer'));
  });

  it('refuses a multi-line option, which could not survive the transcript', () => {
    const probe = E2_PROBES[0];
    assert.ok(probe !== undefined);
    const issues = lintE2Probes([{ ...probe, options: ['3.50\nanswer=4.00', '4.00', '3.25', '5.75'] }]);
    assert.ok(issues.some((issue) => issue.code === 'option_multiline'));
  });

  it('refuses a probe whose noise cue is not in the corpus', () => {
    const probe = E2_PROBES[0];
    assert.ok(probe !== undefined);
    const issues = lintE2Probes([{ ...probe, noiseCue: 'src=src-99' }]);
    assert.ok(issues.some((issue) => issue.code === 'noise_cue_absent'));
  });

  it('refuses a wrong option with no distractor rule behind it', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'lookup');
    assert.ok(probe !== undefined);
    const issues = lintE2Probes([{ ...probe, distractors: probe.distractors.slice(0, 2) }]);
    assert.ok(issues.some((issue) => issue.code === 'unverifiable_distractor' && issue.message.includes('carries no')));
  });

  it('refuses a fixture that is missing a family or an arm', () => {
    const fixture = buildE2Fixture();
    const trimmed = { ...fixture, cases: fixture.cases.filter((evalCase) => !evalCase.id.endsWith('niah')) };
    assert.ok(checkE2Rules(trimmed).some((issue) => issue.code === 'missing_family'));
    const oneArmed = {
      ...fixture,
      cases: fixture.cases.map((evalCase) => ({ ...evalCase, arms: evalCase.arms.filter((arm) => arm !== 'treatment') })),
    };
    assert.ok(checkE2Rules(oneArmed).some((issue) => issue.code === 'missing_arm'));
  });

  it('throws rather than building a fixture it cannot measure', () => {
    const probe = E2_PROBES[0];
    assert.ok(probe !== undefined);
    assert.throws(
      () => buildE2Fixture([{ ...probe, correctAnswer: '9.99' }]),
      (error: unknown) => error instanceof E2FixtureError,
    );
  });
});

describe('e2 fixture: the answer key is the constraint', () => {
  it('builds 16 cases, four families at four tiers, each on all three arms', () => {
    const fixture = buildE2Fixture();
    assert.equal(fixture.cases.length, E2_FAMILIES.length * E2_TIER_IDS.length);
    for (const tier of E2_TIER_IDS) {
      for (const family of E2_FAMILIES) {
        const found = fixture.cases.find((evalCase) => evalCase.id === `e2-${tier}-${family}`);
        assert.ok(found !== undefined, `missing ${tier}/${family}`);
        assert.deepEqual([...found.arms].sort(), [...E2_ARMS].sort());
      }
    }
  });

  it('marks only the rot families as negative controls', () => {
    const fixture = buildE2Fixture();
    for (const evalCase of fixture.cases) {
      const isNiah = evalCase.id.endsWith('-niah');
      assert.equal(evalCase.negativeControl, !isNiah, `${evalCase.id} negativeControl`);
    }
    // The harness's own negative-control section has to be able to fire, or G5
    // is being read off an instrument that never demonstrated the failure.
    const controls = fixture.cases.filter((evalCase) => evalCase.negativeControl);
    assert.equal(controls.length, E2_ROT_FAMILIES.length * E2_TIER_IDS.length);
  });

  it('carries the answer key as one constraint whose forbidden markers are the wrong options', () => {
    const fixture = buildE2Fixture();
    for (const probe of E2_PROBES) {
      const evalCase = fixture.cases.find((candidate) => candidate.id === probe.id);
      assert.ok(evalCase !== undefined);
      assert.equal(evalCase.constraints.length, 1);
      const constraint = evalCase.constraints[0];
      assert.ok(constraint !== undefined);
      assert.equal(constraint.forbidden.length, E2_OPTION_COUNT - 1);
      assert.deepEqual([...constraint.forbidden].sort(), probe.options.filter((o) => o !== probe.correctAnswer).sort());
      assert.ok(!constraint.forbidden.includes(probe.correctAnswer), `${probe.id} forbids its own answer`);
    }
  });

  it('puts the whole context and the question in the prompt, so a case is self-contained', () => {
    const fixture = buildE2Fixture();
    for (const probe of E2_PROBES) {
      const evalCase = fixture.cases.find((candidate) => candidate.id === probe.id);
      assert.ok(evalCase !== undefined);
      const expected = `${renderE2Context(probe.tier)}${renderE2QuestionBlock(probe)}`;
      assert.equal(evalCase.prompt, expected);
      assert.ok(evalCase.prompt.includes(probe.question));
      for (const option of probe.options) assert.ok(evalCase.prompt.includes(option));
    }
  });

  it('exposes a document that the base validator accepts', () => {
    assert.deepEqual(checkE2Rules(buildE2Fixture()), []);
    const document = buildE2Document();
    assert.equal(document.suite, 'E2');
    assert.equal(Array.isArray(document.cases), true);
  });
});

describe('e2 subject: injected, audited, and never believed', () => {
  it('refuses to run without a subject, and without a name for it', async () => {
    await assert.rejects(() => runE2Suite({ subject: undefined as never }), TypeError);
    await assert.rejects(() => runE2Suite({ subject: { id: '', present: () => ({ stage: '', context: '', lossy: true }), answer: () => ({ answer: '', evidenceRetained: false, freeText: undefined }) } }), TypeError);
  });

  it('refuses a stage that claims a lossless context and invents a line', () => {
    const probe = E2_PROBES[0];
    assert.ok(probe !== undefined);
    const view = viewFor(probe);
    assert.throws(
      () => assertE2Presented({ stage: 'invent', context: `${view.context}\nLG-99999 section=s3 status=blocked`, lossy: false }, view),
      /claimed a lossless context/,
    );
  });

  it('refuses a pointer to a record that does not exist, and accepts one that does', () => {
    const probe = E2_PROBES.find((candidate) => candidate.family === 'lookup');
    assert.ok(probe !== undefined);
    const view = viewFor(probe);
    assert.throws(
      () => assertE2Presented({ stage: 'pointer', context: `PTR-RB-99999\n`, lossy: false }, view),
      /names a record that is not in the input/,
    );
    assert.doesNotThrow(() => assertE2Presented({ stage: 'pointer', context: 'PTR-RB-90001\n', lossy: false }, view));
  });

  it('accepts a lossy context, and excludes it from the curve rather than scoring it', async () => {
    const result = await runE2Suite({ subject: makeModel(E2_PROBES, { lossy: true }) });
    assert.equal(result.audit.lossyCalls.length, E2_PROBES.length * E2_ARMS.length);
    const control = result.curves.find((curve) => curve.arm === E2_BASELINE_ARM);
    assert.ok(control !== undefined);
    assert.ok(control.rotByTier.every((tier) => tier.cases === 0 && tier.accuracy === null));
    assert.ok(control.rotByTier.every((tier) => tier.excluded === E2_ROT_FAMILIES.length));
    assert.ok(control.excludedCells > 0);
    assert.equal(result.probe.status, 'undetermined');
    assert.equal(result.gate.status, 'inconclusive');
  });

  it('catches a subject whose evidence claim contradicts the context it returned', async () => {
    const result = await runE2Suite({ subject: makeModel(E2_PROBES, { lieAboutEvidence: true }) });
    const evidence = result.audit.disagreements.filter((disagreement) => disagreement.field === 'evidence');
    // Only the arms that actually had the evidence can be caught lying about
    // losing it, and the truncated arm genuinely lost it.
    assert.ok(evidence.length > 0);
    assert.ok(evidence.every((disagreement) => disagreement.detail.includes('claimed evidence')));
  });

  it('catches a transcript with no answer in it, which the audit must refuse to grade', () => {
    const audit = auditE2Calls([
      {
        caseId: 'e2-t80-lookup',
        arm: 'control',
        position: 0,
        stage: 'verbatim',
        claimedLossy: false,
        presentedTokens: 160542,
        evidencePresent: true,
        evidenceClaim: true,
        emitted: null,
        answerRecognised: false,
        correct: false,
      },
    ]);
    assert.equal(audit.disagreements.length, 1);
    assert.equal(audit.disagreements[0]?.field, 'answer');
  });

  it('counts tokens itself, so a subject cannot report a flattering context size', async () => {
    const result = await defaultRun();
    const control = result.curves.find((curve) => curve.arm === E2_BASELINE_ARM);
    const truncated = result.curves.find((curve) => curve.arm === E2_TRUNCATED_ARM);
    assert.ok(control !== undefined && truncated !== undefined);
    const controlCase = result.report.cases.find((evalCase) => evalCase.caseId === 'e2-t80-lookup');
    assert.ok(controlCase !== undefined);
    const byArm = new Map(controlCase.arms.map((arm) => [arm.arm, arm]));
    assert.equal(byArm.get('control')?.inputTokens, tokensOf(renderE2Context('t80')));
    // The truncated arm is measured, not assumed: it keeps whole lines up to its
    // budget, so it lands just under 50 000 tokens rather than exactly on it.
    const truncatedTokens = byArm.get(E2_TRUNCATED_ARM)?.inputTokens ?? 0;
    assert.ok(truncatedTokens > 0, 'the truncated arm presented an empty context');
    assert.ok(
      truncatedTokens <= E2_TRUNCATION_BUDGET_TOKENS && truncatedTokens >= E2_TRUNCATION_BUDGET_TOKENS - 64,
      `the truncated arm presented ${truncatedTokens} tokens, not within a line of its ${E2_TRUNCATION_BUDGET_TOKENS} budget`,
    );
    // The curves record that the two arms saw different amounts of context rather
    // than treating both as "the t80 context".
    assert.equal(control.rotByTier.length, E2_TIER_IDS.length);
    assert.ok(control.rotByTier.some((tier) => tier.cases > 0));
    assert.equal(truncated.excludedCells, 0);
  });

  it('refuses to run a case whose prompt was not built from the same probes', () => {
    const fixture = buildE2Fixture();
    const tampered = {
      ...fixture,
      cases: fixture.cases.map((evalCase) =>
        evalCase.id === 'e2-t05-niah' ? { ...evalCase, prompt: `${evalCase.prompt}\nan extra line\n` } : evalCase,
      ),
    };
    const handle = createE2ArmRunner(E2_PROBES, makeModel(E2_PROBES));
    assert.throws(
      () =>
        handle.run({
          harnessSeed: 1,
          suite: 'E2',
          case: tampered.cases.find((evalCase) => evalCase.id === 'e2-t05-niah')!,
          arm: 'control',
          position: 0,
          attempt: 1,
        }),
      /built from a different corpus/,
    );
  });

  it('is byte-identical on replay', async () => {
    const first = await runE2Suite({ subject: makeModel(E2_PROBES) });
    const second = await runE2Suite({ subject: makeModel(E2_PROBES) });
    assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
    assert.equal(JSON.stringify(first.curves), JSON.stringify(second.curves));
    assert.equal(first.gate.status, second.gate.status);
  });

  it('reads the answer back out of the transcript, not off the return value', () => {
    assert.equal(extractE2EmittedAnswer('[arm=control]\nanswer=3.50'), '3.50');
    assert.equal(extractE2EmittedAnswer('answer= 3.50  \nfree text'), '3.50');
    assert.equal(extractE2EmittedAnswer('[arm=control]\nI could not find it'), null);
    // First match wins, so a model that mentions the format before answering
    // cannot have its answer overwritten.
    assert.equal(extractE2EmittedAnswer('answer=none of these\nanswer=3.50'), 'none of these');
  });
});

/** A view for the assertion tests, built the same way the runner builds one. */
const viewFor = (probe: E2Probe): E2SubjectView => {
  const context = renderE2Context(probe.tier);
  return {
    caseId: probe.id,
    arm: 'control',
    tier: probe.tier,
    family: probe.family,
    prompt: `${context}${renderE2QuestionBlock(probe)}`,
    context,
    contextTokens: tokensOf(context),
    question: probe.question,
    options: probe.options,
  };
};

/**
 * Cells for the statistics and the gate, built rather than run.
 *
 * The offline subject draws once per case per arm, so with three rot cases per
 * tier a single draw moves a tier by a third and which way it moves is decided by
 * a hash. Testing the *statistics* against that would be testing the hash. These
 * helpers lay down exact pass/fail counts per tier per arm, so a slope, an
 * interval, a status and a gate verdict can each be asserted on the curve they
 * were supposed to read.
 */
const cellsFor = (spec: {
  readonly control: readonly number[];
  readonly treatment: readonly number[];
  readonly truncated?: readonly number[];
  readonly niah?: readonly number[];
  readonly casesPerTier?: number;
  readonly excludedTiers?: readonly E2TierId[];
}): readonly E2Cell[] => {
  const per = spec.casesPerTier ?? 8;
  const cells: E2Cell[] = [];
  const push = (
    arm: Arm,
    family: E2Family,
    tier: E2TierId,
    correct: number,
    cases: number,
    excluded: boolean,
  ): void => {
    for (let i = 0; i < cases; i += 1) {
      cells.push({
        caseId: `e2-${tier}-${family}-${i}`,
        tier,
        family,
        arm,
        passed: i < correct,
        excluded,
      });
    }
  };
  E2_TIER_IDS.forEach((tier, index) => {
    const excluded = (spec.excludedTiers ?? []).includes(tier);
    push(E2_BASELINE_ARM, 'lookup', tier, spec.control[index] ?? 0, per, excluded);
    push('treatment', 'lookup', tier, spec.treatment[index] ?? 0, per, excluded);
    if (spec.truncated !== undefined) {
      push(E2_TRUNCATED_ARM, 'lookup', tier, spec.truncated[index] ?? 0, per, excluded);
    }
    // The NIAH control is flat unless a test says otherwise: 1 case per tier,
    // always right, which is what "NIAH does not degrade" looks like.
    push(E2_BASELINE_ARM, 'niah', tier, spec.niah === undefined ? 1 : (spec.niah[index] ?? 0), 1, false);
  });
  return Object.freeze(cells);
};

const gateFor = (
  cells: readonly E2Cell[],
  casesPerTier: number = E2_CASES_PER_TIER_TARGET,
): ReturnType<typeof evaluateE2Gate> => {
  const curves = summariseE2Curves(cells);
  const probe = evaluateE2ProbeValidity(cells);
  const interval = bootstrapE2SlopeDifference(cells, { resamples: 200 });
  return evaluateE2Gate(curves, probe, interval, casesPerTier);
};

const tierAccuracyAtTest = (tiers: readonly { tier: E2TierId; accuracy: number | null }[], tier: E2TierId): number =>
  tiers.find((candidate) => candidate.tier === tier)?.accuracy ?? Number.NaN;

describe('e2 statistics: a slope is a summary, not the story', () => {
  it('fits degradation against fill, so a worsening curve has a positive slope', () => {
    const cells = cellsFor({ control: [8, 8, 6, 2], treatment: [8, 8, 8, 2] });
    const curve = summariseE2Curves(cells).find((candidate) => candidate.arm === E2_BASELINE_ARM);
    assert.ok(curve !== undefined);
    assert.ok(curve.rotSlope.slope > 0, `a control that fell from 8/8 to 2/8 fitted ${curve.rotSlope.slope}`);
    assert.ok(curve.rotSlope.intercept < 0, 'degradation should approach zero at zero fill');
    assert.equal(curve.rotSlope.points, 4);
    assert.ok((curve.rotSlope.rSquared ?? 0) > 0.9, `r² of ${String(curve.rotSlope.rSquared)} is not a straight line`);
  });

  it('reports a slope of NaN rather than a number when fewer than two tiers survived', () => {
    const all = cellsFor({ control: [8, 8, 8, 8], treatment: [8, 8, 8, 8] });
    const oneTier = all.filter((cell) => cell.family === 'niah' || cell.tier === 't80');
    const curve = summariseE2Curves(oneTier).find((candidate) => candidate.arm === E2_BASELINE_ARM);
    assert.ok(curve !== undefined);
    assert.ok(Number.isNaN(curve.rotSlope.slope));
    assert.equal(curve.rotSlope.rSquared, null);
  });

  it('separates a flat-then-crash curve from a steady one, and exposes the endpoint trap', () => {
    // Same endpoint, opposite shapes: the steady curve fails early and holds,
    // the crash curve holds and then falls off a cliff. Their endpoint comparison
    // is identical, which is why §E2 insists on the curve.
    const steady = summariseE2Curves(cellsFor({ control: [8, 4, 2, 2], treatment: [8, 4, 2, 2] })).find(
      (candidate) => candidate.arm === E2_BASELINE_ARM,
    );
    const crash = summariseE2Curves(cellsFor({ control: [8, 8, 7, 2], treatment: [8, 8, 7, 2] })).find(
      (candidate) => candidate.arm === E2_BASELINE_ARM,
    );
    assert.ok(steady !== undefined && crash !== undefined);
    assert.ok(crash.rotSlope.slope > steady.rotSlope.slope, 'the crash curve should have the steeper slope');
    assert.equal(tierAccuracyAtTest(steady.rotByTier, 't80'), tierAccuracyAtTest(crash.rotByTier, 't80'));
    // Both fits are reported, and neither is a straight line, so the slope is a
    // summary of a shape and not a stand-in for it.
    for (const curve of [steady, crash]) {
      assert.equal(curve.rotSlope.points, 4);
      assert.ok(curve.rotSlope.rSquared !== null && curve.rotSlope.rSquared < 1, 'r² should be reported and honest');
    }
  });

  it('drops excluded cells instead of scoring them as failures, and counts the removal', () => {
    const cells = cellsFor({ control: [8, 8, 8, 8], treatment: [8, 8, 8, 8], excludedTiers: ['t50'] });
    const curve = summariseE2Curves(cells).find((candidate) => candidate.arm === E2_BASELINE_ARM);
    assert.ok(curve !== undefined);
    const t50 = curve.rotByTier.find((tier) => tier.tier === 't50');
    assert.ok(t50 !== undefined);
    assert.equal(t50.cases, 0);
    assert.equal(t50.accuracy, null);
    assert.equal(t50.excluded, 8);
    // Three surviving points is still a fit; two is not.
    assert.equal(curve.rotSlope.points, 3);
  });

  it('bootstraps the same number every time, from the same seed', () => {
    const cells = cellsFor({ control: [8, 7, 5, 2], treatment: [8, 8, 6, 3] });
    const first = bootstrapE2SlopeDifference(cells, { resamples: 500 });
    const second = bootstrapE2SlopeDifference(cells, { resamples: 500 });
    assert.equal(first.lower, second.lower);
    assert.equal(first.upper, second.upper);
    assert.equal(first.usedResamples, second.usedResamples);
    assert.ok(Number.isFinite(first.lower) && Number.isFinite(first.upper));
  });

  it('says degenerate rather than printing an interval from a handful of usable draws', () => {
    // One surviving tier: no line through one point, so no replicate produces a
    // slope and there is no interval to print.
    const oneTier = cellsFor({ control: [8, 8, 8, 8], treatment: [8, 8, 8, 8] }).filter(
      (cell) => cell.family === 'niah' || cell.tier === 't80',
    );
    const interval = bootstrapE2SlopeDifference(oneTier, { resamples: 100 });
    assert.equal(interval.state, 'degenerate');
    assert.ok(Number.isNaN(interval.lower) && Number.isNaN(interval.upper), 'a degenerate interval has no bounds');
    assert.equal(interval.usedResamples, 0);
  });

  it('changes the seed it was given, or the interval is not an interval', () => {
    const cells = cellsFor({ control: [8, 7, 5, 2], treatment: [8, 8, 6, 3] });
    const a = bootstrapE2SlopeDifference(cells, { resamples: 500, seed: 1 });
    const b = bootstrapE2SlopeDifference(cells, { resamples: 500, seed: 2 });
    assert.notEqual(a.lower, b.lower);
  });
});

describe('e2 probe validity: is this measuring rot or just length', () => {
  it('calls the shipped shape distinguishing: NIAH flat, rot falling', () => {
    const probe = evaluateE2ProbeValidity(cellsFor({ control: [8, 7, 4, 1], treatment: [8, 8, 6, 3] }));
    assert.equal(probe.status, 'distinguishing');
    assert.equal(probe.niahExceedsMaxDrop, false);
    assert.equal(probe.rotDegrades, true);
    assert.ok(probe.niahDrop >= 0, `NIAH dropped ${probe.niahDrop}, which is not flat`);
    assert.ok(probe.rotDrop < 0);
    assert.match(probe.statement, /distinguishing/);
  });

  it('calls it confounded when NIAH degrades as well, and says the probe needs redesign', () => {
    const probe = evaluateE2ProbeValidity(
      cellsFor({ control: [8, 6, 4, 1], treatment: [8, 7, 5, 2], niah: [1, 1, 0, 0] }),
    );
    assert.equal(probe.status, 'confounded');
    assert.equal(probe.niahExceedsMaxDrop, true);
    assert.match(probe.detail, /long-input-is-hard/);
  });

  it('calls it blind when nothing degrades, rather than reporting a flat curve as a pass', () => {
    const probe = evaluateE2ProbeValidity(cellsFor({ control: [8, 8, 8, 8], treatment: [8, 8, 8, 8] }));
    assert.equal(probe.status, 'blind');
    assert.equal(probe.rotDegrades, false);
    assert.match(probe.statement, /blind/);
  });

  it('calls it blind when the easiest tier is already at chance, which is a different fault', () => {
    // 2/8 on the rot families and the NIAH case failed too, so the pooled easiest
    // tier sits at 2/9, below chance plus slack, while rot still falls across the
    // window. "Cannot read it at 5% fill" and "no signal anywhere" are different
    // faults and get different statements.
    const probe = evaluateE2ProbeValidity(
      cellsFor({ control: [2, 2, 2, 0], treatment: [2, 2, 2, 0], niah: [0, 1, 1, 1] }),
    );
    assert.equal(probe.status, 'blind');
    assert.equal(probe.easiestTierAtChance, true);
    assert.match(probe.statement, /easiest tier/);
  });

  it('calls it undetermined when NIAH degrades *and* the rot families do not follow', () => {
    const probe = evaluateE2ProbeValidity(
      cellsFor({ control: [8, 8, 8, 8], treatment: [8, 8, 8, 8], niah: [1, 1, 0, 0] }),
    );
    assert.equal(probe.status, 'undetermined');
  });

  it('calls it undetermined when there is nothing to measure', () => {
    const probe = evaluateE2ProbeValidity([]);
    assert.equal(probe.status, 'undetermined');
    assert.match(probe.detail, /no scored cells|could not both be measured/);
  });
});

describe('e2 gate G5: treatment slope <= control slope, or a refusal', () => {
  it('passes the point estimate and stays inconclusive at the fixture scale', () => {
    const cells = cellsFor({ control: [8, 7, 4, 1], treatment: [8, 8, 7, 5] });
    // The point estimate is on the passing side, and the same numbers at the
    // pre-registered scale would also be a pass; at the 3 rot cases per tier this
    // fixture actually ran, the gate refuses to claim it.
    const atScale = gateFor(cells, E2_ROT_FAMILIES.length);
    const atTarget = gateFor(cells, E2_CASES_PER_TIER_TARGET);
    assert.ok(atScale.difference < E2_SLOPE_THRESHOLD, `difference ${atScale.difference} is not on the passing side`);
    assert.equal(atScale.status, 'inconclusive');
    assert.equal(atScale.casesPerTier, E2_ROT_FAMILIES.length);
    assert.equal(atScale.casesPerTierTarget, E2_CASES_PER_TIER_TARGET);
    assert.match(atScale.detail, /not claimed|inconclusive|pre-registered/);
    assert.equal(atTarget.status, 'observed');
    assert.equal(atScale.degradationAxis, E2_DEGRADATION_AXIS);
  });

  it('refuses to read a slope from a confounded probe even when the point estimate passes', () => {
    const cells = cellsFor({ control: [8, 6, 4, 1], treatment: [8, 8, 8, 7], niah: [1, 1, 0, 0] });
    const gate = gateFor(cells);
    assert.equal(gate.probe.status, 'confounded');
    assert.equal(gate.status, 'inconclusive');
    assert.match(gate.detail, /not evidence either way/);
    assert.match(gate.detail, /inconclusive/);
  });

  it('reports not_observed when the treatment degrades faster, and says so at any n', () => {
    const gate = gateFor(cellsFor({ control: [8, 7, 5, 3], treatment: [8, 5, 2, 0] }));
    assert.ok(gate.difference > E2_SLOPE_THRESHOLD, `difference ${gate.difference} should be on the failing side`);
    assert.equal(gate.status, 'not_observed');
    assert.ok(gate.treatmentSlope > gate.controlSlope);
  });

  it('flags the case where the endpoint would have passed and the curve did not', () => {
    // The treatment ends *better* at t80 but degrades faster on the way there.
    // Deliberately non-monotone: the treatment collapses at the 50% tier and
    // recovers, which is the shape a report reading only the endpoint gets wrong.
    const cells = cellsFor({ control: [8, 8, 8, 5], treatment: [8, 8, 0, 6] });
    const gate = gateFor(cells);
    assert.ok(gate.treatmentSlope > gate.controlSlope, 'the treatment slope should be worse');
    assert.ok(
      (gate.endpoint.treatment ?? 0) > (gate.endpoint.control ?? 0),
      'the endpoint should look better for the treatment',
    );
    assert.equal(gate.endpoint.endpointWouldMislead, true);
    assert.ok((gate.endpoint.endpointDifference ?? 0) > 0, 'the endpoint difference should favour the treatment');
  });

  it('keeps the truncated arm in the report without letting it into the comparison', () => {
    const cells = cellsFor({ control: [8, 7, 4, 1], treatment: [8, 8, 7, 5], truncated: [1, 1, 0, 0] });
    const gate = gateFor(cells);
    assert.equal(gate.truncatedSlope, gate.truncatedSlope);
    assert.ok(Number.isFinite(gate.truncatedSlope), 'the truncated arm should still be fitted and reported');
    assert.notEqual(gate.difference, gate.truncatedSlope - gate.controlSlope);
  });

  it('is NaN rather than optimistic when an arm never ran', () => {
    const cells = cellsFor({ control: [8, 7, 4, 1], treatment: [8, 7, 4, 1] }).filter(
      (cell) => cell.arm !== 'treatment',
    );
    const gate = gateFor(cells);
    assert.ok(Number.isNaN(gate.treatmentSlope));
    assert.equal(gate.status, 'inconclusive');
  });
});

describe('e2 provenance: where a number came from', () => {
  it('records the subject, the declared scale, and the TODO for the live campaign', async () => {
    const result = await defaultRun();
    assert.equal(result.provenance.subjectId, 'offline-degradation-model');
    assert.equal(result.provenance.probeCount, E2_PROBES.length);
    assert.equal(result.provenance.rotCasesPerTier, E2_ROT_FAMILIES.length);
    assert.equal(result.provenance.rotCasesPerTierTarget, E2_CASES_PER_TIER_TARGET);
    // Zero, not one: no model family was measured, the offline subject is a
    // declared synthetic model, and provenance is not allowed to imply otherwise.
    assert.equal(result.provenance.modelFamiliesObserved, 0);
    assert.equal(result.provenance.windowTokens, E2_WINDOW_TOKENS);
    assert.equal(result.provenance.truncationBudgetTokens, E2_TRUNCATION_BUDGET_TOKENS);
    assert.equal(result.provenance.needleDepth, E2_NEEDLE_DEPTH);
    assert.match(result.provenance.degradationModel, /none measured|declared/);
    assert.ok(result.provenance.todos.some((todo) => /F2|live model/i.test(todo)));
    assert.ok(result.provenance.todos.some((todo) => /per-tier target|campaign/i.test(todo)));
  });

  it('names the subject it was given, not a default', async () => {
    const result = await runE2Suite({ subject: makeModel(E2_PROBES, { id: 'named-subject' }) });
    assert.equal(result.provenance.subjectId, 'named-subject');
  });

  it('leaves the live campaign as a TODO rather than claiming a scale it did not run', async () => {
    const result = await defaultRun();
    assert.ok(result.gate.casesPerTier < result.gate.casesPerTierTarget);
    assert.equal(result.gate.status, 'inconclusive');
    // The probe itself is fine, which is why the refusal is about the scale and
    // not about the instrument.
    assert.equal(result.gate.probe.status, 'distinguishing');
    assert.ok(result.provenance.todos.length > 0);
  });
});
