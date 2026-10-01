import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSensitiveHeader } from '../src/credentials.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  DISABLED_NARRATION_CONFIG,
  GOVERNANCE_FIELD_NAMES,
  NARRATION_BACKEND,
  NARRATION_BACKENDS,
  NARRATION_FIELDS,
  NARRATION_MIN_TOKENS,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  OLLAMA_MAX_OUTPUT_TOKENS,
  OllamaBadResponseError,
  OllamaError,
  OllamaModelNotFoundError,
  OllamaNotLoopbackError,
  OllamaTimeoutError,
  OllamaTransportError,
  OllamaUnreachableError,
  buildNarrationInstruction,
  buildNarrationRequest,
  enabledNarrationConfig,
  isNarrationBackend,
  isNarrationField,
  listOllamaModels,
  narrate,
  ollamaClientFromFetch,
  parseNarrationReply,
  resolveNarrationConfig,
  shouldNarrate,
  stripGovernanceText,
  type NarrationConfig,
  type NarrationFailure,
  type NarrationField,
  type OllamaHttpClient,
  type OllamaHttpRequest,
} from '../src/ollama-adapter.js';

/* -------------------------------------------------------------------------- */
/* Fixtures and harness                                                         */
/* -------------------------------------------------------------------------- */

const CONSTRAINT = 'never delete production data without explicit approval';
const SPAN = 'turn 1: read uploader.ts. turn 2: found an N+1 in listUploads. turn 3: tests pass.';

/** One token over the floor, so the gate holds on everything else. */
const ABOVE_FLOOR = NARRATION_MIN_TOKENS + 1;

/**
 * Every fixture config goes through the shipped default for everything it does not
 * care about, so a change to `DISABLED_NARRATION_CONFIG` shows up here as a changed
 * assertion rather than as a silently different test.
 */
const config = (overrides: Partial<NarrationConfig> = {}): NarrationConfig => ({
  ...DISABLED_NARRATION_CONFIG,
  model: 'gemma3:1b',
  enabled: true,
  ...overrides,
});

interface Reply {
  readonly status: number;
  readonly body: string;
}

interface Recorded {
  readonly client: OllamaHttpClient;
  readonly calls: readonly OllamaHttpRequest[];
}

/**
 * A transport that records what it was asked and replays a scripted answer. The
 * only I/O surface in this file except the opt-in smoke test at the bottom.
 */
function recording(answer: (request: OllamaHttpRequest) => Reply): Recorded {
  const calls: OllamaHttpRequest[] = [];
  return {
    calls,
    // The transport is promise-returning by contract, so a fake that returned
    // synchronously would not exercise the await in the real path.
    // eslint-disable-next-line @typescript-eslint/require-await
    client: async (request) => {
      calls.push(request);
      return answer(request);
    },
  };
}

/** Ollama's success envelope, wrapped around whatever the model said. */
const chatReply = (content: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: JSON.stringify({
    model: 'gemma3:1b',
    done: true,
    done_reason: 'stop',
    message: { role: 'assistant', content },
    ...extra,
  }),
});

/**
 * What a fetch rejection actually looks like: a bare `TypeError` with the syscall
 * code on `cause`. Hand-built rather than induced, because a test that provokes a
 * real ECONNREFUSED is a test that opens a socket.
 */
const fetchFailure = (code: string): TypeError =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`connect ${code} 127.0.0.1:11434`), { code }),
  });

const body = (request: OllamaHttpRequest): Record<string, unknown> =>
  JSON.parse(request.body ?? '{}') as Record<string, unknown>;

/** Spelled out rather than reused from the module, so a change there is a red test. */
const REQUESTED: readonly NarrationField[] = ['goal', 'decided', 'unresolved', 'next'];

const messageAt = (request: OllamaHttpRequest, index: number): string => {
  const messages = body(request)['messages'];
  const entry = Array.isArray(messages) ? messages[index] : undefined;
  return typeof entry === 'object' && entry !== null && typeof entry['content'] === 'string'
    ? entry['content']
    : '';
};

/** The failure an adapter result carries, or null when there was not one. */
const failureOf = (
  result: Awaited<ReturnType<typeof narrate>>,
): OllamaError | null => (result.status === 'failed' ? result.error : null);

/**
 * Narrows to the failure arm, failing the assertion if it did not fail.
 *
 * `narrate` never rejects, so a test that reaches for `result.code` without this
 * is asserting on a union where only one member carries it. Written once here
 * rather than as `if (result.status !== 'failed') return;` at each site: that
 * early return silently turns a would-be failure into a passing test, which is
 * the one outcome a redactor-style adapter test must never produce.
 */
const expectFailure = (result: Awaited<ReturnType<typeof narrate>>): NarrationFailure => {
  assert.equal(result.status, 'failed', `expected a failure, got ${result.status}`);
  assert.ok(result.status === 'failed');
  return result;
};

