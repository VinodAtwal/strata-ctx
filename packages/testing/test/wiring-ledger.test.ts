/**
 * The wiring ledger gate.
 *
 * docs/wiring-ledger.md carries the rationale and the caveats. In short: between
 * 49b93cb and 0243679 this repo fixed five defects -- two B-3 pointer-ization
 * defects, two gist `raw_uri` producers, and the H-6 identity bug -- that a green
 * suite could not see, because every one of them lived in a subsystem no
 * production path executes. A unit test calls the operator directly, so
 * "implemented and tested" reads exactly like "working". These declarations turn
 * that into a property the runner checks.
 *
 * ## What is declared here, and what is derived
 *
 * Derived, in `../src/wiring-ledger.ts`: the inventory (every exported runtime
 * value in every package, walked out of the barrels), the module graph, and
 * whether each symbol has a caller. Declared here: only the *exceptions*, each
 * with the reason it is an exception. A hand-maintained inventory would be the
 * same drift being fixed -- it would rot silently and still read as
 * authoritative -- so there isn't one.
 *
 * Three declaration kinds, and the gate fails in both directions for each:
 * a symbol that became wired while still declared, and a symbol that became
 * unwired while not declared. A reason that stops being true should stop the
 * build, not sit there looking current.
 */

import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  blankNonCode,
  buildLedger,
  findLiteralProducers,
  findRepoRoot,
  isTestPath,
  referenceSites,
  type ProductionFile,
} from '../src/wiring-ledger.js';

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ *
 * Declaration 1 -- packages no entry root can reach.
 *
 * One reason per package, and every export of a declared package is unwired by
 * inheritance. The count is asserted too: without it, adding a new operator to
 * a package nobody can reach would pass this gate silently, which is the exact
 * failure mode this file exists to make loud.
 * ------------------------------------------------------------------ */

interface UnreachablePackage {
  readonly why: string;
  /** Exported runtime values, as of 49b93cb. */
  readonly exports: number;
}

const UNREACHABLE_PACKAGES: Readonly<Record<string, UnreachablePackage>> = {
  canary: {
    why: 'F1-11 probes, but no reachable module imports @strata-ctx/canary; nothing fires them',
    exports: 28,
  },
  eval: {
    why: 'offline harness; its only importer is @strata-ctx/eval-live, which is itself unreachable',
    exports: 343,
  },
  'eval-live': {
    why: 'F2-1..F2-3 are externally blocked, so no reachable module imports @strata-ctx/eval-live',
    exports: 29,
  },
  gist: {
    why: 'no package depends on @strata-ctx/gist, so eviction and recovery cannot run',
    exports: 6,
  },
  governance: {
    why: 'no package depends on @strata-ctx/governance; the gateway pins with its own code path',
    exports: 36,
  },
  'output-compress': {
    why: 'no package depends on @strata-ctx/output-compress, so applyOutputCompression never runs',
    exports: 60,
  },
  testing: {
    why: 'the record/replay harness has no consumer at all, not even a test suite',
    exports: 50,
  },
};

/* ------------------------------------------------------------------ *
 * Declaration 2 -- exported operators inside a reachable package that
 * nothing in a reachable module calls.
 *
 * Every one of these has exactly one application site: its own declaration. A
 * barrel re-export is not a caller (that is the whole reason `CONFIG_PROVIDERS`
 * is on this list), a mention in prose is not a caller, and a test file is not
 * a caller by construction.
 * ------------------------------------------------------------------ */

