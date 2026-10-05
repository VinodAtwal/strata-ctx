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
 * ## The ruling this file enforces
 *
 * A symbol referenced only inside its own declaring file is called by nothing.
 * The ledger used to count a same-file `value` as a caller, which made 432 of
 * 1089 exports look wired; the honest number is 152. The direction of the error
 * is deliberate and stated in `isCallingSite` and in docs/wiring-ledger.md §6:
 * this ledger prefers to call a live operator unwired and let a human write down
 * why, over calling a dead one wired.
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
  isCallingSite,
  isTestPath,
  referenceSites,
  type ProductionFile,
  type ReferenceSite,
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
    // 343 -> 348 at 1afd8b2, which added the hermetic corpus resolver. Still
    // unreachable for the same reason.
    exports: 348,
  },
  'eval-live': {
    why: 'F2-1..F2-3 are externally blocked, so no reachable module imports @strata-ctx/eval-live',
    // 29 -> 31 at e151617, which added the claims-audit operators, then 31 -> 34
    // at a03dbc3, which added the subtractive arm, then 34 -> 46 at c014270, which
    // added the structured tool-call channel, then 46 -> 35 at 2ea82bb, which
    // audited that channel's barrel and found 11 of the 12 new re-exports used
    // only by their own tests. Publishing them made them things a downstream
    // package could depend on, which is the cost the explicit barrel exists to
    // avoid. Still unreachable for the same reason: an instrument with no
    // credential cannot run. The gate exists to make a change in this number a
    // decision rather than a drift.
    exports: 35,
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
 * Every row here names the whole reason it is allowed to be uncalled. Three
 * things are never a caller, and each was a real way to make this table wrong:
 * a barrel re-export (that is why `CONFIG_PROVIDERS` is here), a mention in
 * prose, and a test file -- by construction, no path under a package's test
 * directory ever enters the searched set.
 *
 * The 264 rows in the second half of this table are what the ruling cost, and
 * they come in three shapes. Each one was checked when it was written rather
 * than asserted, and the checks are in docs/wiring-ledger.md §6:
 *
 * - "no file outside X names it directly -- it runs only through F, which
 *   G:line calls": the operator *does* execute, reached through a same-file
 *   reader that a reachable file really invokes. 109 rows. Naming it is a gap
 *   in how the code is written, not a dead operator.
 * - "the only call sites are in-file, at X:NN, inside F -- no chain of
 *   same-file readers reaches an operator a reachable file calls": genuinely
 *   inert. 152 rows.
 * - "nothing in X calls it": no call site anywhere, only same-file value
 *   reads. 3 rows.
 *
 * The middle two claims need the import binding, not just the name. A reader
 * that shares a name with an export in another package is not a reader:
 * claude-code-hooks.ts:388 calls security's redactText, and
 * gemini-adapter.ts:634 is a `readonly usage:` interface field. Both were
 * reported as live callers by an earlier pass of this analysis and both were
 * wrong; requiring the citing file to import the symbol is what caught them.
 *
 * docs/wiring-ledger.md §5 carries the deferral review for the subsystems
 * these rows fall into: what wiring each one would take, and what would have to
 * be true before that wiring is safe to switch on.
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
  'gateway/applyCredentialsStrict':
    'credentials.ts:291; nothing calls it in any file. Its only in-file call to applyCredentials is credentials.ts:302, and server.ts:301 attaches the api-key header inline without entering this subsystem at all -- see docs/wiring-ledger.md §5',
  'gateway/describeCredential': 'credentials.ts:110; nothing calls it in any file, and no status surface prints a credential',
  'gateway/geminiAdapter.readGeminiResponseMetadata': 'gemini-adapter.ts:662; metadata is read from the parsed body inline',
  'gateway/geminiAdapter.safeFromCanonical': 'gemini-adapter.ts:602; the adapter resolves through resolveAdapter',
  'gateway/geminiAdapter.safeToCanonical': 'gemini-adapter.ts:593; as safeFromCanonical',
  'gateway/ollamaAdapter.enabledNarrationConfig': 'ollama-adapter.ts:292; B-9 narration is externally blocked',
  'gateway/ollamaAdapter.listOllamaModels': 'ollama-adapter.ts:1563; no reachable module queries the model list',
  'gateway/ollamaAdapter.resolveNarrationConfig': 'ollama-adapter.ts:383; as enabledNarrationConfig',
  'gateway/openaiCompatAdapter.OPENAI_COMPAT_SSE_DONE': 'openai-compat-adapter.ts:213; sse.ts owns stream completion',
  'gateway/openaiCompatAdapter.isOpenAiCompatStreamDone': 'openai-compat-adapter.ts:223; as OPENAI_COMPAT_SSE_DONE',
  'gateway/openaiCompatAdapter.unpairedToolResultIds': 'openai-compat-adapter.ts:558; no reachable module audits pairing',
  'gateway/redactHeaders':
    'credentials.ts:87; nothing calls it in any file, so no gateway header is ever redacted by name. server.ts:301 attaches the api-key header inline instead',
  'gateway/resolveCredential':
    'credentials.ts:206; nothing calls it in any file. applyCredentials takes an already-resolved credential and never reaches for one',
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
  'integrations/assembleGist':
    'claude-code-observers.ts:444; the PreCompact observer writes the PreCompactDraft and never assembles one, so the narrative seam has no reachable caller',
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
  // This one was misreported as wired until the name collision was removed. It
  // was called "wired" only because `integrations` exported a *different*
  // function under the same name, and the identifier search cannot tell two
  // packages' symbols apart. Which is the argument for step 3's rename: the
  // collision hid a genuinely dead operator from the gate that exists to name it.
  'pipeline/buildSelfGistDraft':
    'self-gist.ts:851; the only reference outside its own declaration is the doc comment at self-gist.ts:33, and no reachable module builds a self-gist draft -- shouldSelfGist takes one it is handed',
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
  'telemetry/EXPLICIT_UNHANDLED_EVENT_ALLOWLIST':
    'status.ts:312; a declaration table whose only reader is the exhaustiveness test, so it is test support living in src',
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
  // --- @strata-ctx/core-types: exposed by the ruling. Three shapes, see the header above. ---
  'core-types/BudgetPolicySchema': 'policy.ts:124; no file outside policy.ts names it directly -- it runs only through StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/ConstraintKindSchema': 'policy.ts:9; no file outside policy.ts names it directly -- it runs only through PinnedConstraintSchema, then StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/EnforcementSchema': 'policy.ts:23; no file outside policy.ts names it directly -- it runs only through PinnedConstraintSchema, then StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/GistArtifactSchema': 'gist.ts:38; no file outside gist.ts names it directly -- it runs only through GistSchema, which @strata-ctx/security/gist-safety.ts:239 reads',
  'core-types/GistChangedSchema': 'gist.ts:19; no file outside gist.ts names it directly -- it runs only through GistSchema, which @strata-ctx/security/gist-safety.ts:239 reads',
  'core-types/GistDecisionSchema': 'gist.ts:30; no file outside gist.ts names it directly -- it runs only through GistSchema, which @strata-ctx/security/gist-safety.ts:239 reads',
  'core-types/GistDraftSchema': 'gist.ts:184; no file outside gist.ts names it directly -- it runs only through validateGistDraft, which @strata-ctx/integrations/claude-code-observers.ts:469 calls',
  'core-types/GistLogSchema': 'gist.ts:53; no file outside gist.ts names it directly -- it runs only through GistSchema, which @strata-ctx/security/gist-safety.ts:239 reads',
  'core-types/GistNextSchema': 'gist.ts:45; no file outside gist.ts names it directly -- it runs only through GistSchema, which @strata-ctx/security/gist-safety.ts:239 reads',
  'core-types/GistStatusSchema': 'gist.ts:16; no file outside gist.ts names it directly -- it runs only through GistSchema, which @strata-ctx/security/gist-safety.ts:239 reads',
  'core-types/GistVerificationSchema': 'gist.ts:65; no file outside gist.ts names it directly -- it runs only through GistSchema, which @strata-ctx/security/gist-safety.ts:239 reads',
  'core-types/GovernancePolicySchema': 'policy.ts:79; no file outside policy.ts names it directly -- it runs only through StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/LOSSY_CONTEXT': 'guards.ts:37; no file outside guards.ts names it directly -- it runs only through isLossyContext, which @strata-ctx/pipeline/order.ts:151 calls',
  'core-types/PinnedConstraintSchema': 'policy.ts:26; no file outside policy.ts names it directly -- it runs only through StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/PipelinePolicySchema': 'policy.ts:101; no file outside policy.ts names it directly -- it runs only through StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/RedactionPolicySchema': 'policy.ts:61; no file outside policy.ts names it directly -- it runs only through StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/RetentionPolicySchema': 'policy.ts:67; no file outside policy.ts names it directly -- it runs only through StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/SerializationPolicySchema': 'policy.ts:117; no file outside policy.ts names it directly -- it runs only through StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/StageNameSchema': 'policy.ts:90; no file outside policy.ts names it directly -- it runs only through PipelinePolicySchema, then StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/TriggerPolicySchema': 'policy.ts:43; no file outside policy.ts names it directly -- it runs only through PipelinePolicySchema, then StrataPolicySchema, which @strata-ctx/gateway/server.ts:274 reads',
  'core-types/estimateBlockTokens': 'tokens.ts:22; no file outside tokens.ts names it directly -- it runs only through estimateMessageTokens, which @strata-ctx/pipeline/recency.ts:62 calls',
  // --- @strata-ctx/gateway: exposed by the ruling. Three shapes, see the header above. ---
  'gateway/ByteRingTail': 'sse.ts:369; no file outside sse.ts names it directly -- it runs only through SsePipeline, then pipeSseUpstream, which server.ts:353 calls',
  'gateway/ConfigError': 'config.ts:93; no file outside config.ts names it and the only call sites are in-file, at config.ts:412, config.ts:422, config.ts:425, config.ts:431, inside parseConfig and readDocument -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/DEFAULT_CONFIG': 'config.ts:201; no file outside config.ts names it and the only call sites are in-file, at config.ts:303, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/DEFAULT_DEBOUNCE_MS': 'config.ts:456; no file outside config.ts names it and the only call sites are in-file, at config.ts:511, inside ConfigWatcher -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/KEYRING_SERVICE': 'credentials.ts:31; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:165, inside MissingCredentialError -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/KeyringAccessError': 'credentials.ts:175; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:237, inside resolveCredential -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/LOG_LEVELS': 'config.ts:32; no file outside config.ts names it and the only call sites are in-file, at config.ts:351, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/MissingCredentialError': 'credentials.ts:150; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:243, inside resolveCredential -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/PROVIDER_ENV_VAR': 'credentials.ts:24; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:148, inside keyringAccount -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ROUTES': 'routing.ts:175; no file outside routing.ts names it directly -- it runs only through matchRoute, which server.ts:631 calls',
  'gateway/SENSITIVE_HEADERS': 'credentials.ts:39; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:59, inside isSensitiveHeader -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/SSE_EVENT_TYPES': 'sse.ts:91; no file outside sse.ts names it and the only call sites are in-file, at sse.ts:98, inside isSseEventType -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/SsePipeline': 'sse.ts:577; no file outside sse.ts names it directly -- it runs only through pipeSseUpstream, which server.ts:353 calls',
  'gateway/UnsupportedProviderError': 'credentials.ts:191; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:210, credentials.ts:272, inside resolveCredential and applyCredentials -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/applyCredentials': 'credentials.ts:268; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:302, inside applyCredentialsStrict -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/authHeaderFor': 'credentials.ts:251; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:273, credentials.ts:295, inside applyCredentials and applyCredentialsStrict -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/builtinAdapters': 'routing.ts:117; no file outside routing.ts names it directly -- it runs only through resolveAdapter, which server.ts:850 calls',
  'gateway/countMessageTokens': 'token-estimator.ts:205; no file outside token-estimator.ts names it and the only call sites are in-file, at token-estimator.ts:328, inside MockTokenEstimator -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/isSensitiveHeader': 'credentials.ts:57; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:90, credentials.ts:299, inside redactHeaders and applyCredentialsStrict -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/isSseEventType': 'sse.ts:97; no file outside sse.ts names it and the only call sites are in-file, at sse.ts:243, inside consumeLine -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/keyringAccount': 'credentials.ts:148; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:231, inside resolveCredential -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/loadConfig': 'config.ts:439; no file outside config.ts names it and the only call sites are in-file, at config.ts:512, inside ConfigWatcher -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/nullKeyring': 'credentials.ts:134; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:227, inside resolveCredential -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.DEFAULT_OLLAMA_BASE_URL': 'ollama-adapter.ts:142; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:283, inside DISABLED_NARRATION_CONFIG -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.DISABLED_NARRATION_CONFIG': 'ollama-adapter.ts:279; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:456, inside resolveNarrationConfig -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.GOVERNANCE_FIELD_NAMES': 'ollama-adapter.ts:204; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:467, inside resolveNarrationConfig -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.NARRATION_BACKEND': 'ollama-adapter.ts:167; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:171, inside NARRATION_BACKENDS -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.NARRATION_BACKENDS': 'ollama-adapter.ts:171; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:174, inside isNarrationBackend -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.NARRATION_FIELDS': 'ollama-adapter.ts:192; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:197, inside isNarrationField -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.NARRATION_MIN_TOKENS': 'ollama-adapter.ts:219; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:285, inside DISABLED_NARRATION_CONFIG -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OLLAMA_DEFAULT_TIMEOUT_MS': 'ollama-adapter.ts:236; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:286, inside DISABLED_NARRATION_CONFIG -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OLLAMA_MAX_OUTPUT_TOKENS': 'ollama-adapter.ts:246; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:287, inside DISABLED_NARRATION_CONFIG -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OllamaBadResponseError': 'ollama-adapter.ts:632; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:653, ollama-adapter.ts:867, ollama-adapter.ts:1100, ollama-adapter.ts:1109, inside OllamaBadResponseError and buildNarrationRequest and parseNarrationReply -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OllamaError': 'ollama-adapter.ts:545; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:567, inside OllamaError -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OllamaModelNotFoundError': 'ollama-adapter.ts:591; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:1443, inside classifyStatusFailure -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OllamaNotLoopbackError': 'ollama-adapter.ts:678; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:870, ollama-adapter.ts:1572, inside buildNarrationRequest and listOllamaModels -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OllamaTimeoutError': 'ollama-adapter.ts:611; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:1398, inside classifyTransportFailure -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OllamaTransportError': 'ollama-adapter.ts:657; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:674, ollama-adapter.ts:1407, ollama-adapter.ts:1543, inside OllamaTransportError and classifyTransportFailure and narrate -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.OllamaUnreachableError': 'ollama-adapter.ts:570; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:1404, inside classifyTransportFailure -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.buildNarrationInstruction': 'ollama-adapter.ts:805; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:876, inside buildNarrationRequest -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.buildNarrationRequest': 'ollama-adapter.ts:860; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:1521, inside narrate -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.isNarrationBackend': 'ollama-adapter.ts:173; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:414, inside resolveNarrationConfig -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.isNarrationField': 'ollama-adapter.ts:196; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:463, ollama-adapter.ts:1031, inside resolveNarrationConfig and parseNarrative -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.parseNarrationReply': 'ollama-adapter.ts:1094; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:1484, inside callOllama -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/ollamaAdapter.stripGovernanceText': 'ollama-adapter.ts:824; no file outside ollama-adapter.ts names it and the only call sites are in-file, at ollama-adapter.ts:877, ollama-adapter.ts:1518, inside buildNarrationRequest and narrate -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/parseConfig': 'config.ts:410; no file outside config.ts names it and the only call sites are in-file, at config.ts:441, inside loadConfig -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/parseSseFrames': 'sse.ts:285; no file outside sse.ts names it directly -- it runs only through SsePipeline, then pipeSseUpstream, which server.ts:353 calls',
  'gateway/persistPending': 'server.ts:222; no file outside server.ts names it and the only call sites are in-file, at server.ts:456, inside handleIngress -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/redactSecret': 'credentials.ts:74; no file outside credentials.ts names it and the only call sites are in-file, at credentials.ts:90, inside redactHeaders -- no chain of same-file readers reaches an operator a reachable file calls',
  'gateway/safeParseConfig': 'config.ts:405; no file outside config.ts names it and the only call sites are in-file, at config.ts:548, inside ConfigWatcher -- no chain of same-file readers reaches an operator a reachable file calls',
  // --- @strata-ctx/integrations: exposed by the ruling. Three shapes, see the header above. ---
  'integrations/CLAUDE_CODE_AGENT_ID': 'surface-check.ts:161; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:542, inside deriveClaudeCode -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/COPILOT_SURFACE': 'copilot.ts:30; no file outside copilot.ts names it directly -- it runs only through governanceLabel, then buildCopilotMcpConfig, which surface-check.ts:706 calls',
  'integrations/DEFAULT_API_KEY_ENV': 'profiles.ts:30; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:282, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/DEFAULT_BRIDGE_HOST': 'profiles.ts:36; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:289, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/DEFAULT_BRIDGE_PORT': 'profiles.ts:37; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:290, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/DEFAULT_EDITOR_MODEL': 'profiles.ts:35; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:285, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/DEFAULT_HOOK_COMMAND': 'claude-code-hooks.ts:67; no file outside claude-code-hooks.ts names it directly -- it runs only through ClaudeCodeHooks, which @strata-ctx/cli/index.ts:398 calls',
  'integrations/DEFAULT_HOOK_TIMEOUT_SECONDS': 'claude-code-hooks.ts:68; no file outside claude-code-hooks.ts names it directly -- it runs only through ClaudeCodeHooks, which @strata-ctx/cli/index.ts:398 calls',
  'integrations/DEFAULT_MCP_SERVER_NAME': 'copilot.ts:32; no file outside copilot.ts names it directly -- it runs only through buildCopilotMcpConfig, which surface-check.ts:706 calls',
  'integrations/DEFAULT_MODEL': 'profiles.ts:33; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:283, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/DEFAULT_POLICY_FILE': 'copilot.ts:36; no file outside copilot.ts names it directly -- it runs only through buildCopilotMcpConfig, which surface-check.ts:706 calls',
  'integrations/DEFAULT_PRE_COMMIT_COMMAND': 'profiles.ts:31; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:286, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/DEFAULT_WEAK_MODEL': 'profiles.ts:34; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:284, inside resolve -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/ENVELOPE_FIELDS': 'templates.ts:150; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:485, inside renderEnvelopeSchema -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/ENVELOPE_LANGUAGE': 'templates.ts:30; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:477, inside renderBlockDelimiterTable -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/GEMINI_CONFIG_DIR': 'gemini.ts:61; no file outside gemini.ts names it directly -- it runs only through resolveGeminiPaths, then geminiHookSpec, which surface-check.ts:600 calls',
  'integrations/GEMINI_HOOK_COMMAND': 'gemini.ts:73; no file outside gemini.ts names it directly -- it runs only through geminiHookSpec, which surface-check.ts:600 calls',
  'integrations/GEMINI_SETTINGS_FILE': 'gemini.ts:64; no file outside gemini.ts names it directly -- it runs only through resolveGeminiPaths, then geminiHookSpec, which surface-check.ts:600 calls',
  'integrations/GOVERNANCE_BLOCK_CLOSE': 'claude-code-hooks.ts:65; no file outside claude-code-hooks.ts names it directly -- it runs only through ClaudeCodeHooks, which @strata-ctx/cli/index.ts:398 calls',
  'integrations/GOVERNANCE_BLOCK_OPEN': 'claude-code-hooks.ts:64; no file outside claude-code-hooks.ts names it directly -- it runs only through ClaudeCodeHooks, which @strata-ctx/cli/index.ts:398 calls',
  'integrations/GOVERNANCE_LANGUAGE': 'templates.ts:32; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:432, inside renderGovernanceBlock -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/GeminiAdapter': 'gemini.ts:162; no file outside gemini.ts names it and the only call sites are in-file, at gemini.ts:235, inside createGeminiAdapter -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/InMemoryContextStore': 'mcp-server.ts:626; no file outside mcp-server.ts names it directly -- it runs only through createInMemoryContext, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/JSONRPC_VERSION': 'mcp-server.ts:30; no file outside mcp-server.ts names it directly -- it runs only through MCPServer, then createStrataMcpServer, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/MCPError': 'mcp-server.ts:89; no file outside mcp-server.ts names it directly -- it runs only through MCPServer, then createStrataMcpServer, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/MCPServer': 'mcp-server.ts:1117; no file outside mcp-server.ts names it directly -- it runs only through createStrataMcpServer, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/NEVER_COMPRESSED': 'templates.ts:44; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:478, inside renderBlockDelimiterTable -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_API_KEY_ENV': 'opencode.ts:132; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:702, inside resolveProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_CONFIG_FILE': 'opencode.ts:102; no file outside opencode.ts names it directly -- it runs only through resolveOpenCodePaths, then openCodeHookSpec, which surface-check.ts:639 calls',
  'integrations/OPENCODE_DEFAULT_MODEL': 'opencode.ts:134; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:703, inside resolveProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_GATEWAY_URL': 'opencode.ts:131; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:697, inside resolveProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_GOVERNANCE_HEADER': 'opencode.ts:190; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:1085, inside OpenCodePlugin -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_GUARANTEE_TIER': 'opencode.ts:203; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:273, inside openCodeGovernanceLabel -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_HEADLINE': 'opencode.ts:205; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:276, inside openCodeGovernanceLabel -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_MCP_COMMAND': 'opencode.ts:130; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:708, inside resolveProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_MCP_SERVER_NAME': 'opencode.ts:129; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:707, inside resolveProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_PLUGIN_HOOK_NAMES': 'surface-check.ts:173; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:655, inside deriveOpenCode -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_POLICY_FILE': 'opencode.ts:133; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:710, inside resolveProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_PROVIDER_ID': 'opencode.ts:127; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:705, inside resolveProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_REDACTION_BLOCKED': 'opencode.ts:187; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:1069, inside OpenCodePlugin -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OPENCODE_WEAKER_THAN': 'opencode.ts:230; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:279, inside openCodeGovernanceLabel -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OUTPUT_PROTOCOL_VERSION': 'templates.ts:27; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:367, inside resolveProtocolOptions -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OpenCodeConfigError': 'opencode.ts:357; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:383, opencode.ts:389, opencode.ts:396, opencode.ts:403, inside requireGatewayUrl and requireEnvVarName and requirePlainToken -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/OpenCodePlugin': 'opencode.ts:937; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:1153, inside createOpenCodePlugin -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/PROCESS_IO': 'surface-check.ts:1847; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1859, inside runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/SEARCH_KINDS': 'mcp-server.ts:549; no file outside mcp-server.ts names it directly -- it runs only through InMemoryContextStore, then createInMemoryContext, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/SELF_GIST_BODY_FIELDS': 'templates.ts:209; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:495, inside renderSelfGistSchema -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/SNAPSHOT_FILE_NAME': 'surface-check.ts:149; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1818, inside SURFACE_CHECK_HELP -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/STRATA_HOOK_MARKER': 'claude-code-hooks.ts:62; no file outside claude-code-hooks.ts names it directly -- it runs only through ClaudeCodeHooks, which @strata-ctx/cli/index.ts:398 calls',
  'integrations/SURFACE_CHECK_HELP': 'surface-check.ts:1811; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1868, inside runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/SURFACE_SNAPSHOT_VERSION': 'surface-check.ts:146; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1071, inside validateSnapshot -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/StrataGovernanceError': 'opencode.ts:910; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:967, inside OpenCodePlugin -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/TEMPLATE_VERSION': 'templates.ts:26; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:686, inside renderClaudeMd -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/TOOL_ALIASES': 'mcp-server.ts:1087; no file outside mcp-server.ts names it directly -- it runs only through resolveToolName, which surface-check.ts:787 calls',
  'integrations/TemplateError': 'templates.ts:55; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:288, templates.ts:291, templates.ts:298, templates.ts:305, inside requireNonEmptyString and requireObject and requireArray -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/UnknownAgentError': 'profiles.ts:156; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:195, inside requireAgent -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/UnknownOpenCodeAgentError': 'opencode.ts:347; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:375, inside openCodeAgentId -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/buildPreCompactDraft': 'claude-code-observers.ts:381; no file outside claude-code-observers.ts names it and the only call sites are in-file, at claude-code-observers.ts:526, inside createPreCompactObserver -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/buildSessionClose': 'claude-code-observers.ts:834; no file outside claude-code-observers.ts names it and the only call sites are in-file, at claude-code-observers.ts:909, inside createSessionObserver -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/buildSessionOpen': 'claude-code-observers.ts:812; no file outside claude-code-observers.ts names it and the only call sites are in-file, at claude-code-observers.ts:905, inside createSessionObserver -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/checkSurface': 'surface-check.ts:1526; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1757, surface-check.ts:1942, inside updateSnapshot and runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/defaultSnapshotPath': 'surface-check.ts:1839; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1860, inside runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/deriveSurfaces': 'surface-check.ts:827; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1530, surface-check.ts:1897, inside checkSurface and runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/expectedPins': 'claude-code-observers.ts:642; no file outside claude-code-observers.ts names it and the only call sites are in-file, at claude-code-observers.ts:658, inside repin -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/governanceLabel': 'copilot.ts:141; no file outside copilot.ts names it directly -- it runs only through buildCopilotMcpConfig, which surface-check.ts:706 calls',
  'integrations/isClaudeHookEvent': 'claude-code-observers.ts:195; no file outside claude-code-observers.ts names it and the only call sites are in-file, at claude-code-observers.ts:991, inside createClaudeHookRouter -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/isSupportedAgent': 'profiles.ts:189; no file outside profiles.ts names it and the only call sites are in-file, at profiles.ts:194, inside requireAgent -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/missingPins': 'claude-code-observers.ts:647; no file outside claude-code-observers.ts names it and the only call sites are in-file, at claude-code-observers.ts:659, inside repin -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/openCodeGovernanceLabel': 'opencode.ts:272; no file outside opencode.ts names it and the only call sites are in-file, at opencode.ts:779, inside buildOpenCodeProfile -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/parseArtifactRef': 'mcp-server.ts:491; no file outside mcp-server.ts names it directly -- it runs only through createStrataMcpServer, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/readSnapshotText': 'surface-check.ts:1843; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1907, surface-check.ts:1935, inside runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/redactLocally': 'claude-code-hooks.ts:394; no file outside claude-code-hooks.ts names it and the only call sites are in-file, at claude-code-hooks.ts:390, inside redactWithFallback -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/refreshSnapshot': 'surface-check.ts:1667; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1761, inside updateSnapshot -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/renderFinding': 'surface-check.ts:1780; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1796, surface-check.ts:1802, inside renderResult -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/renderFindings': 'surface-check.ts:1786; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1918, surface-check.ts:1929, inside runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/renderOutputProtocol': 'templates.ts:503; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:813, inside renderClaudeMd -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/renderResult': 'surface-check.ts:1790; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1952, inside runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/renderSelfGistBlock': 'templates.ts:853; no file outside templates.ts names it and the only call sites are in-file, at templates.ts:470, inside renderExampleSelfGistBlock -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/repin': 'claude-code-observers.ts:653; no file outside claude-code-observers.ts names it and the only call sites are in-file, at claude-code-observers.ts:714, inside createUserPromptSubmitObserver -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/resolveGeminiPaths': 'gemini.ts:127; no file outside gemini.ts names it directly -- it runs only through geminiHookSpec, which surface-check.ts:600 calls',
  'integrations/resolveOpenCodePaths': 'opencode.ts:477; no file outside opencode.ts names it directly -- it runs only through openCodeHookSpec, which surface-check.ts:639 calls',
  'integrations/runCli': 'surface-check.ts:1859; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1959, inside entry -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/scoreText': 'mcp-server.ts:592; no file outside mcp-server.ts names it directly -- it runs only through InMemoryContextStore, then createInMemoryContext, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/snippetFor': 'mcp-server.ts:603; no file outside mcp-server.ts names it directly -- it runs only through InMemoryContextStore, then createInMemoryContext, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/tokenize': 'mcp-server.ts:573; no file outside mcp-server.ts names it directly -- it runs only through InMemoryContextStore, then createInMemoryContext, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/toolError': 'mcp-server.ts:175; no file outside mcp-server.ts names it directly -- it runs only through createStrataMcpServer, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/toolJson': 'mcp-server.ts:171; no file outside mcp-server.ts names it directly -- it runs only through createStrataMcpServer, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/updateSnapshot': 'surface-check.ts:1713; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1915, inside runCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'integrations/validateArgs': 'mcp-server.ts:312; no file outside mcp-server.ts names it directly -- it runs only through MCPServer, then createStrataMcpServer, which @strata-ctx/cli/index.ts:312 calls',
  'integrations/validateSnapshot': 'surface-check.ts:1065; no file outside surface-check.ts names it and the only call sites are in-file, at surface-check.ts:1545, surface-check.ts:1739, inside checkSurface and updateSnapshot -- no chain of same-file readers reaches an operator a reachable file calls',
  // --- @strata-ctx/pipeline: exposed by the ruling. Three shapes, see the header above. ---
  'pipeline/ARTIFACT_SCHEME': 'pointer.ts:36; no file outside pointer.ts names it directly -- it runs only through artifactUriFor, then pointerizeBlocks, which truncate.ts:326 calls',
  'pipeline/HEAD_SHARE': 'truncate.ts:81; no file outside truncate.ts names it directly -- it runs only through truncateText, then truncateBlocks, then applyTruncate, then truncateStage, which order.ts:78 reads',
  'pipeline/POINTER_MARKER': 'pointer.ts:43; no file outside pointer.ts names it directly -- it runs only through isPointerized, which truncate.ts:250 calls',
  'pipeline/RETAINED_MARKER': 'truncate.ts:72; no file outside truncate.ts names it directly -- it runs only through truncateText, then truncateBlocks, then applyTruncate, then truncateStage, which order.ts:78 reads',
  'pipeline/SELF_GIST_RETAIN_CHARS': 'self-gist.ts:92; no file outside self-gist.ts names it and the only call sites are in-file, at self-gist.ts:540, inside SelfGistStreamScanner -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/SELF_GIST_TAIL_CHARS': 'self-gist.ts:102; no file outside self-gist.ts names it and the only call sites are in-file, at self-gist.ts:491, inside retainTail -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/SelfGistStreamScanner': 'self-gist.ts:532; no file outside self-gist.ts names it and the only call sites are in-file, at self-gist.ts:634, inside createSelfGistScanner -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/TIER0_STAGE_ORDER': 'order.ts:48; no file outside order.ts names it directly -- it runs only through runTier0, which @strata-ctx/gateway/server.ts:448 calls',
  'pipeline/TIER_RETENTION': 'triage.ts:57; no file outside triage.ts names it directly -- it runs only through triageMessages, then triageStage, which order.ts:79 reads',
  'pipeline/TRUNCATION_MARKER': 'truncate.ts:71; no file outside truncate.ts names it directly -- it runs only through truncateText, then truncateBlocks, then applyTruncate, then truncateStage, which order.ts:78 reads',
  'pipeline/applyTruncate': 'truncate.ts:318; no file outside truncate.ts names it directly -- it runs only through truncateStage, which order.ts:78 reads',
  'pipeline/artifactUriFor': 'pointer.ts:45; no file outside pointer.ts names it directly -- it runs only through pointerizeBlocks, which truncate.ts:326 calls',
  'pipeline/capForTier': 'truncate.ts:84; no file outside truncate.ts names it directly -- it runs only through applyTruncate, then truncateStage, which order.ts:78 reads',
  'pipeline/classifyExitCode': 'severity.ts:144; no file outside severity.ts names it directly -- it runs only through classifySeverity, then applySeverityClassification, which truncate.ts:333 calls',
  'pipeline/classifySeverity': 'severity.ts:161; no file outside severity.ts names it directly -- it runs only through applySeverityClassification, which truncate.ts:333 calls',
  'pipeline/dedupeMessages': 'dedupe.ts:198; no file outside dedupe.ts names it directly -- it runs only through dedupeStage, which order.ts:77 reads',
  'pipeline/emptyDedupeReasons': 'dedupe.ts:85; no file outside dedupe.ts names it directly -- it runs only through dedupeMessages, then dedupeStage, which order.ts:77 reads',
  'pipeline/estimateLossyTokens': 'trigger.ts:157; no file outside trigger.ts names it and the only call sites are in-file, at trigger.ts:166, inside triggerFor -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/evaluateTrigger': 'trigger.ts:90; no file outside trigger.ts names it and the only call sites are in-file, at trigger.ts:165, inside triggerFor -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/extractExitCode': 'severity.ts:147; no file outside severity.ts names it directly -- it runs only through classifySeverity, then applySeverityClassification, which truncate.ts:333 calls',
  'pipeline/isFileRead': 'pointer.ts:73; no file outside pointer.ts names it directly -- it runs only through pointerizeBlocks, which truncate.ts:326 calls',
  'pipeline/lineSeverity': 'severity.ts:123; no file outside severity.ts names it directly -- it runs only through isHighSeverityLine, which truncate.ts:171 calls',
  'pipeline/matchTaskBoundarySignals': 'trigger.ts:78; no file outside trigger.ts names it and the only call sites are in-file, at trigger.ts:104, inside evaluateTrigger -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/maxSeverity': 'severity.ts:53; no file outside severity.ts names it directly -- it runs only through classifySeverity, then applySeverityClassification, which truncate.ts:333 calls',
  'pipeline/mergeAdjacentSameRole': 'dedupe.ts:183; no file outside dedupe.ts names it directly -- it runs only through dedupeMessages, then dedupeStage, which order.ts:77 reads',
  'pipeline/narrativeFrom': 'self-gist.ts:695; no file outside self-gist.ts names it and the only call sites are in-file, at self-gist.ts:876, inside buildSelfGistDraft -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/parseSelfGistDirective': 'self-gist.ts:459; no file outside self-gist.ts names it and the only call sites are in-file, at self-gist.ts:621, inside SelfGistStreamScanner -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/pointerStub': 'pointer.ts:130; no file outside pointer.ts names it directly -- it runs only through pointerizeBlocks, which truncate.ts:326 calls',
  'pipeline/reserveFor': 'trigger.ts:70; no file outside trigger.ts names it and the only call sites are in-file, at trigger.ts:92, inside evaluateTrigger -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/severityAtLeast': 'severity.ts:56; no file outside severity.ts names it directly -- it runs only through isHighSeverityLine, which truncate.ts:171 calls',
  'pipeline/stripGovernance': 'self-gist.ts:676; no file outside self-gist.ts names it and the only call sites are in-file, at self-gist.ts:834, self-gist.ts:871, inside summableRegion and buildSelfGistDraft -- no chain of same-file readers reaches an operator a reachable file calls',
  'pipeline/tagLeadingUserIntent': 'triage.ts:133; no file outside triage.ts names it directly -- it runs only through triageMessages, then triageStage, which order.ts:79 reads',
  'pipeline/triageMessages': 'triage.ts:171; no file outside triage.ts names it directly -- it runs only through triageStage, which order.ts:79 reads',
  'pipeline/truncateBlocks': 'truncate.ts:221; no file outside truncate.ts names it directly -- it runs only through applyTruncate, then truncateStage, which order.ts:78 reads',
  'pipeline/truncateText': 'truncate.ts:130; no file outside truncate.ts names it directly -- it runs only through truncateBlocks, then applyTruncate, then truncateStage, which order.ts:78 reads',
  // --- @strata-ctx/security: exposed by the ruling. Three shapes, see the header above. ---
  'security/ARTIFACT_BUCKETS': 'acl.ts:66; no file outside acl.ts names it directly -- it runs only through parseArtifactUri, which gist-safety.ts:351 calls',
  'security/DAY_MS': 'retention.ts:45; no file outside retention.ts names it directly -- it runs only through expiresAt, then planGc, which purge.ts:284 calls',
  'security/DEFAULT_ENTROPY_KEYWORD_WINDOW': 'entropy.ts:66; no file outside entropy.ts names it directly -- it runs only through DEFAULT_ENTROPY_OPTIONS, which redact.ts:117 reads',
  'security/DEFAULT_ENTROPY_MIN_LENGTH': 'entropy.ts:64; no file outside entropy.ts names it directly -- it runs only through DEFAULT_ENTROPY_OPTIONS, which redact.ts:117 reads',
  'security/DEFAULT_ENTROPY_THRESHOLD': 'entropy.ts:65; no file outside entropy.ts names it directly -- it runs only through DEFAULT_ENTROPY_OPTIONS, which redact.ts:117 reads',
  'security/DESTRUCTIVE_RULES': 'destructive.ts:156; no file outside destructive.ts names it directly -- it runs only through scanDestructive, which @strata-ctx/cli/index.ts:417 calls',
  'security/FORBIDDEN_BUILTINS': 'locality.ts:51; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:301, inside isForbiddenSpecifier -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/FORBIDDEN_GLOBALS': 'locality.ts:106; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:341, inside scanSource -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/FORBIDDEN_PACKAGES': 'locality.ts:64; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:303, inside isForbiddenSpecifier -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/GistTrustError': 'gist-safety.ts:109; no file outside gist-safety.ts names it and the only call sites are in-file, at gist-safety.ts:380, inside assertGistTrustworthy -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/LocalityViolationError': 'locality.ts:149; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:425, inside assertLocalSource -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/META_PURGE_CONFIRMATION': 'purge.ts:72; no file outside purge.ts names it and the only call sites are in-file, at purge.ts:195, inside parsePurgeRequest -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/NAMED_PREFIX': 'acl.ts:70; no file outside acl.ts names it directly -- it runs only through parseArtifactUri, which gist-safety.ts:351 calls',
  'security/PURGE_SCOPES': 'purge.ts:76; no file outside purge.ts names it and the only call sites are in-file, at purge.ts:175, inside parsePurgeRequest -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/RETAIN_WORTHY_ACTIONS': 'audit.ts:63; no file outside audit.ts names it directly -- it runs only through isRetainWorthy, which purge.ts:262 calls',
  'security/assertCatalogueWellFormed': 'redact.ts:199; no file outside redact.ts names it directly -- it runs only through RedactionEngine, which @strata-ctx/integrations/hook-builder.ts:500 calls',
  'security/assertPlanAcknowledged': 'retention.ts:257; no file outside retention.ts names it directly -- it runs only through applyGc, which purge.ts:339 calls',
  'security/commandSegments': 'destructive.ts:89; no file outside destructive.ts names it directly -- it runs only through scanDestructive, which @strata-ctx/cli/index.ts:417 calls',
  'security/contains': 'acl.ts:268; no file outside acl.ts names it directly -- it runs only through ArtifactAcl, which store.ts:213 reads',
  'security/containsSecret': 'redact.ts:475; no file outside redact.ts names it directly -- it runs only through RedactionEngine, which @strata-ctx/integrations/hook-builder.ts:500 calls',
  'security/defendGist': 'gist-safety.ts:232; no file outside gist-safety.ts names it and the only call sites are in-file, at gist-safety.ts:379, inside assertGistTrustworthy -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/digestOfAudit': 'purge.ts:456; no file outside purge.ts names it and the only call sites are in-file, at purge.ts:427, inside metaPurge -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/expiresAt': 'retention.ts:66; no file outside retention.ts names it directly -- it runs only through planGc, which purge.ts:284 calls',
  'security/extractTargets': 'destructive.ts:307; no file outside destructive.ts names it directly -- it runs only through scanDestructive, which @strata-ctx/cli/index.ts:417 calls',
  'security/invokes': 'destructive.ts:104; no file outside destructive.ts names it and the only call sites are in-file, at destructive.ts:125, inside denyIfInvoked -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/metaPurge': 'purge.ts:419; no file outside purge.ts names it and the only call sites are in-file, at purge.ts:375, inside handlePurgeRequest -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/packageOfSpecifier': 'locality.ts:294; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:302, inside isForbiddenSpecifier -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/parsePurgeRequest': 'purge.ts:168; no file outside purge.ts names it and the only call sites are in-file, at purge.ts:243, inside handlePurgeRequest -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/realpathNearest': 'acl.ts:289; no file outside acl.ts names it directly -- it runs only through ArtifactAcl, which store.ts:213 reads',
  'security/redactionModeFromPolicy': 'redact.ts:176; no file outside redact.ts names it directly -- it runs only through optionsFromPolicy, which @strata-ctx/integrations/hook-builder.ts:500 calls',
  'security/resolveEntropyOptions': 'redact.ts:156; no file outside redact.ts names it and the only call sites are in-file, at redact.ts:245, inside collect -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/retentionClassOf': 'retention.ts:54; no file outside retention.ts names it directly -- it runs only through planGc, which purge.ts:284 calls',
  'security/scanSource': 'locality.ts:311; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:424, inside assertLocalSource -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/shannonEntropy': 'entropy.ts:124; no file outside entropy.ts names it and the only call sites are in-file, at entropy.ts:290, inside evaluate -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/stripComments': 'locality.ts:175; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:227, locality.ts:313, inside stripCommentsAndStrings and scanSource -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/stripCommentsAndStrings': 'locality.ts:226; no file outside locality.ts names it and the only call sites are in-file, at locality.ts:332, inside scanSource -- no chain of same-file readers reaches an operator a reachable file calls',
  'security/uriFor': 'store.ts:160; no file outside store.ts names it directly -- it runs only through ArtifactStore, which @strata-ctx/gateway/server.ts:174 reads',
  // --- @strata-ctx/telemetry: exposed by the ruling. Three shapes, see the header above. ---
  'telemetry/CostError': 'cost.ts:118; no file outside cost.ts names it and nothing in cost.ts calls it; its only reference anywhere is a read by usage, which no reachable file calls, so nothing in the repository runs it',
  'telemetry/DEFAULT_STATUS_PATH': 'status.ts:1128; no file outside status.ts names it and the only call sites are in-file, at status.ts:1229, inside runStatusCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/EVICTION_SKIPPED_PREFIX': 'events.ts:420; no file outside events.ts names it directly -- it runs only through evictionSkipReason, which status.ts:588 calls',
  'telemetry/EXIT_FINDINGS': 'status.ts:1215; no file outside status.ts names it and the only call sites are in-file, at status.ts:1251, inside runStatusCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/EXIT_OK': 'status.ts:1214; no file outside status.ts names it and the only call sites are in-file, at status.ts:1222, inside runStatusCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/EXIT_USAGE': 'status.ts:1216; no file outside status.ts names it and the only call sites are in-file, at status.ts:1226, inside runStatusCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/NET_SAVINGS_GATE': 'savings.ts:138; no file outside savings.ts names it directly -- it runs only through breakdownSavings, which @strata-ctx/integrations/claude-code-observers.ts:855 calls',
  'telemetry/PRICING_STALE_AFTER_DAYS': 'pricing.ts:62; no file outside pricing.ts names it directly -- it runs only through pricingFreshness, which status.ts:705 calls',
  'telemetry/PricingError': 'pricing.ts:87; no file outside pricing.ts names it and the only call sites are in-file, at pricing.ts:70, pricing.ts:73, pricing.ts:82, pricing.ts:101, inside assertIsoDate and epochMsToIsoDate -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/REDACTED': 'redact.ts:52; no file outside redact.ts names it and the only call sites are in-file, at redact.ts:346, inside replaceAllKeepingGroups -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/REDACTION_RULES': 'redact.ts:174; no file outside redact.ts names it and nothing in redact.ts calls it; its only references anywhere are reads by redactTextWithHits and redactText, and no reachable file calls either, so nothing runs it',
  'telemetry/TELEMETRY_SCHEMA_VERSION': 'events.ts:44; no file outside events.ts names it directly -- it runs only through makeRecord, which sink.ts:150 calls',
  'telemetry/TelemetrySchemaError': 'events.ts:148; no file outside events.ts names it directly -- it runs only through makeRecord, which sink.ts:150 calls',
  'telemetry/TelemetrySinkError': 'sink.ts:74; no file outside sink.ts names it directly -- it runs only through assertLocalPath, then readJsonl, which status.ts:904 calls',
  'telemetry/assertLocalPath': 'sink.ts:123; no file outside sink.ts names it directly -- it runs only through readJsonl, which status.ts:904 calls',
  'telemetry/buildStatus': 'status.ts:347; no file outside status.ts names it and the only call sites are in-file, at status.ts:905, inside buildStatusFromLog -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/buildStatusFromLog': 'status.ts:903; no file outside status.ts names it and the only call sites are in-file, at status.ts:1232, inside runStatusCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/compactionEvent': 'events.ts:343; no file outside events.ts names it and the only call sites are in-file, at events.ts:439, inside emitCompaction -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/daysBetween': 'pricing.ts:110; no file outside pricing.ts names it directly -- it runs only through pricingFreshness, which status.ts:705 calls',
  'telemetry/epochMsToIsoDate': 'pricing.ts:100; no file outside pricing.ts names it and the only call sites are in-file, at pricing.ts:106, inside addDays -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/formatStatus': 'status.ts:965; no file outside status.ts names it and the only call sites are in-file, at status.ts:1249, inside runStatusCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/gistEvent': 'events.ts:372; no file outside events.ts names it and the only call sites are in-file, at events.ts:438, inside emitCompaction -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/hasRedactionCandidate': 'redact.ts:362; no file outside redact.ts names it directly -- it runs only through assertNoSecretsInLine, which sink.ts:400 calls',
  'telemetry/inputReduction': 'cost.ts:136; no file outside cost.ts names it and the only call sites are in-file, at cost.ts:220, inside analyseCost -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/isSensitiveKey': 'redact.ts:136; no file outside redact.ts names it and the only call sites are in-file, at redact.ts:404, inside walk -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/isoDateToEpochMs': 'pricing.ts:95; no file outside pricing.ts names it directly -- it runs only through daysBetween, then pricingFreshness, which status.ts:705 calls',
  'telemetry/outputExpansion': 'cost.ts:149; no file outside cost.ts names it and the only call sites are in-file, at cost.ts:221, inside analyseCost -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/parseStatusArgs': 'status.ts:1152; no file outside status.ts names it and the only call sites are in-file, at status.ts:1219, inside runStatusCli -- no chain of same-file readers reaches an operator a reachable file calls',
  'telemetry/redactTextWithHits': 'redact.ts:288; no file outside redact.ts names it and nothing in redact.ts calls it; its only reference anywhere is a read by redactText, which no reachable file calls, so nothing in the repository runs it',
  'telemetry/redactValue': 'redact.ts:386; no file outside redact.ts names it directly -- it runs only through redactRecord, which sink.ts:164 calls',
  'telemetry/spendShare': 'cost.ts:155; no file outside cost.ts names it and the only call sites are in-file, at cost.ts:223, inside analyseCost -- no chain of same-file readers reaches an operator a reachable file calls',
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
    operators: ['pipeline/pointerizeBlocks'],
    // pointer.ts:73 is `subject.kind === 'file'`; the adapters assign 'other'.
    producer: /kind:\s*'file'/,
    why:
      "isFileRead (pointer.ts:73) requires meta.subject.kind === 'file' and no adapter in a reachable module assigns it: anthropic-adapter.ts, gemini-adapter.ts and openai-compat-adapter.ts all assign 'other'. pointerizeBlocks is called at truncate.ts:326 and skips every block. isFileRead itself is unwired under the ruling -- nothing outside pointer.ts names it, and pointerizeBlocks is the only reader -- so it is carried by UNWIRED_OPERATORS, and this gate stays for the half that is wired but inert.",
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
  //
  // This assertion was vacuous until the ruling landed, and the reason is worth
  // keeping: `describe` appends `(declared <file>)` for the failure message, so
  // `entry in UNWIRED_OPERATORS` was looking for a key no table has and could
  // not fail for any input. Gate 1 already worked around that with
  // `stripDeclared`; doing the same here turned 16 rows red. Every one was a
  // single same-file `value` reference -- the confidence class
  // docs/wiring-ledger.md §6 already names as the weakest and the likeliest
  // false positive -- which is what settled the question of whether a reference
  // inside the declaring module counts as a caller. It does not. Those 16 rows
  // are now declared unwired with their real reason, and no row depends on this
  // gate being weak.
  const stale = ledger.wired
    .map(describe)
    .filter((entry) => entry in UNWIRED_OPERATORS || stripDeclared(entry) in UNWIRED_OPERATORS);
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

test('the detector still sees callers at scale', () => {
  // A regression guard on the detector itself: if the identifier search stops
  // working, `unwired` grows to nearly everything and every declaration becomes
  // a lie at once. This was a share (432/1089 = 39.7%, floor 35%) and is now an
  // absolute count, because the ruling deliberately moved the honest number
  // from 432 to 152 -- a share floor would have had to drop below the truth to
  // pass, which is the guard lying instead of the detector. The floor below is
  // 21% under the measured value; wire real operators and raise it.
  const { wired, entries } = ledger;
  assert.ok(wired.length > 120, `only ${wired.length} of ${entries.length} exports have a caller; the detector looks broken`);
  assert.ok(entries.length > 900, `inventory collapsed to ${entries.length} entries; the barrel walk is broken`);
  // The two halves are not symmetric, and the asymmetry is the point: an
  // inherited-unwired entry is inert by definition (its package has no caller),
  // so a large inherited share is expected, not a symptom.
  assert.ok(
    ledger.locallyUnwired.length > ledger.wired.length,
    'fewer locally unwired exports than wired ones: the self-reference ruling is not being applied',
  );
});

/* ------------------------------------------------------------------ *
 * The ruling, asserted clause by clause.
 *
 * `isCallingSite` is the whole "is it wired" decision, and each clause below is
 * a way this ledger has previously reported an operator as wired when nothing
 * runs it. They are asserted directly against the predicate with synthetic
 * sites, so a future edit to the filter chain cannot quietly reintroduce one.
 * ------------------------------------------------------------------ */

const site = (kind: ReferenceSite['kind'], file: string): ReferenceSite => ({ kind, file, line: 1 });
const EVERY_KIND: readonly ReferenceSite['kind'][] = [
  'declaration',
  'call',
  'new',
  'value',
  'import',
  'reexport',
  'typeonly',
  'member',
  'propertykey',
];

test('a self-reference is not a caller, for every reference kind', () => {
  const reachable = new Set(['packages/synthetic/src/thing.ts']);
  for (const kind of EVERY_KIND) {
    assert.equal(
      isCallingSite(site(kind, 'packages/synthetic/src/thing.ts'), 'packages/synthetic/src/thing.ts', reachable),
      false,
      `${kind} inside the declaring module was counted as wiring`,
    );
  }
});

test('a sibling file naming the symbol is a caller', () => {
  // File boundaries are the test, not package ones. pointerizeBlocks is declared
  // in pointer.ts and called from truncate.ts:326 and stays wired.
  const reachable = new Set(['packages/synthetic/src/thing.ts', 'packages/synthetic/src/sibling.ts']);
  for (const kind of ['call', 'new', 'value', 'import'] as const) {
    assert.equal(
      isCallingSite(site(kind, 'packages/synthetic/src/sibling.ts'), 'packages/synthetic/src/thing.ts', reachable),
      true,
      `${kind} in a sibling file was not counted as wiring`,
    );
  }
});

test('a reference from a module nothing reaches is not a caller', () => {
  assert.equal(
    isCallingSite(site('call', 'packages/eval/src/thing.ts'), 'packages/synthetic/src/thing.ts', new Set()),
    false,
  );
});

test('caller-shaped kinds in another reachable file are the only way to be wired', () => {
  // The complement of the two tests above, stated as an invariant: exactly the
  // caller kinds, in another reachable file, and nothing else.
  const declared = 'packages/synthetic/src/thing.ts';
  const other = 'packages/synthetic/src/sibling.ts';
  const reachable = new Set([declared, other]);
  const verdicts = EVERY_KIND.map((kind) => isCallingSite(site(kind, other), declared, reachable));
  assert.deepEqual(
    verdicts,
    [false, true, true, true, true, false, false, false, false],
    'the verdict for some reference kind changed; update this list and the ruling text in isCallingSite together',
  );
});

test('a symbol only its own file names is unwired, in the real tree', () => {
  // applyCredentials is declared at credentials.ts:268 and called at
  // credentials.ts:302 -- same file, so under the ruling it runs only if
  // something reachable calls it, and nothing does. This is the credential
  // subsystem that server.ts:301 bypasses with a literal header.
  const credential = ledger.entries.find((e) => e.package === 'gateway' && e.name === 'applyCredentials');
  assert.ok(credential !== undefined);
  assert.equal(credential.wired, false);
  assert.equal(credential.declaredIn, 'packages/gateway/src/credentials.ts');

  // The same shape, transitively: nothing outside truncate.ts names
  // truncateText, and truncateStage -- which does -- is called at order.ts:78.
  // Declared unwired because the ledger counts direct references, and the row
  // says so rather than calling it inert.
  const truncate = ledger.entries.find((e) => e.package === 'pipeline' && e.name === 'truncateText');
  assert.ok(truncate !== undefined);
  assert.equal(truncate.wired, false);
});

test('a direct caller still outranks a same-file one, in the real tree', () => {
  // The ruling must not be a blunt instrument. In gateway, matchRoute is called
  // from server.ts:631 and stays wired, while the whole credentials.ts surface
  // next to it is unwired -- same package, same file set, opposite verdicts, and
  // the difference is only whether another file names the symbol. A filter that
  // dropped siblings by accident would report 0 wired; this pins 152.
  const route = ledger.entries.find((e) => e.package === 'gateway' && e.name === 'matchRoute');
  assert.ok(route !== undefined);
  assert.equal(route.wired, true);
  assert.equal(route.confidence, 'call');
  assert.ok(
    route.sites.every((s) => s.file !== 'packages/gateway/src/routing.ts'),
    'the surviving sites for a wired operator should all be outside its declaring file',
  );

  const credential = ledger.entries.find((e) => e.package === 'gateway' && e.name === 'resolveCredential');
  assert.ok(credential !== undefined);
  assert.equal(credential.wired, false);
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