test('a disabled config never opens a socket, however large the span', async () => {
  const { client, calls } = recording(() => chatReply('{"goal":"g"}'));
  const result = await narrate({
    config: DISABLED_NARRATION_CONFIG,
    client,
    text: SPAN,
    tokens: 10_000_000,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'disabled');
  assert.equal(calls.length, 0, 'the gate runs before the transport, not after');
});

test('enabled is read from the flag, not from the presence of a model', async () => {
  const { client, calls } = recording(() => chatReply('{"goal":"g"}'));
  const result = await narrate({
    config: { ...DISABLED_NARRATION_CONFIG, model: 'gemma3:1b' },
    client,
    text: SPAN,
    tokens: ABOVE_FLOOR,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(calls.length, 0);
});

test('a config document that omits enabled resolves to disabled', () => {
  const parsed = resolveNarrationConfig({ model: 'gemma3:1b' });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.enabled, false);
});

test('a snake_case key from docs/integrations.md is refused, not half-applied', () => {
  // That block is YAML. `enabled` survives being copied out of it because the word
  // is the same in both conventions; `min_tokens` does not, and a silently ignored
  // `min_tokens` would apply the default floor and look configured.
  const parsed = resolveNarrationConfig({ enabled: true, model: 'gemma3:1b', min_tokens: 9_000 });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  const issue = parsed.issues.find((i) => i.path === 'min_tokens');
  assert.equal(issue?.code, 'unknown_key');
  assert.match(issue?.message ?? '', /minTokens/, 'and it lists the key that was meant');
});

test('the token floor holds, and holds at exactly the threshold', () => {
  const at = shouldNarrate({ config: config(), tokens: NARRATION_MIN_TOKENS });
  assert.equal(at.fire, false);
  assert.equal(at.reason, 'below_min_tokens');
  const over = shouldNarrate({ config: config(), tokens: NARRATION_MIN_TOKENS + 1 });
  assert.equal(over.fire, true);
  assert.equal(over.reason, 'ready');
});

test('disabled outranks the token floor', () => {
  // Only one order is safe, and it is the one that ignores everything else.
  const decision = shouldNarrate({ config: DISABLED_NARRATION_CONFIG, tokens: ABOVE_FLOOR });
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'disabled');
});

test('asking for no fields holds rather than paying for an empty schema', () => {
  const decision = shouldNarrate({ config: config({ fields: [] }), tokens: ABOVE_FLOOR });
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'no_fields');
});

test('an enabled config above the floor does narrate', async () => {
  const { client, calls } = recording(() =>
    chatReply(JSON.stringify({ goal: 'index the uploader table', unresolved: ['backfill'] })),
  );
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'narrated');
  assert.equal(calls.length, 1);
  assert.equal(result.narrative?.goal, 'index the uploader table');
  assert.equal(result.backend, NARRATION_BACKEND);
  assert.equal(result.model, 'gemma3:1b');
  assert.equal(result.completeness, 'complete');
  assert.equal(result.usable, true);
});

/* -------------------------------------------------------------------------- */
/* The config document                                                          */
/* -------------------------------------------------------------------------- */

test('a config resolves with the documented defaults and stays frozen', () => {
  const parsed = resolveNarrationConfig({ enabled: true, model: 'gemma3:1b' });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.backend, NARRATION_BACKEND);
  assert.equal(parsed.config.baseUrl, DEFAULT_OLLAMA_BASE_URL);
  assert.equal(parsed.config.minTokens, NARRATION_MIN_TOKENS);
  assert.equal(parsed.config.timeoutMs, OLLAMA_DEFAULT_TIMEOUT_MS);
  assert.equal(parsed.config.maxOutputTokens, OLLAMA_MAX_OUTPUT_TOKENS);
  assert.equal(Object.isFrozen(parsed.config), true);
});

test('every problem is reported in one pass', () => {
  // The config document is operator-owned untrusted input; a loader that throws on
  // the first problem costs a round trip per problem.
  const parsed = resolveNarrationConfig({ enabled: 'yes', model: '  ', timeoutMs: 0 });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(
    parsed.issues.map((i) => `${i.path}:${i.code}`).sort(),
    ['enabled:type', 'model:format', 'timeoutMs:range'],
  );
});

test('the backend name is a closed set', () => {
  const wrong = resolveNarrationConfig({ model: 'm', backend: 'lmstudio' });
  assert.equal(wrong.ok, false);
  if (wrong.ok) return;
  assert.equal(wrong.issues[0]?.code, 'enum');
  assert.deepEqual([...NARRATION_BACKENDS], ['ollama']);
  assert.equal(isNarrationBackend('ollama'), true);
  assert.equal(isNarrationBackend('Ollama'), false);
});

test('`constraints` can never be requested from a model', () => {
  // docs/integrations.md: "local_model.fields excludes constraints by
  // construction. The type should make it impossible to pass a governance field to
  // a model." The union makes it impossible to *write*; the config document is not
  // typechecked anywhere, so the runtime has to say it too, and say it by name.
  assert.equal(
    (NARRATION_FIELDS as readonly string[]).includes('constraints'),
    false,
    'the compile-time half',
  );
  const parsed = resolveNarrationConfig({ model: 'm', fields: ['goal', 'constraints'] });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  const issue = parsed.issues.find((i) => i.path === 'fields');
  assert.match(issue?.message ?? '', /governance field/);
  assert.match(issue?.message ?? '', /constraints/);
});