const UNWIRED_OPERATORS: Readonly<Record<string, string>> = {
  // --- @strata-ctx/core-types: frozen contract surface, AGENTS.md §1 ---
  'core-types/DEFAULT_POLICY': 'policy.ts:151; every reachable caller carries its own policy object instead',
  'core-types/artifactId': 'ids.ts:27; artifact refs are built as object literals at pointer.ts:239',
  'core-types/assertNoGovernance':
    'guards.ts:132; the runtime guard against governance reaching a lossy stage runs only from the D-9 property suite',
  'core-types/blockBytes': 'context.ts:106; callers read meta.bytes directly (estimateBlockTokens, tokens.ts)',
  'core-types/blockId': 'ids.ts:25; runId/taskId/probeId are used, blockId is not',
  'core-types/constraintId': 'ids.ts:29; policy.ts builds ConstraintId through the zod schema',
  'core-types/gistId': 'ids.ts:26; gist packages are unreachable, so nothing mints one',
  'core-types/hashCanonical': 'hash.ts:20; sha256 is called with the already-serialised string at every call site',
  'core-types/isCacheable': 'context.ts:111; the cache-prefix stage reads meta.tier itself',
  'core-types/nonEmpty': 'ids.ts:32; exported as a boundary wrapper, never applied to an id factory',
  'core-types/turnId': 'ids.ts:23; the gateway carries its own run/turn ids as plain strings',

  // --- @strata-ctx/gateway ---
  'gateway/ANTHROPIC_ADAPTER': 'routing.ts; resolveAdapter builds the table inline, so the constant is unused',
  'gateway/CONFIG_PROVIDERS':
    'index.ts:48 renames config.PROVIDERS; nothing imports the renamed name (AGENTS.md §10 documents the rename, not a use)',
  'gateway/ConfigWatcher': 'config.ts:494; reloadConfig reads the file per request instead of subscribing',
  'gateway/DEFAULT_PROVIDER': 'token-estimator.ts:87; routing.ts:defaultRoute carries its own default',
  'gateway/GEMINI_ADAPTER': 'routing.ts; see ANTHROPIC_ADAPTER',
  'gateway/MockTokenEstimator': 'token-estimator.ts:290; the mock upstream reports usage instead',
  'gateway/OPENAI_COMPAT_ADAPTER': 'routing.ts; see ANTHROPIC_ADAPTER',
  'gateway/TOKEN_PROVIDERS': 'token-estimator.ts:73; AGENTS.md §10 documents it as a constant with no reader',
  'gateway/applyCredentialsStrict': 'credentials.ts:291; server.ts uses applyCredentials',
  'gateway/describeCredential': 'credentials.ts:110; no status surface prints it',
  'gateway/geminiAdapter.readGeminiResponseMetadata': 'gemini-adapter.ts:662; metadata is read from the parsed body inline',
  'gateway/geminiAdapter.safeFromCanonical': 'gemini-adapter.ts:602; the adapter resolves through resolveAdapter',
  'gateway/geminiAdapter.safeToCanonical': 'gemini-adapter.ts:593; as safeFromCanonical',
  'gateway/ollamaAdapter.enabledNarrationConfig': 'ollama-adapter.ts:292; B-9 narration is externally blocked',
  'gateway/ollamaAdapter.listOllamaModels': 'ollama-adapter.ts:1563; no reachable module queries the model list',
  'gateway/ollamaAdapter.resolveNarrationConfig': 'ollama-adapter.ts:383; as enabledNarrationConfig',
  'gateway/openaiCompatAdapter.OPENAI_COMPAT_SSE_DONE': 'openai-compat-adapter.ts:213; sse.ts owns stream completion',
  'gateway/openaiCompatAdapter.isOpenAiCompatStreamDone': 'openai-compat-adapter.ts:223; as OPENAI_COMPAT_SSE_DONE',
  'gateway/openaiCompatAdapter.unpairedToolResultIds': 'openai-compat-adapter.ts:558; no reachable module audits pairing',
  'gateway/redactHeaders': 'credentials.ts:87; server.ts builds the redacted header map itself',
  'gateway/resolveCredential': 'credentials.ts:206; applyCredentials resolves inline',
  'gateway/validateConfig':
    'config.ts:399; named in prose at config.ts:10 and exported at index.ts:44, but safeParseConfig/parseConfig/loadConfig all call resolve() directly',

  // --- @strata-ctx/integrations ---
  'integrations/ClaudeCodeProxyHooks': 'index.ts:130 renames ClaudeCodeHooks; nothing imports the renamed name',
  'integrations/DEFAULT_RESULT_REWRITE': 'hook-builder.ts:165; the spec carries its own rewrite',
  'integrations/GEMINI_RESULT_REWRITE': 'gemini.ts; the Gemini profile builds its own rewrite',
  'integrations/HOOK_BLOCK_END': 'hook-builder.ts:97; the block markers are inlined at the render sites',
  'integrations/HOOK_BLOCK_START': 'hook-builder.ts:96; as HOOK_BLOCK_END',
  'integrations/MCP_PROTOCOL_VERSION': 'mcp-server.ts; the server negotiates a fixed version string',
  'integrations/NOTE_SOURCE_VALUES': 'mcp-server.ts:550; note sources are validated at the call site',
  'integrations/OPENCODE_CONFIG_SCHEMA': 'opencode.ts; the JSON schema is rendered inline',
  'integrations/OPENCODE_HOOKS_KEY': 'opencode.ts; the hooks object is keyed literally in the profile',
  'integrations/OPENCODE_HOOK_COMMAND_KEY': 'opencode.ts; as OPENCODE_HOOKS_KEY',
  'integrations/OPENCODE_HOOK_EVENT_KEY': 'opencode.ts; as OPENCODE_HOOKS_KEY',
  'integrations/OPENCODE_NOTICE': 'opencode.ts; the notice text is inlined in the profile document',
  'integrations/OPENCODE_PROVIDER_NPM': 'opencode.ts; the npm id is written literally',
  'integrations/OPENCODE_RESULT_REWRITE': 'opencode.ts; as OPENCODE_HOOKS_KEY',
  'integrations/OPENCODE_SURFACE': 'opencode.ts; the surface table is read by buildOpenCodeProfile directly',
  'integrations/SERVER_NAME': 'mcp-server.ts; the stdio server hardcodes its name',
  'integrations/SERVER_VERSION': 'mcp-server.ts; as SERVER_NAME',
  'integrations/TOOL_NAMES': 'mcp-server.ts:1096; mcp-server.ts:1105 mentions it in a type, and no reachable module calls it',
  'integrations/appendUserIntent': 'claude-code-observers.ts; the PreCompact observer appends inline',
  'integrations/assembleGist': 'claude-code-observers.ts:400; buildGistDraft inlines the assembly',
  'integrations/buildOpenCodeProfile':
    'opencode.ts:775; cli/src/index.ts only prints the name in a hint string (index.ts:341) instead of calling it',
  'integrations/compareOpenCodeToCopilot': 'opencode.ts:323; rankGuarantee is compared inline',
  'integrations/constraintsFromPolicy': 'claude-code-hooks.ts:322; the hooks map constraints themselves',
  'integrations/createClaudeCodeProxyHooks': 'index.ts:131 renames createClaudeCodeHooks; nothing imports the renamed name',
  'integrations/createClaudeHookRouter': 'claude-code-observers.ts:928; the CLI drives ClaudeCodeHooks directly',
  'integrations/createGeminiAdapter': 'gemini.ts:234; the profile is consumed as a config document',
  'integrations/createOpenCodePlugin': 'opencode.ts:1152; renderPluginModule emits the source text for it instead',
  'integrations/createPreCompactObserver': 'claude-code-observers.ts:469; the observer factory is never instantiated',
  'integrations/createSessionObserver': 'claude-code-observers.ts:845; as createPreCompactObserver',
  'integrations/createUserPromptSubmitObserver': 'claude-code-observers.ts:652; as createPreCompactObserver',
  'integrations/globalOpenCodePluginPath': 'opencode.ts:1219; no reachable module materialises the plugin',
  'integrations/knownAgents': 'copilot.ts:535; rankGuarantee carries its own agent list',
  'integrations/openCodeAgentId': 'opencode.ts:373; the agent id is written into profiles literally',
  'integrations/renderClaudeMd': 'templates.ts:650; no reachable module writes a CLAUDE.md',
  'integrations/renderPluginModule':
    'opencode.ts:1181; named inside a generated string at opencode.ts:1205, which is a string, not a caller',
  'integrations/verifyGistGovernance': 'claude-code-observers.ts:426; the PreCompact path does not verify',

  // --- @strata-ctx/pipeline ---
  'pipeline/LAST_STAGE': 'order.ts:68; stage count is asserted against STAGE_ORDER.length',
  'pipeline/SEVERITY_ORDER': 'severity.ts:45; ranking is by the numeric severity, not the order table',
  'pipeline/STRATA_MARKER_PREFIX': 'severity.ts:33; marker detection matches the full literal',
  'pipeline/TUNNEL_AFTER_TIER0': 'order.ts:67; runTier0 hardcodes the tunnel stages',
  'pipeline/classifyBlockSeverity': 'severity.ts:192; named in prose at severity.ts:178, never called',
  'pipeline/classifyBlockText': 'severity.ts:180; applySeverityClassification holds the logic inline',
  'pipeline/compactableFrom': 'recency.ts:130; the tunnelling loop computes the window itself',
  'pipeline/createSelfGistScanner': 'self-gist.ts:633; no reachable module builds a self-gist scanner',
  'pipeline/diffCachePrefix': 'cache-prefix.ts:196; A-13 is unfinished, so nothing diffs a prefix',
  'pipeline/isTailProtected': 'recency.ts:118; the protection check is inlined in recencyTail',
  'pipeline/recencyTail': 'recency.ts:58; no reachable module reads a recency tail',
  'pipeline/retainTail': 'self-gist.ts:487; no reachable module retains a tail',
  'pipeline/runPipeline':
    'runner.ts:201; the gateway calls runTier0 (order.ts:211) at server.ts:448, so the seven-stage runner never runs',
  'pipeline/shouldSelfGist': 'self-gist.ts:965; no reachable module asks whether to self-gist',
  'pipeline/triggerFor': 'trigger.ts:160; the trigger is decided inline at the call site',

  // --- @strata-ctx/security ---
  'security/DEFAULT_REDACTION_OPTIONS': 'redact.ts:113; optionsFromPolicy builds options from the policy',
  'security/LOCALITY_STATEMENT': 'locality.ts:519; the statement text is inlined in the report',
  'security/PURGE_PATH': 'purge.ts:63; the purge route is matched literally',
  'security/assertGistTrustworthy': 'gist-safety.ts:375; the gateway never asserts gist trust',
  'security/assertLocalPackage': 'locality.ts:453; the locality gate runs from its own test only',
  'security/assertLocalSource': 'locality.ts:423; as assertLocalPackage',
  'security/bucketForKind': 'store.ts:813; ArtifactStore picks the bucket from the ref itself',
  'security/gistArtifactUris': 'gist-safety.ts:204; defendGist extracts the URIs inline',
  'security/handlePurgeRequest': 'purge.ts:242; no reachable module serves a purge request',
  'security/isRetainWorthyAction': 'retention.ts:314; runGc and planGc share the isRetainWorthy table directly',
  'security/isWellFormedDigest': 'acl.ts:431; the store validates the digest inline',
  'security/rankOf': 'redact.ts:67; ranking is compared by the Confidence order literal',
  'security/runGc': 'retention.ts:307; no reachable module runs a collection',
  'security/scanPackage': 'locality.ts:493; as assertLocalPackage',
  'security/scanSecrets': 'redact.ts:468; redactDeep and RedactionEngine call the scanners internally',

  // --- @strata-ctx/telemetry ---
  'telemetry/GIST_INVARIANTS': 'events.ts:386; the gist package that would assert them is unreachable',
  'telemetry/GuardedSink': 'sink.ts:238; no reachable module constructs a sink, so none is wrapped',
  'telemetry/JsonlSink': 'sink.ts:296; the status CLI parses the log with nothing but node:fs (cli/src/index.ts:266)',
  'telemetry/PRICING_TABLE': 'pricing.ts:222; lookupPricing is the only reader and it is itself uncalled',
  'telemetry/TOKEN_CATEGORIES': 'savings.ts:94; the gate compares against the arms literally',
  'telemetry/TeeSink': 'sink.ts:196; as GuardedSink',
  'telemetry/addDays': 'pricing.ts:105; pricing windows are computed with Date arithmetic inline',
  'telemetry/analyseCost': 'cost.ts:215; costEvent builds the analysis inline',
  'telemetry/assertPricingTable': 'pricing.ts:265; only the pricing tests call it',
  'telemetry/breakevenView': 'cost.ts:272; formatStatus reports net-vs-gross from its own fields',
  'telemetry/costEvent': 'cost.ts:286; no reachable module emits a cost event',
  'telemetry/crossoverSessionLength': 'savings.ts:310; the net-savings gate reads the arms directly',
  'telemetry/emitCompaction': 'events.ts:398; no reachable module emits a compaction event',
  'telemetry/groupByRun': 'sink.ts:582; no reachable module groups a run',
  'telemetry/isPricingStale': 'pricing.ts:179; only lookupPricing would consult it, and that is uncalled too',
  'telemetry/lookupPricing': 'pricing.ts:192; no reachable module prices a run',
  'telemetry/readJsonlEvents': 'sink.ts:577; the status CLI reads the log with readFileSync (cli/src/index.ts:264)',
  'telemetry/redactEvent': 'redact.ts:421; the hook sinks redact with redactDeep instead',
  'telemetry/runStatusCli':
    'status.ts:708; cli/src/index.ts:266 re-implements the count in node:fs so it works outside the workspace',
};