test('every governance-looking field name is refused, not just constraints', () => {
  for (const name of GOVERNANCE_FIELD_NAMES) {
    const parsed = resolveNarrationConfig({ model: 'm', fields: [name] });
    assert.equal(parsed.ok, false, name);
  }
});

test('unknown fields are refused; known ones are deduplicated', () => {
  const bad = resolveNarrationConfig({ model: 'm', fields: ['goal', 'decisions'] });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.issues[0]?.code, 'enum');
  const good = resolveNarrationConfig({ model: 'm', fields: ['goal', 'goal', 'next'] });
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.deepEqual([...good.config.fields], ['goal', 'next']);
});

test('a bad field type is reported without discarding the good fields', () => {
  const parsed = resolveNarrationConfig({ model: 'm', fields: 'goal' });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.issues[0]?.code, 'type');
});

test('the requested field list is the four narration fields, spelled out', () => {
  assert.deepEqual([...NARRATION_FIELDS], [...REQUESTED]);
  assert.equal(NARRATION_FIELDS.includes('goal'), true);
  assert.equal(NARRATION_FIELDS.length, 4, 'and there is no fifth');
});

test('enabledNarrationConfig is the shipped default with the opt-in turned on', () => {
  // The call a test or an operator writes, so it is worth pinning: it must not be a
  // second source of defaults that can drift from DISABLED_NARRATION_CONFIG.
  const built = enabledNarrationConfig({ model: 'gemma3:1b' });
  assert.equal(built.enabled, true);
  assert.equal(built.model, 'gemma3:1b');
  for (const key of Object.keys(DISABLED_NARRATION_CONFIG) as (keyof typeof DISABLED_NARRATION_CONFIG)[]) {
    // `enabled` is what this helper flips and `model` is what the caller supplies;
    // every other key has to be the shipped default, or there are two sources of it.
    if (key === 'enabled' || key === 'model') continue;
    assert.deepEqual(built[key], DISABLED_NARRATION_CONFIG[key], key);
  }
  const narrowed = enabledNarrationConfig({ model: 'm', fields: ['goal'] });
  assert.deepEqual([...narrowed.fields], ['goal']);
});

test('model is required, because no default model can be right on every machine', () => {
  const parsed = resolveNarrationConfig({ enabled: true });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.issues[0]?.code, 'missing');
  assert.equal(parsed.issues[0]?.path, 'model');
});

test('a non-loopback host is refused unless the operator claims it', () => {
  // Tier 3 hands the transcript to another process. On a LAN host that is egress,
  // and N4 is a claim about this process.
  const refused = resolveNarrationConfig({ model: 'm', baseUrl: 'http://gpu-box.lan:11434' });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.issues[0]?.message ?? '', /loopback/);
  assert.equal(
    resolveNarrationConfig({
      model: 'm',
      baseUrl: 'http://gpu-box.lan:11434',
      allowNonLoopback: true,
    }).ok,
    true,
  );
});

test('loopback in all three spellings is accepted', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]']) {
    assert.equal(resolveNarrationConfig({ model: 'm', baseUrl: `http://${host}:11434` }).ok, true, host);
  }
});

test('a baseUrl that is not an absolute http(s) URL is refused', () => {
  for (const baseUrl of ['127.0.0.1:11434', 'ftp://127.0.0.1', 'ollama', '']) {
    assert.equal(resolveNarrationConfig({ model: 'm', baseUrl }).ok, false, baseUrl);
  }
});

test('a hand-written config cannot route context off the loopback', () => {
  // The resolver is one of two doors into a config; this is the other one, and it
  // is the last point before bytes leave.
  assert.throws(
    () => buildNarrationRequest(config({ baseUrl: 'http://10.0.0.5:11434' }), SPAN),
    OllamaNotLoopbackError,
  );
  const escaped = buildNarrationRequest(
    config({ baseUrl: 'http://10.0.0.5:11434', allowNonLoopback: true }),
    SPAN,
  );
  assert.equal(escaped.url, 'http://10.0.0.5:11434/api/chat');
});

test('a baseUrl that does not parse is refused at the point of use too', () => {
  assert.throws(
    () => buildNarrationRequest(config({ baseUrl: 'nonsense' }), SPAN),
    OllamaBadResponseError,
  );
});

/* -------------------------------------------------------------------------- */
/* Request shaping                                                              */
/* -------------------------------------------------------------------------- */