/* ------------------------------------------------------------------ *
 * Declaration 3 -- operators the ledger calls wired that cannot execute.
 *
 * This is the class the ledger structurally cannot see. `pointerizeBlocks` has
 * a call site in a reachable module, so it reads as wired; the gate it sits
 * behind is never satisfied, so it never runs. Each entry therefore names the
 * *condition* whose absence makes the operator inert, and the gate asserts that
 * no reachable source produces that condition yet.
 * ------------------------------------------------------------------ */

interface DeadGate {
  readonly id: string;
  readonly operators: readonly string[];
  /** A production construct that, if it appeared, would open the gate. */
  readonly producer: RegExp;
  readonly why: string;
}

const DEAD_GATES: readonly DeadGate[] = [
  {
    id: 'B-3-file-subject',
    operators: ['pipeline/pointerizeBlocks', 'pipeline/isFileRead'],
    // pointer.ts:73 is `subject.kind === 'file'`; the adapters assign 'other'.
    producer: /kind:\s*'file'/,
    why:
      "isFileRead (pointer.ts:73) requires meta.subject.kind === 'file' and no adapter in a reachable module assigns it: anthropic-adapter.ts, gemini-adapter.ts and openai-compat-adapter.ts all assign 'other'. pointerizeBlocks is called at truncate.ts:326 and skips every block.",
  },
];

/* ------------------------------------------------------------------ *
 * The ledger
 * ------------------------------------------------------------------ */

const ledger = buildLedger(ROOT);
const reachableFiles = new Set(ledger.reachableFiles);

const describe = (e: { package: string; name: string; declaredIn: string }): string =>
  `${e.package}/${e.name} (declared ${e.declaredIn})`;

/* ------------------------------------------------------------------ *
 * Gate 1 -- an unwired operator must be declared.
 * ------------------------------------------------------------------ */

test('every unwired operator is declared, with a reason', () => {
  const undeclared = ledger.locallyUnwired
    .map(describe)
    .filter((entry) => !(entry in UNWIRED_OPERATORS) && !(stripDeclared(entry) in UNWIRED_OPERATORS));

  assert.deepEqual(
    undeclared,
    [],
    `unwired operators with no declaration. Each is implemented, exported and unit-tested but called by nothing reachable, which is how the B-3, gist and H defects survived a green suite (docs/wiring-ledger.md).\n  add one line to UNWIRED_OPERATORS naming why nothing calls it, or wire it.`,
  );
});

test('every declaration still describes a symbol the ledger found', () => {
  const known = new Set(ledger.entries.map((e) => `${e.package}/${e.name}`));
  const ghosts = Object.keys(UNWIRED_OPERATORS).filter((key) => !known.has(key));
  assert.deepEqual(ghosts, [], 'UNWIRED_OPERATORS names symbols that no longer exist; delete the stale lines');
});