test('the request is a JSON POST to /api/chat with the model and the span', () => {
  const request = buildNarrationRequest(config(), SPAN);
  assert.equal(request.url, `${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(body(request)['model'], 'gemma3:1b');
  assert.equal(messageAt(request, 1), SPAN);
});

test('the completion is asked for as JSON, unstreamed, at temperature 0', () => {
  const request = buildNarrationRequest(config(), SPAN);
  assert.equal(body(request)['format'], 'json');
  assert.equal(body(request)['stream'], false);
  const options = body(request)['options'];
  assert.equal(typeof options, 'object');
  assert.equal((options as Record<string, unknown>)['temperature'], 0);
  assert.equal((options as Record<string, unknown>)['num_predict'], OLLAMA_MAX_OUTPUT_TOKENS);
});

test('a path prefix in baseUrl is honoured rather than dropped', () => {
  const request = buildNarrationRequest(config({ baseUrl: 'http://127.0.0.1:8080/ollama/' }), SPAN);
  assert.equal(request.url, 'http://127.0.0.1:8080/ollama/api/chat');
});

test('no header on the wire is sensitive, because Ollama takes no API key', () => {
  // Routed through `isSensitiveHeader` rather than a local list: AGENTS §10, and
  // re-deriving that list is how a header leaks.
  const request = buildNarrationRequest(config(), SPAN);
  for (const name of Object.keys(request.headers)) {
    assert.equal(isSensitiveHeader(name), false, name);
  }
});

test('the instruction asks only for the fields that were requested', () => {
  const one = buildNarrationRequest(config({ fields: ['goal'] }), SPAN);
  const instruction = messageAt(one, 0);
  assert.match(instruction, /"goal"/);
  assert.ok(!instruction.includes('"decided"'), 'an unrequested key costs tokens and accuracy');
  assert.ok(!instruction.includes('"unresolved"'));
});

test('the instruction tells the model not to write policy', () => {
  const instruction = buildNarrationInstruction(['goal', 'decided', 'unresolved', 'next']);
  assert.match(instruction, /never emit them/);
  assert.match(instruction, /no code fence/);
  assert.deepEqual(
    ['goal', 'decided', 'unresolved', 'next'].map((f) => isNarrationField(f)),
    [true, true, true, true],
  );
  assert.equal(isNarrationField('why'), false, 'the doc spelling is not representable; see the module');
});

test('pinned constraint text is deleted before the body is serialized', () => {
  // Not belt-and-braces: the model has read the pin set by this point, so a
  // constraint can be quoted back inside an ordinary sentence.
  const request = buildNarrationRequest(
    config(),
    `${SPAN} Reminder: ${CONSTRAINT}. Back to work.`,
    [CONSTRAINT],
  );
  assert.ok(!(request.body ?? '').includes(CONSTRAINT));
  assert.ok(messageAt(request, 1).includes('Back to work.'), 'ordinary text survives');
});

test('stripGovernanceText removes each pinned string and nothing else', () => {
  assert.equal(stripGovernanceText('a X b Y c', ['X', 'Y']), 'a  b  c');
  assert.equal(stripGovernanceText('a X b', []), 'a X b');
  assert.equal(stripGovernanceText('a b', ['  ']), 'a b', 'blank pins are not needles');
});

test('the same config and span produce a byte-identical request', () => {
  // N6 parity for everything this package controls. The completion is exempt
  // (docs/development.md §6 DoD 2), the request is not.
  const first = buildNarrationRequest(config(), SPAN, [CONSTRAINT]);
  const second = buildNarrationRequest(config(), SPAN, [CONSTRAINT]);
  assert.equal(first.body, second.body);
  assert.equal(first.url, second.url);
});

test('the budget rides along as an abort signal', () => {
  const request = buildNarrationRequest(config({ timeoutMs: 1_234 }), SPAN);
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.signal?.aborted, false);
});

/* -------------------------------------------------------------------------- */
/* Response parsing                                                             */
/* -------------------------------------------------------------------------- */

test('the narrative is read out of the completion', () => {
  const parsed = parseNarrationReply(
    config(),
    {
      message: {
        content: JSON.stringify({
          goal: 'ship the uploader fix',
          decided: [{ id: 'D1', choice: 'add the index', why: 'the query is O(n) today' }],
          unresolved: ['backfill existing rows'],
          next: {
            question: 'does it hold at 100k rows?',
            next_command: 'npm run bench:uploads',
            blockers: ['staging is busy'],
          },
        }),
      },
      prompt_eval_count: 812,
      eval_count: 109,
      done_reason: 'stop',
    },
  );
  assert.equal(parsed.narrative.goal, 'ship the uploader fix');
  assert.deepEqual(parsed.narrative.decided, [
    { id: 'D1', choice: 'add the index', why: 'the query is O(n) today' },
  ]);
  assert.deepEqual([...parsed.narrative.unresolved], ['backfill existing rows']);
  assert.equal(parsed.narrative.next.nextCommand, 'npm run bench:uploads');
  assert.deepEqual([...parsed.narrative.next.blockers], ['staging is busy']);
  assert.deepEqual(parsed.defects, []);
  assert.equal(parsed.completeness, 'complete');
  assert.equal(parsed.usable, true);
});

test('usage comes from Ollama counters, and is null when there are none', () => {
  const measured = parseNarrationReply(
    config(),
    { message: { content: '{"goal":"g"}' }, prompt_eval_count: 10, eval_count: 4, done_reason: 'stop' },
  );
  assert.equal(measured.usage?.promptTokens, 10);
  assert.equal(measured.usage?.completionTokens, 4);
  assert.equal(measured.usage?.doneReason, 'stop');
  const estimated = parseNarrationReply(config(), { message: { content: '{"goal":"g"}' } });
  assert.equal(estimated.usage, null, 'never invent a count where none was measured');
});

test('the real gemma3:1b answer degrades to a partial instead of throwing', () => {
  // Captured from Ollama 0.14.1 with `format:"json"`: valid JSON, `decided` as an
  // array of strings, and an invented fifth key. Constrained decoding fixed the
  // syntax and not the shape.
  const parsed = parseNarrationReply(config(), {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        goal: 'Optimize database indexing for improved query performance',
        decided: ['Add index on (tenant_id, created_at)'],
        unresolved: [],
        next_decided: [{ id: '1', choice: 'Analyze query performance', why: 'To ensure' }],
      }),
    },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 99,
    eval_count: 109,
  });
  assert.equal(parsed.narrative.goal, 'Optimize database indexing for improved query performance');
  assert.deepEqual(parsed.narrative.decided, [], 'a decision without a shape is dropped, not invented');
  assert.deepEqual(
    parsed.defects.map((d) => d.kind).sort(),
    ['malformed_decision', 'unknown_field'],
  );
  assert.equal(parsed.completeness, 'partial');
  assert.equal(parsed.usable, true, 'partial is still usable; goal survived');
});

test('a decision without an id gets a positional label, not a fabricated one', () => {
  const parsed = parseNarrationReply(config(), {
    message: { content: JSON.stringify({ goal: 'g', decided: [{ choice: 'kept it' }] }) },
  });
  assert.deepEqual(parsed.narrative.decided, [{ id: 'D1', choice: 'kept it', why: '' }]);
  assert.deepEqual(parsed.defects, [], 'a missing id is not a shape error');
});

test('a bare string is accepted where a list was asked for', () => {
  const parsed = parseNarrationReply(config(), {
    message: { content: JSON.stringify({ goal: 'g', unresolved: 'one open question' }) },
  });
  assert.deepEqual([...parsed.narrative.unresolved], ['one open question']);
});

test('a field the operator did not request is ignored, and is not a defect', () => {
  const parsed = parseNarrationReply(
    config({ fields: ['goal'] }),
    { message: { content: JSON.stringify({ goal: 'g', unresolved: ['not asked for'] }) } },
  );
  assert.deepEqual([...parsed.narrative.unresolved], []);
  assert.deepEqual(parsed.defects, []);
});

test('a governance key in the completion is dropped and recorded', () => {
  // "We did not ask for it" is not a property of model output, and
  // `Gist.constraints` is a byte-equality target: a model-written entry would make
  // step 4c a tautology.
  const parsed = parseNarrationReply(config(), {
    message: {
      content: JSON.stringify({ goal: 'g', constraints: [CONSTRAINT], policy: ['be careful'] }),
    },
  });
  assert.deepEqual(parsed.defects.map((d) => d.kind).sort(), [
    'governance_ignored',
    'governance_ignored',
  ]);
  assert.ok(!JSON.stringify(parsed.narrative).includes('never delete'));
});

test('a decided list that is not a list is a defect, not a crash', () => {
  const parsed = parseNarrationReply(config(), {
    message: { content: JSON.stringify({ goal: 'g', decided: { id: 'D1' } }) },
  });
  assert.deepEqual(parsed.narrative.decided, []);
  assert.deepEqual(parsed.defects.map((d) => d.kind), ['malformed_decision_list']);
});

test('a next that is not an object is a defect, and next stays empty', () => {
  const parsed = parseNarrationReply(config(), {
    message: { content: JSON.stringify({ goal: 'g', next: 'run the tests' }) },
  });
  assert.deepEqual(parsed.narrative.next, { question: '', nextCommand: '', blockers: [] });
  assert.deepEqual(parsed.defects.map((d) => d.kind), ['malformed_next']);
});

test('a completion with no goal is reported unusable rather than half-believed', () => {
  const parsed = parseNarrationReply(config(), { message: { content: '{}' } });
  assert.equal(parsed.usable, false, 'GistSchema requires a non-empty goal');
  assert.equal(parsed.narrative.goal, '');
  assert.deepEqual(parsed.defects.map((d) => d.kind), ['no_goal']);
});

test('a fenced completion is still read', () => {
  const parsed = parseNarrationReply(config(), {
    message: { content: '```json\n{"goal":"ship it"}\n```' },
  });
  assert.equal(parsed.narrative.goal, 'ship it');
});

test('a completion that is not JSON is refused, with a bounded excerpt', () => {
  // There is no partial narrative to salvage from English prose, and reporting
  // "narrated, everything empty" would make an unusable answer look used.
  const thrown = (() => {
    try {
      parseNarrationReply(config(), { message: { content: 'I would rather not.' } });
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(thrown instanceof OllamaBadResponseError);
  assert.ok(thrown.detail.length <= 260);
});

test('a completion that is not an object is refused', () => {
  assert.throws(
    () => parseNarrationReply(config(), { message: { content: '[1, 2]' } }),
    OllamaBadResponseError,
  );
});

test('a reply with no message content is refused', () => {
  assert.throws(() => parseNarrationReply(config(), { done: true }), OllamaBadResponseError);
  assert.throws(() => parseNarrationReply(config(), { message: { content: '   ' } }), OllamaBadResponseError);
});

/* -------------------------------------------------------------------------- */
/* The failure taxonomy                                                         */
/* -------------------------------------------------------------------------- */

test('a missing model is named, with the command that fixes it', async () => {
  const { client } = recording(() => ({
    status: 404,
    body: JSON.stringify({ error: "model 'gemma3:1b' not found" }),
  }));
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.equal(result.code, 'model_not_found');
  assert.ok(result.error instanceof OllamaModelNotFoundError);
  assert.equal(result.error.model, 'gemma3:1b');
  assert.match(result.error.message, /ollama pull gemma3:1b/);
});

test('the older "try pulling it first" spelling is the same failure', async () => {
  const { client } = recording(() => ({
    status: 404,
    body: JSON.stringify({ error: 'model "gemma3:1b" not found, try pulling it first' }),
  }));
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(expectFailure(result).code, 'model_not_found');
});

test('a 404 from the wrong path is NOT reported as a missing model', async () => {
  // Go's router answers an unknown path with `404 page not found`. A status-only
  // rule would report our own routing bug as the operator's missing model -- the
  // false gate AGENTS §10 says gets muted.
  const { client } = recording(() => ({ status: 404, body: '404 page not found' }));
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.equal(result.code, 'ollama_bad_response');
  assert.match(result.error.message, /HTTP 404/);
});

test('a 400 about our own request is not a missing model either', async () => {
  const { client } = recording(() => ({ status: 400, body: JSON.stringify({ error: 'model is required' }) }));
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(expectFailure(result).code, 'ollama_bad_response');
});

test('a refused connection says how to start one', async () => {
  const { client } = recording(() => {
    throw fetchFailure('ECONNREFUSED');
  });
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.ok(result.error instanceof OllamaUnreachableError);
  assert.equal(result.code, 'ollama_unreachable');
  assert.equal(result.error.syscall, 'ECONNREFUSED');
  assert.match(result.error.message, /ollama serve/);
});

test('DNS and reset failures are unreachable too', async () => {
  for (const syscall of ['ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH']) {
    const { client } = recording(() => {
      throw fetchFailure(syscall);
    });
    const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
    assert.equal(expectFailure(result).code, 'ollama_unreachable', syscall);
  }
});

test('an aborted request is a timeout, and it carries the budget', async () => {
  // This is the shape a real `fetch` produces when `AbortSignal.timeout` fires.
  const { client } = recording(() => {
    throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  });
  const result = await narrate({
    config: config({ timeoutMs: 4_321 }),
    client,
    text: SPAN,
    tokens: ABOVE_FLOOR,
  });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.ok(result.error instanceof OllamaTimeoutError);
  assert.equal(result.code, 'ollama_timeout');
  assert.equal(result.error.timeoutMs, 4_321);
  assert.match(result.error.message, /4321ms/);
});

test('an unclassifiable throw is not reported as unreachable', async () => {
  // Mapping "I do not know" onto `ollama_unreachable` tells the operator to restart
  // a server that is already running.
  const { client } = recording(() => {
    throw new Error('something else entirely');
  });
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.ok(result.error instanceof OllamaTransportError);
  assert.equal(result.code, 'ollama_transport_error');
});

test('a non-Error throw is classified rather than rethrown raw', async () => {
  const { client } = recording(() => {
    // Throwing a non-Error IS the behaviour under test: a hostile transport
    // must be classified, not allowed to crash the request path.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 'a bare string';
  });
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.equal(result.code, 'ollama_transport_error');
  assert.match(result.error.message, /a bare string/);
});

test('a typed error from the transport is passed through, not re-wrapped', async () => {
  const { client } = recording(() => {
    throw new OllamaTimeoutError('http://127.0.0.1:11434', 1);
  });
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(expectFailure(result).code, 'ollama_timeout');
  assert.equal((failureOf(result) as OllamaTimeoutError).timeoutMs, 1);
});

test('a 500 is a bad response and keeps the bounded detail', async () => {
  const { client } = recording(() => ({
    status: 500,
    body: JSON.stringify({ error: 'CUDA out of memory' }),
  }));
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.ok(result.error instanceof OllamaBadResponseError);
  assert.match(result.error.message, /CUDA out of memory/);
});

test('a 200 whose body is not JSON is a bad response, not a crash', async () => {
  const { client } = recording(() => ({ status: 200, body: '<html>proxy error</html>' }));
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.equal(result.code, 'ollama_bad_response');
});

test('every code is reachable and distinct', () => {
  const codes = [
    new OllamaUnreachableError('u', null),
    new OllamaModelNotFoundError('u', 'm'),
    new OllamaTimeoutError('u', 1),
    new OllamaBadResponseError('u', 500, 'x'),
    new OllamaTransportError('u', 'x'),
    new OllamaNotLoopbackError('u'),
  ].map((e) => e.code);
  assert.equal(new Set(codes).size, codes.length, 'two failures share one code');
  for (const error of codes) assert.ok(error.length > 0);
  // Each one names the thing an operator acts on.
  assert.match(new OllamaUnreachableError('u', 'ECONNREFUSED').message, /ollama serve/);
  assert.match(new OllamaModelNotFoundError('u', 'm').message, /ollama pull m/);
  assert.match(new OllamaTimeoutError('u', 5).message, /pre-warm/);
});

/* -------------------------------------------------------------------------- */
/* Fail-open                                                                    */
/* -------------------------------------------------------------------------- */

test('a failure contributes nothing and reports that it failed open', async () => {
  // N5: the narration fields are the only thing this stage can contribute, so
  // failing open means contributing none and leaving the turn alone.
  const { client } = recording(() => {
    throw fetchFailure('ECONNREFUSED');
  });
  const result = await narrate({
    config: config(),
    client,
    text: SPAN,
    tokens: ABOVE_FLOOR,
    governance: [CONSTRAINT],
  });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.equal(result.failedOpen, true);
  assert.equal(result.narrative, null);
  assert.equal(result.usable, false);
});

test('narrate never rejects, whatever the transport does', async () => {
  const bodies: readonly ((request: OllamaHttpRequest) => Reply)[] = [
    () => {
      throw fetchFailure('ECONNREFUSED');
    },
    () => {
      // See above: a non-Error throw is the input being tested.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: 'WEIRD' };
    },
    () => ({ status: 500, body: '' }),
    () => ({ status: 200, body: 'not json at all' }),
    () => ({ status: 200, body: JSON.stringify({ message: {} }) }),
  ];
  for (const answer of bodies) {
    const { client } = recording(answer);
    const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
    assert.equal(result.status, 'failed');
    assert.equal(failureOf(result) instanceof OllamaError, true);
  }
});

test('a failed narration leaves the input span exactly as it was', async () => {
  const { client } = recording(() => {
    throw fetchFailure('ECONNREFUSED');
  });
  const input = Object.freeze({
    config: config(),
    client,
    text: SPAN,
    tokens: ABOVE_FLOOR,
    governance: Object.freeze([CONSTRAINT]),
  });
  const before = JSON.stringify({ text: input.text, governance: input.governance });
  await narrate(input);
  assert.equal(JSON.stringify({ text: input.text, governance: input.governance }), before);
});

test('a server that quotes the request back cannot put the transcript in the error', async () => {
  // The one realistic leak left: `message` is what gets logged, and both ends of
  // this socket are outside the package. A bounded excerpt of the transcript is
  // still the transcript.
  const { client } = recording(() => ({
    status: 500,
    body: JSON.stringify({ error: `cannot handle: ${SPAN}` }),
  }));
  const result = await narrate({
    config: config(),
    client,
    text: SPAN,
    tokens: ABOVE_FLOOR,
    governance: [CONSTRAINT],
  });
  const failure = failureOf(result);
  assert.ok(failure !== null);
  assert.match(failure.message, /HTTP 500/, 'and the diagnosis survives redaction');
  for (let i = 0; i + 24 <= SPAN.length; i += 1) {
    assert.ok(
      !failure.message.includes(SPAN.slice(i, i + 24)),
      'no 24-character run of the transcript survives',
    );
  }
});

test('a model that quotes the prompt back cannot put it in the error either', async () => {
  const { client } = recording(() => chatReply(`I was asked to summarise: ${SPAN}`));
  const result = await narrate({
    config: config(),
    client,
    text: `${SPAN} ${CONSTRAINT}`,
    tokens: ABOVE_FLOOR,
    governance: [CONSTRAINT],
  });
  const failure = failureOf(result);
  assert.ok(failure !== null);
  assert.ok(!failure.message.includes(CONSTRAINT), 'the constraint was never sent, so it cannot come back');
  for (let i = 0; i + 24 <= SPAN.length; i += 1) {
    assert.ok(!failure.message.includes(SPAN.slice(i, i + 24)));
  }
});

test('a normal error detail is left exactly as it was', () => {
  const original = new OllamaBadResponseError('http://127.0.0.1:11434', 500, 'CUDA out of memory');
  assert.equal(original.redact('an unrelated transcript'), original, 'no copy when nothing overlaps');
  assert.equal(original.detail, 'CUDA out of memory');
});

test('the digest on a success is of the text that actually left', async () => {
  const { client } = recording(() => chatReply('{"goal":"g"}'));
  const result = await narrate({
    config: config(),
    client,
    text: `${SPAN} ${CONSTRAINT}`,
    tokens: ABOVE_FLOOR,
    governance: [CONSTRAINT],
  });
  assert.equal(result.status, 'narrated');
  if (result.status !== 'narrated') return;
  assert.equal(result.promptChars, stripGovernanceText(`${SPAN} ${CONSTRAINT}`, [CONSTRAINT]).length);
  assert.notEqual(result.promptDigest, '');
  assert.ok(result.promptDigest.length === 64);
});

/* -------------------------------------------------------------------------- */
/* Client injection                                                             */
/* -------------------------------------------------------------------------- */

test('the transport is the only I/O surface', async () => {
  const { client, calls } = recording(() => chatReply('{"goal":"g"}'));
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'narrated');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.ok(calls[0]?.signal instanceof AbortSignal);
});

test('narration runs with no global fetch at all', async () => {
  // The tripwire for the injected-transport rule: replacing the global proves this
  // module never reaches for one. Restored in `finally` so a failure cannot leak it
  // into another test.
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (() => {
      throw new Error('a global fetch call would be a test failure, not a feature');
    }) as typeof globalThis.fetch;
    const { client, calls } = recording(() => chatReply('{"goal":"g"}'));
    const narrated = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
    assert.equal(narrated.status, 'narrated');
    assert.equal(calls.length, 1, 'and the I/O that did happen went through the injection');
    const tagged = recording(() => ({ status: 200, body: JSON.stringify({ models: [{ name: 'm' }] }) }));
    assert.deepEqual([...(await listOllamaModels(config(), tagged.client))], ['m']);
  } finally {
    globalThis.fetch = original;
  }
});

test('ollamaClientFromFetch adapts a fetch-shaped function', async () => {
  const seen: { url: string; init: Record<string, unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch-shaped stub
  const client = ollamaClientFromFetch(async (url, init) => {
    seen.push({ url, init: { ...init } });
    return {
      status: 200,
      // eslint-disable-next-line @typescript-eslint/require-await -- Response-shaped
      text: async () => JSON.stringify({ message: { content: '{"goal":"g"}' } }),
    };
  });
  const result = await narrate({ config: config(), client, text: SPAN, tokens: ABOVE_FLOOR });
  assert.equal(result.status, 'narrated');
  assert.equal(seen[0]?.url, `${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
  assert.equal(seen[0]?.init['method'], 'POST');
  assert.equal(typeof seen[0]?.init['body'], 'string');
  assert.ok(seen[0]?.init['signal'] instanceof AbortSignal);
});

test('listOllamaModels reads the installed names and reports the same failures', async () => {
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch-shaped stub
  const client = ollamaClientFromFetch(async () => ({
    status: 200,
    // eslint-disable-next-line @typescript-eslint/require-await -- Response-shaped
    text: async () =>
      JSON.stringify({ models: [{ name: 'gemma3:1b' }, { name: 'x:y' }, { size: 1 }] }),
  }));
  assert.deepEqual([...(await listOllamaModels(config(), client))], ['gemma3:1b', 'x:y']);
  const unreachable = ollamaClientFromFetch(() => {
    throw fetchFailure('ECONNREFUSED');
  });
  await assert.rejects(
    () => listOllamaModels(config(), unreachable),
    OllamaUnreachableError,
  );
});

/* -------------------------------------------------------------------------- */
/* Live smoke test: opt-in, and skips cleanly when Ollama is not there          */
/* -------------------------------------------------------------------------- */

const LIVE = process.env['STRATA_OLLAMA_LIVE'] === '1';

/** Enough turns to be a span and few enough that a 1B model keeps up with it. */
const LIVE_SPAN =
  'turn 1: read uploader.ts and listUploads. turn 2: found an N+1 on (tenant_id, ' +
  'created_at) and added the index. turn 3: npm test passes, 214 tests. still open: ' +
  'backfilling the existing rows, and whether the bench at 100k rows still holds.';

/** Bounded because every candidate costs a load, and a load is seconds. */
const LIVE_MODEL_CANDIDATES = 3;

test(
  'a real narration against a real Ollama',
  { skip: LIVE ? false : 'set STRATA_OLLAMA_LIVE=1 to run against a local Ollama' },
  async (t) => {
    // Opt-in, so the default run is hermetic and CI never depends on it. Verified
    // live against Ollama 0.14.1 with gemma3:1b while this was written. A machine
    // without Ollama must skip rather than fail, because "no local model installed"
    // is a fact about the machine and not about this adapter.
    const baseUrl = process.env['STRATA_OLLAMA_LIVE_BASE'] ?? DEFAULT_OLLAMA_BASE_URL;
    const client = ollamaClientFromFetch(fetch);

    let installed: readonly string[];
    try {
      installed = await listOllamaModels(config({ baseUrl }), client);
    } catch (err) {
      t.skip(`no Ollama at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (installed.length === 0) {
      t.skip(`Ollama at ${baseUrl} has no models installed`);
      return;
    }

    // `/api/tags` lists embedding models too, and they sort first: on the machine
    // this was written on, `installed[0]` was `nomic-embed-text`, which answers
    // `/api/chat` with `does not support chat`. Only the call reveals that, so try
    // the installed models in order and let Ollama pick.
    const preferred = process.env['STRATA_OLLAMA_LIVE_MODEL'];
    const candidates =
      preferred === undefined ? installed.slice(0, LIVE_MODEL_CANDIDATES) : [preferred];

    const refusals: string[] = [];
    for (const model of candidates) {
      const result = await narrate({
        config: config({ baseUrl, model }),
        client,
        text: LIVE_SPAN,
        tokens: ABOVE_FLOOR,
      });
      if (result.status === 'failed') {
        refusals.push(`${model}: ${result.error.message}`);
        continue;
      }
      // `skipped` is not success. It means the gate declined, so falling through
      // to the assertions below would read `usable: false` as a passing live
      // narration -- a test that reports green because nothing happened.
      if (result.status === 'skipped') {
        refusals.push(`${model}: skipped (${result.reason})`);
        continue;
      }
      assert.equal(result.model, model);
      assert.equal(result.promptChars > 0, true);
      // A 1B model is under no obligation to be complete. The contract is that what
      // comes back is usable and that nothing about the real call threw.
      assert.equal(
        result.usable,
        true,
        `${model} returned no goal; defects: ${JSON.stringify(result.defects)}`,
      );
      return;
    }
    t.skip(`no installed model could be prompted -- ${refusals.join(' | ')}`);
  },
);