test('a declaration that stopped being true fails the build', () => {
  // The other half of the gate. A declared-unwired operator that has acquired a
  // caller is the gap closing, and the reason on its line is now false; leaving
  // it in place is how a ledger starts lying.
  const stale = ledger.wired.map(describe).filter((entry) => entry in UNWIRED_OPERATORS);
  assert.deepEqual(
    stale,
    [],
    'these operators are declared unwired but now have a reachable caller. Delete the declaration -- it is no longer true.',
  );
});

test('every declaration has a non-empty reason', () => {
  for (const [key, reason] of Object.entries(UNWIRED_OPERATORS)) {
    assert.ok(reason.trim().length > 20, `${key} needs a reason specific enough to notice when it goes stale`);
  }
});

/* ------------------------------------------------------------------ *
 * Gate 2 -- an unreachable package must be declared, with its size.
 * ------------------------------------------------------------------ */

test('every unreachable package is declared, with its export count', () => {
  const derived = new Map<string, number>();
  for (const entry of ledger.inheritedUnwired) derived.set(entry.package, (derived.get(entry.package) ?? 0) + 1);

  const undeclared = [...derived.keys()].filter((name) => !(name in UNREACHABLE_PACKAGES)).sort();
  assert.deepEqual(
    undeclared,
    [],
    'packages no entry root can reach. Nothing in them can run, so every export is unwired by inheritance -- declare the package and its export count.',
  );

  const drifted = [...derived.entries()]
    .filter(([name, count]) => declaredCount(name) !== count)
    .map(([name, count]) => `${name}: declared ${declaredCount(name)}, found ${count}`);
  assert.deepEqual(
    drifted,
    [],
    'an unreachable package gained or lost exports. Wire it, or bump the declared count and say in the reason why the new one is unreachable too.',
  );
});

test('a declared unreachable package that became reachable fails the build', () => {
  const revived = Object.keys(UNREACHABLE_PACKAGES)
    .filter((name) => ledger.packages.find((p) => p.name === name)?.reachable === true)
    .sort();
  assert.deepEqual(
    revived,
    [],
    'these packages are declared unreachable but an entry root reaches them now. Delete the declaration and re-check the per-operator list.',
  );
});

test('a declared unreachable package that no longer exists fails the build', () => {
  const present = new Set(ledger.packages.map((p) => p.name));
  const gone = Object.keys(UNREACHABLE_PACKAGES).filter((name) => !present.has(name));
  assert.deepEqual(gone, [], 'UNREACHABLE_PACKAGES names packages that are not in the workspace any more');
});

/* ------------------------------------------------------------------ *
 * Gate 3 -- a wired operator whose precondition is unsatisfiable.
 * ------------------------------------------------------------------ */

test('a declared dead gate is still dead', () => {
  const opened: string[] = [];
  for (const gate of DEAD_GATES) {
    // Reachable files only: a producer in a module nothing can import does not
    // open the gate, and B-3's operator still cannot run.
    for (const hit of findLiteralProducers(
      ledger.files.filter((f) => reachableFiles.has(f.rel)),
      gate.producer,
    )) {
      opened.push(`${gate.id}: ${hit.file}:${hit.line} now produces it`);
    }
  }
  assert.deepEqual(
    opened,
    [],
    'a condition these operators are gated on now exists in a reachable module. The operators are no longer inert: drop the DEAD_GATES entry and let the ordinary wiring checks speak for them.',
  );
});

test('a dead gate names operators the ledger calls wired', () => {
  // If the ledger ever reports one of these unwired, the ordinary gate covers it
  // and this declaration is redundant rather than wrong -- but it should be
  // removed, because two mechanisms claiming the same gap is how one goes stale.
  for (const gate of DEAD_GATES) {
    for (const name of gate.operators) {
      const entry = ledger.entries.find((e) => `${e.package}/${e.name}` === name);
      assert.ok(entry !== undefined, `${gate.id} names ${name}, which is not in the inventory`);
      assert.ok(
        entry.wired,
        `${gate.id} names ${name}, which the ledger now reports unwired; drop the gate and let UNWIRED_OPERATORS carry it`,
      );
      assert.ok(gate.why.trim().length > 40, `${gate.id} needs to say what closes the gate`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The ledger is not vacuous, and it is not a rubber stamp.
 *
 * A gate that passes because everything is declared unwired, or because the
 * detector cannot see anything, is worse than no gate (AGENTS.md §10, trap 1).
 * ------------------------------------------------------------------ */

test('the detector finds callers: known production call sites are reported wired', () => {
  const expected: readonly [string, string][] = [
    // gateway/src/server.ts:448 -- the Tier 0 entry point on the request path
    ['pipeline/runTier0', 'packages/pipeline/src/order.ts:211'],
    // gateway/src/server.ts:46 -- the only thing that starts the gateway
    ['gateway/createGateway', 'packages/gateway/src/server.ts'],
    // gateway/src/server.ts:15 -- the artifact store on the durability path
    ['security/ArtifactStore', 'packages/security/src/store.ts'],
    // pipeline/src/truncate.ts:326 -- the call that makes B-3 look wired
    ['pipeline/pointerizeBlocks', 'packages/pipeline/src/truncate.ts:326'],
    // integrations/src/opencode.ts imports the security scanner
    ['security/scanDestructive', 'packages/security/src/destructive.ts'],
  ];
  const wrong = expected
    .filter(([name]) => ledger.entries.find((e) => `${e.package}/${e.name}` === name)?.wired !== true)
    .map(([name, where]) => `${name} should be wired (caller at ${where})`);
  assert.deepEqual(wrong, []);
});

test('the detector sees the majority of the surface as wired', () => {
  // A regression guard on the detector itself: if the identifier search stops
  // working, `unwired` grows to nearly everything and every declaration becomes
  // a lie at once. This number moves only when real wiring is removed.
  const wiredShare = ledger.wired.length / ledger.entries.length;
  assert.ok(wiredShare > 0.35, `only ${(wiredShare * 100).toFixed(1)}% of exports have a caller; the detector looks broken`);
  assert.ok(ledger.entries.length > 900, `inventory collapsed to ${ledger.entries.length} entries; the barrel walk is broken`);
});

/* ------------------------------------------------------------------ *
 * The exclusions, asserted individually.
 *
 * Requirement: state exactly how tests and dist/ are excluded, because an
 * exclusion that is too loose makes everything look wired. These run against
 * synthetic sources so the rule is checked directly, and the assertions at the
 * bottom re-check it against the real tree.
 * ------------------------------------------------------------------ */

const synthetic = (rel: string, source: string): ProductionFile => {
  const { code, noComments } = blankNonCode(source);
  return { path: `${ROOT}/${rel}`, rel, module: 'synthetic', code, noComments };
};

const file = synthetic('packages/synthetic/src/thing.ts', 'export const thing = 1;\n');
const declaredIn = new Set([file.path]);
const callers = (name: string, ...extra: ProductionFile[]): string[] =>
  referenceSites([file, ...extra], name, declaredIn)
    .filter((s) => s.kind === 'call' || s.kind === 'new' || s.kind === 'value' || s.kind === 'import')
    .map((s) => s.file);

test('a mention in a comment is not a caller', () => {
  assert.deepEqual(
    callers('thing', synthetic('packages/synthetic/src/notes.ts', '/** we call thing() here */\n// thing()\n')),
    [],
  );
});

test('a mention in a string is not a caller', () => {
  assert.deepEqual(
    callers(
      'thing',
      synthetic('packages/synthetic/src/note.ts', "const s = 'thing()';\nconst t = `thing()`;\nconst u = /thing\\(\\)/;\n"),
    ),
    [],
  );
});

test('a barrel re-export is not a caller', () => {
  assert.deepEqual(callers('thing', synthetic('packages/synthetic/src/index.ts', "export { thing } from './thing.js';\n")), []);
});

test('a declaration is not a caller', () => {
  assert.deepEqual(callers('thing'), []);
});

test('a member access and a property key are not callers', () => {
  assert.deepEqual(
    callers(
      'thing',
      synthetic('packages/synthetic/src/use.ts', 'a.thing();\nb?.thing();\nconst o = { thing: 1 };\ninterface I { thing: string }\n'),
    ),
    [],
  );
});

test('a type position is not a caller', () => {
  assert.deepEqual(
    callers(
      'thing',
      synthetic('packages/synthetic/src/types.ts', 'const a: typeof thing = 1;\ntype T = keyof typeof thing;\nconst b = 1 as typeof thing;\n'),
    ),
    [],
  );
});

test('a real call is a caller', () => {
  assert.deepEqual(callers('thing', synthetic('packages/synthetic/src/use.ts', 'thing();\nthing(1);\n')), [
    'packages/synthetic/src/use.ts',
    'packages/synthetic/src/use.ts',
  ]);
  assert.deepEqual(callers('thing', synthetic('packages/synthetic/src/use.ts', 'new thing();\n')), [
    'packages/synthetic/src/use.ts',
  ]);
  assert.deepEqual(callers('thing', synthetic('packages/synthetic/src/use.ts', "import { thing } from './thing.js';\nthing();\n")), [
    'packages/synthetic/src/use.ts',
    'packages/synthetic/src/use.ts',
  ]);
});

test('an object shorthand is a value, not a type', () => {
  // `{ run: thing }` and `const x: thing` are lexically identical. Treating the
  // first as a type position reported 99 real callers as unwired; see the note
  // on TYPE_POSITION_RE in ../src/wiring-ledger.ts.
  assert.deepEqual(callers('thing', synthetic('packages/synthetic/src/table.ts', 'const stages = { run: thing };\n')), [
    'packages/synthetic/src/table.ts',
  ]);
});

test('isTestPath excludes the whole test/ directory, not just *.test.ts', () => {
  assert.equal(isTestPath('packages/pipeline/test/pointer.test.ts'), true);
  assert.equal(isTestPath('packages/pipeline/test/fixtures.ts'), true);
  assert.equal(isTestPath('packages/pipeline/src/pointer.ts'), false);
  assert.equal(isTestPath('tools/dev.ts'), false);
});

test('the searched file set contains no test file and no build output', () => {
  const offenders = ledger.files
    .filter((f) => f.rel.includes('/dist/') || f.rel.includes('/node_modules/') || isTestPath(f.rel))
    .map((f) => f.rel);
  assert.deepEqual(offenders, [], 'the caller search must not see compiled output or tests');

  const sources = ledger.files.filter((f) => f.rel.startsWith('packages/')).map((f) => f.module);
  assert.ok(sources.length > 0 && ledger.files.length > 100, 'the file set collapsed');
});

test('a test-only caller does not make an operator look wired, in the real tree', () => {
  // applyOutputCompression is called from
  // packages/output-compress/test/reference.test.ts:319 and nowhere else, and
  // its package is unreachable besides. If tests were searched, this would pass.
  const entry = ledger.entries.find((e) => e.name === 'applyOutputCompression');
  assert.ok(entry !== undefined);
  assert.equal(entry.wired, false);
  assert.equal(entry.confidence, 'none');

  // runPipeline is called from packages/pipeline/test/runner.test.ts only.
  const runner = ledger.entries.find((e) => e.name === 'runPipeline');
  assert.ok(runner !== undefined);
  assert.equal(runner.wired, false);
});

test('a prose mention does not make an operator look wired, in the real tree', () => {
  // validateConfig is named at config.ts:10 and ollama-adapter.ts:362, both
  // comments, and is exported at index.ts:44.
  const entry = ledger.entries.find((e) => e.package === 'gateway' && e.name === 'validateConfig');
  assert.ok(entry !== undefined);
  assert.equal(entry.wired, false);
});

test('a mention inside a generated string is not a caller, in the real tree', () => {
  // renderPluginModule appears inside the plugin source it emits
  // (opencode.ts:1205), which is string data a human will read and grep for.
  const entry = ledger.entries.find((e) => e.package === 'integrations' && e.name === 'renderPluginModule');
  assert.ok(entry !== undefined);
  assert.equal(entry.wired, false);
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function stripDeclared(entry: string): string {
  return entry.replace(/ \([^)]*\)$/, '');
}

function declaredCount(name: string): number | undefined {
  return UNREACHABLE_PACKAGES[name]?.exports;
}