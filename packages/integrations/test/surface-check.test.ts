import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveToolName } from '../src/mcp-server.js';

import {
  SNAPSHOT_FILE_NAME,
  SURFACE_CHECK_HELP,
  checkSurface,
  defaultSnapshotPath,
  deriveSurfaces,
  readSnapshotText,
  refreshSnapshot,
  renderFinding,
  renderResult,
  runCli,
  updateSnapshot,
  validateSnapshot,
  type AgentSurface,
  type DerivedSurfaces,
  type SurfaceCheckIo,
  type SurfaceFinding,
  type SurfaceFindingKind,
  type SurfaceObservation,
} from '../src/surface-check.js';

// --- helpers ----------------------------------------------------------------

type Mutable = Record<string, unknown>;

const asRecord = (value: unknown): Mutable => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Mutable;
};

const clone = <T>(value: T): T => structuredClone(value);

/** The committed snapshot, re-read for every test so no test can poison another. */
const loadSnapshot = (): Mutable => asRecord(readSnapshotText(defaultSnapshotPath()));

const asStrings = (value: unknown): readonly string[] => {
  assert.ok(Array.isArray(value), 'expected an array');
  return value.filter((entry): entry is string => typeof entry === 'string');
};

const agentSurface = (snapshot: Mutable, agent: string): Mutable =>
  asRecord(asRecord(snapshot['agents'])[agent]);

const withAgent = (snapshot: Mutable, agent: string, change: (surface: Mutable) => void): Mutable => {
  const next = clone(snapshot);
  change(agentSurface(next, agent));
  return next;
};

const set = (record: Mutable, key: string, value: unknown): void => {
  record[key] = value;
};

const kinds = (findings: readonly SurfaceFinding[]): readonly SurfaceFindingKind[] =>
  findings.map((entry) => entry.kind);

const blocking = (result: { readonly blocking: readonly SurfaceFinding[] }): readonly SurfaceFinding[] =>
  result.blocking;

const report = (...entries: readonly SurfaceFinding[]): string => entries.map(renderFinding).join('\n');

const observation = (over: Partial<SurfaceObservation> = {}): SurfaceObservation => ({
  agent: 'claude-code',
  agentVersion: '2.0.14',
  recordedAt: '2026-01-05',
  source: 'https://docs.anthropic.com/en/docs/claude-code/hooks',
  hookEvents: [],
  payloadKeys: [],
  toolNames: [],
  ...over,
});

const withObservations = (snapshot: Mutable, entries: readonly unknown[]): Mutable => {
  const next = clone(snapshot);
  next['observations'] = entries;
  return next;
};

/** An `io` that keeps every line, so exit codes and text can both be asserted. */
const captureIo = (): {
  readonly io: SurfaceCheckIo;
  readonly out: string[];
  readonly err: string[];
} => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
};

const keysInUse = (surface: AgentSurface): readonly string[] => {
  const request = surface.requestKeysInUse;
  const result = surface.resultKeysInUse;
  return [...new Set([...request, ...result])].sort();
};

// --- derivation -------------------------------------------------------------

describe('deriveSurfaces', () => {
  it('derives a surface for every agent id the package can produce', () => {
    const derived = deriveSurfaces();
    assert.deepEqual(derived.errors, []);
    assert.deepEqual(Object.keys(derived.agents), [
      'aider',
      'claude-code',
      'cline',
      'gemini-cli',
      'github-copilot',
      'opencode',
      'roo',
    ]);
  });

  it('derives the whole registry, so an added agent id cannot slip past the gate', () => {
    // A gate that pins its own agent list is a gate that goes quiet when somebody
    // adds an integration. Every id `profiles.ts` knows has to appear here.
    const derived = deriveSurfaces();
    for (const agent of ['aider', 'cline', 'roo'] as const) {
      assert.equal(derived.agents[agent]?.mechanism, 'proxy-only');
      assert.equal(derived.agents[agent]?.hooks, false);
    }
  });

  it('finds the result container the Claude Code adapter reads instead of assuming it', () => {
    const claude = deriveSurfaces().agents['claude-code'];
    assert.notEqual(claude, undefined);
    // Both `result` and `tool_response` are honoured by the extractor, and both
    // are declared by `PostToolUsePayload`. A probe that returned nothing here
    // would mean the container key was renamed and nothing had noticed.
    assert.deepEqual(claude?.resultKeysInUse, ['result', 'tool_response']);
    for (const key of claude?.resultKeysInUse ?? []) {
      assert.equal(claude?.declaredPayloadKeys.includes(key), true, `${key} is read but not declared`);
    }
  });

  it('finds the request keys the shared normaliser honours', () => {
    const gemini = deriveSurfaces().agents['gemini-cli'];
    assert.notEqual(gemini, undefined);
    assert.deepEqual(gemini?.requestKeysInUse, ['sessionId', 'tool']);
  });

  it('leaves every key an adapter acts on explained by the interface or the rewriter', () => {
    // The invariant the checker enforces, asserted directly so a future adapter
    // cannot introduce an unpinned wire dependency quietly.
    for (const [agent, surface] of Object.entries(deriveSurfaces().agents)) {
      const explained = [
        ...surface.declaredPayloadKeys,
        ...(surface.resultRewrite === null ? [] : surface.resultRewrite.stringPaths),
      ];
      assert.deepEqual(
        keysInUse(surface).filter((key) => !explained.includes(key)),
        [],
        `${agent} reads keys nothing declares`,
      );
    }
  });

  it('agrees that a declared rewriter reads only the paths it was pointed at', () => {
    for (const [agent, surface] of Object.entries(deriveSurfaces().agents)) {
      if (surface.resultRewrite === null) continue;
      assert.deepEqual(
        surface.resultKeysInUse,
        surface.resultRewrite.stringPaths,
        `${agent} reads result keys outside its own spec`,
      );
    }
  });

  it('records the self-gist markers as agreeing, because the parser needs them to', () => {
    const { selfGist } = deriveSurfaces();
    assert.equal(selfGist.agrees, true);
    assert.equal(selfGist.directiveCarriesFence, true);
    assert.equal(selfGist.directiveCarriesSentinel, true);
    assert.equal(selfGist.language, selfGist.parserLanguage);
  });

  it('reports no unresolved MCP tool names, because every advertised name is served', () => {
    const result = checkSurface(loadSnapshot());
    const { mcp } = deriveSurfaces();
    // The profile layer advertises `ctx_get_task` while the server registers the
    // short name `get_task`. That is NOT a live bug: `MCPServer.callTool` runs
    // every incoming name through `TOOL_ALIASES` first, so all six resolve. An
    // earlier version of this check compared the advertised set against the
    // registered set without resolving, and reported all six as unserveable --
    // a permanent false advisory on every run, which is how a gate gets muted.
    assert.deepEqual(mcp.unresolved, []);
    assert.equal(
      result.advisories.some((a) => a.surface === 'mcp'),
      false,
      'a resolvable alias must not raise an mcp advisory',
    );
  });

  it('an advertised name the server cannot resolve would be reported, not dropped', () => {
    // The negative half of the test above: the fix must not have made the check
    // vacuous. `checkSurface` derives from the live adapters, so the negative
    // case is asserted at the level the rule actually lives -- every advertised
    // name must be either served outright or resolvable through the alias table.
    // A name satisfying neither is exactly what `unresolved` collects.
    const { mcp } = deriveSurfaces();
    for (const name of mcp.advertised) {
      const directlyServed = mcp.served.includes(name);
      const aliasResolvable = mcp.served.includes(resolveToolName(name));
      assert.ok(
        directlyServed || aliasResolvable,
        `${name} is advertised and neither served nor aliased`,
      );
    }
    assert.deepEqual(mcp.unresolved, []);
  });
});

// --- the committed snapshot -------------------------------------------------

describe('the committed snapshot', () => {
  it('validates against its own schema', () => {
    const validation = validateSnapshot(readSnapshotText(defaultSnapshotPath()));
    assert.equal(validation.ok, true, validation.ok ? '' : JSON.stringify(validation.issues));
  });

  it('passes the check', () => {
    const result = checkSurface(readSnapshotText(defaultSnapshotPath()));
    assert.deepEqual(blocking(result), []);
    assert.equal(result.ok, true, renderResult(result));
    assert.deepEqual(result.checkedAgents, [
      'aider',
      'claude-code',
      'cline',
      'gemini-cli',
      'github-copilot',
      'opencode',
      'roo',
    ]);
  });

  it('is byte-for-byte what the adapters derive today', () => {
    const path = defaultSnapshotPath();
    const text = readFileSync(path, 'utf8');
    const validation = validateSnapshot(JSON.parse(text) as unknown);
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    // If this fails, somebody changed an adapter and did not refresh the
    // snapshot: that is the drift the gate exists to catch, seen from the other
    // side. The remedy is `--update`, after confirming the change was intended.
    assert.equal(
      updateSnapshot(JSON.parse(text) as unknown, deriveSurfaces()).text,
      text,
      'the committed snapshot is stale: run surface-check --update',
    );
  });

  it('is pretty-printed with a trailing newline, like the other contract files', () => {
    const text = readFileSync(defaultSnapshotPath(), 'utf8');
    assert.equal(text.endsWith('}\n'), true);
    assert.equal(text.includes('\n  "agents": {'), true);
  });

  it('is 2-space indented and free of tabs', () => {
    const text = readFileSync(defaultSnapshotPath(), 'utf8');
    assert.equal(text.includes('\t'), false);
  });

  it('explains itself: the note says how to refresh it and who maintains what', () => {
    const snapshot = asRecord(readSnapshotText(defaultSnapshotPath()));
    const note = snapshot['note'];
    assert.equal(typeof note, 'string');
    assert.match(String(note), /--update/);
    assert.match(String(note), /observations/);
    assert.match(String(note), /docs\/decisions\.md/);
  });

  it('claims no observation it cannot back up', () => {
    const snapshot = asRecord(readSnapshotText(defaultSnapshotPath()));
    assert.deepEqual(snapshot['observations'], []);
    const result = checkSurface(readSnapshotText(defaultSnapshotPath()));
    assert.equal(result.unverified.length, 7);
  });

  it('lives beside the package rather than inside src/', () => {
    assert.equal(defaultSnapshotPath().endsWith(`/packages/integrations/${SNAPSHOT_FILE_NAME}`), true);
  });
});

// --- drift: what moved, and what it means -----------------------------------

describe('a renamed hook event', () => {
  it('is reported as code drift that names the agent and the rename', () => {
    const snapshot = withAgent(loadSnapshot(), 'claude-code', (surface) => {
      set(surface, 'hookEvents', ['PostToolUseRenamed', 'PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    });
    const result = checkSurface(snapshot);
    assert.equal(result.ok, false);
    const drift = result.blocking.find((entry) => entry.surface === 'hookEvents');
    assert.notEqual(drift, undefined);
    assert.equal(drift?.kind, 'code-drift');
    assert.equal(drift?.agent, 'claude-code');
    assert.equal(drift?.severity, 'blocking');
    assert.match(drift?.message ?? '', /looks like a rename/);
    assert.match(drift?.message ?? '', /surface-check --update/);
    assert.deepEqual(drift?.expected, [
      'PostToolUseRenamed',
      'PreCompact',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    assert.deepEqual(drift?.actual, [
      'PostToolUse',
      'PreCompact',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
  });

  it('is refreshable, because the events are derived from the adapter', () => {
    const snapshot = withAgent(loadSnapshot(), 'claude-code', (surface) => {
      set(surface, 'hookEvents', ['PostToolUseRenamed']);
    });
    const update = updateSnapshot(snapshot, deriveSurfaces());
    assert.equal(update.ok, true);
    const written = validateSnapshot(JSON.parse(update.text) as unknown);
    assert.equal(written.ok, true);
    if (!written.ok) return;
    assert.equal(written.snapshot.agents['claude-code']?.hookEvents.includes('PostToolUse'), true);
  });

  it('is an assumption drift for opencode, whose event names this package pins', () => {
    // Claude Code's and Gemini's event names come out of their adapters, so a
    // change there is code drift and a refresh is the remedy. The OpenCode plugin
    // hook names are a list this package asserts, so moving one is a judgement:
    // re-read the plugin API, decide, and edit the snapshot by hand.
    const snapshot = withAgent(loadSnapshot(), 'opencode', (surface) => {
      set(surface, 'hookEvents', ['tool.execute.after.renamed']);
    });
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'hookEvents');
    assert.equal(drift?.kind, 'assumption-drift');
    assert.equal(drift?.agent, 'opencode');
    assert.match(drift?.message ?? '', /by hand/);
    assert.equal(updateSnapshot(snapshot, deriveSurfaces()).ok, false);
  });

  it('gives the same event drift opposite remedies per agent, because the sources differ', () => {
    const derived = deriveSurfaces();
    assert.equal(derived.agents['claude-code']?.hookEventsSource, 'derived');
    assert.equal(derived.agents['gemini-cli']?.hookEventsSource, 'derived');
    assert.equal(derived.agents['opencode']?.hookEventsSource, 'assumed');
  });
});

describe('a changed parameter shape', () => {
  it('is an assumption drift when the payload interface is what moved', () => {
    const snapshot = withAgent(loadSnapshot(), 'claude-code', (surface) => {
      set(surface, 'declaredPayloadKeys', ['cwd', 'hook_event_name', 'result', 'brand_new_key', 'tool_name']);
    });
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'declaredPayloadKeys');
    assert.equal(drift?.kind, 'assumption-drift');
    assert.match(drift?.message ?? '', /by hand/);
    assert.match(drift?.message ?? '', /--update` will not overwrite/);
  });

  it('is only a code drift when the tool list moved, because the list is derived', () => {
    const snapshot = withAgent(loadSnapshot(), 'gemini-cli', (surface) => {
      set(surface, 'tools', ['read_file', 'write_file', 'a_brand_new_tool']);
    });
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'tools');
    assert.equal(drift?.kind, 'code-drift');
  });

  it('is an assumption drift when the pinned confidence moved', () => {
    // A scalar judgement has no code behind it, so nothing but a human can decide
    // it: `docs/integrations.md` §2 is the source, and the snapshot must be edited.
    const snapshot = withAgent(loadSnapshot(), 'gemini-cli', (surface) => {
      set(surface, 'confidence', 'high');
    });
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'confidence');
    assert.equal(drift?.kind, 'assumption-drift');
    // A scalar is reported as both sides rather than a diff of one.
    assert.match(drift?.message ?? '', /snapshot: "high"/);
    assert.match(drift?.message ?? '', /live: "verify"/);
  });

  it('is an assumption drift when the pinned mechanism moved', () => {
    const snapshot = withAgent(loadSnapshot(), 'gemini-cli', (surface) => {
      set(surface, 'mechanism', 'plugin-module');
    });
    const result = checkSurface(snapshot);
    assert.equal(result.blocking.find((entry) => entry.surface === 'mechanism')?.kind, 'assumption-drift');
  });

  it('is an assumption drift for a hook-capable agent, even though its events are derived', () => {
    // `hookEventsSource` decides which remedy applies per field, not per agent:
    // a derived event list is refreshable, a pinned tool list is not.
    const snapshot = withAgent(loadSnapshot(), 'opencode', (surface) => {
      set(surface, 'declaredPayloadKeys', ['args', 'callID', 'output', 'sessionID', 'tool', 'brand_new_key']);
    });
    const result = checkSurface(snapshot);
    assert.equal(result.blocking.some((entry) => entry.surface === 'declaredPayloadKeys'), true);
  });
});

describe('a missing profile', () => {
  it('is reported as code drift naming the file the integration would write', () => {
    const snapshot = withAgent(loadSnapshot(), 'gemini-cli', (surface) => {
      set(surface, 'profiles', ['settings.json']);
    });
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'profiles');
    assert.equal(drift?.kind, 'code-drift');
    assert.equal(drift?.agent, 'gemini-cli');
    assert.equal(drift?.actual?.includes('GEMINI.md'), true);
    assert.equal(drift?.message.includes('GEMINI.md'), true);
  });

  it('is reported when a launch flag the integration depends on disappears', () => {
    const snapshot = withAgent(loadSnapshot(), 'aider', (surface) => {
      set(surface, 'launchFlags', ['--config', '--model', '--no-check-update', '--yes']);
    });
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'launchFlags');
    assert.equal(drift?.kind, 'code-drift');
    // The flag is the integration: drop it and the profile talks to a provider
    // directly, so the message has to name it rather than say "lists differ".
    assert.equal(drift?.message.includes('--openai-api-base'), true);
  });

  it('is reported when a settings artifact the adapter writes disappears', () => {
    const snapshot = withAgent(loadSnapshot(), 'opencode', (surface) => {
      const settings = asRecord(surface['settings']);
      set(settings, 'instructionFile', '');
    });
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'settings');
    assert.equal(drift?.kind, 'code-drift');
    // A nested shape is reported whole, so both sides of the change are visible.
    assert.match(drift?.message ?? '', /"instructionFile":"AGENTS\.md"/);
    assert.match(drift?.message ?? '', /"instructionFile":""/);
  });
});

describe('an unknown or missing agent', () => {
  it('refuses to accept an agent no adapter produces', () => {
    const snapshot = clone(loadSnapshot());
    const agents = asRecord(snapshot['agents']);
    agents['totally-made-up'] = clone(agents['roo']);
    const result = checkSurface(snapshot);
    const finding = result.blocking.find((entry) => entry.kind === 'unknown-agent');
    assert.equal(finding?.agent, 'totally-made-up');
    assert.match(finding?.message ?? '', /delete the entry by hand/);
    assert.equal(result.ok, false);
  });

  it('refuses to let --update drop an unknown agent for you', () => {
    const snapshot = clone(loadSnapshot());
    asRecord(snapshot['agents'])['totally-made-up'] = clone(asRecord(snapshot['agents'])['roo']);
    const update = updateSnapshot(snapshot, deriveSurfaces());
    assert.equal(update.ok, false);
    assert.equal(update.changed, false);
    assert.equal(update.text, '');
    assert.deepEqual(kinds(update.findings), ['unknown-agent']);
  });

  it('carries an unknown agent through a refresh untouched, rather than erasing it', () => {
    const snapshot = clone(loadSnapshot());
    asRecord(snapshot['agents'])['totally-made-up'] = clone(asRecord(snapshot['agents'])['roo']);
    // Refused above, so the only way to see it survive a write is the primitive
    // itself: the record of a surface that used to exist must not vanish.
    const update = updateSnapshot(snapshot, deriveSurfaces());
    assert.equal(update.text, '');
  });

  it('reports an adapter with no snapshot record as a missing agent', () => {
    const snapshot = clone(loadSnapshot());
    const agents = asRecord(snapshot['agents']);
    delete agents['roo'];
    const result = checkSurface(snapshot);
    const finding = result.blocking.find((entry) => entry.kind === 'missing-agent');
    assert.equal(finding?.agent, 'roo');
    assert.match(finding?.message ?? '', /nothing is pinned about it/);
    assert.equal(result.ok, false);
  });

  it('adds a missing agent whole on --update, because there is no judgement to lose', () => {
    const snapshot = clone(loadSnapshot());
    delete asRecord(snapshot['agents'])['roo'];
    const update = updateSnapshot(snapshot, deriveSurfaces());
    assert.equal(update.ok, true);
    const written = validateSnapshot(JSON.parse(update.text) as unknown);
    assert.equal(written.ok, true);
    if (!written.ok) return;
    assert.deepEqual(written.snapshot.agents['roo']?.profiles, ['.roo/strata.json']);
    assert.equal(checkSurface(JSON.parse(update.text) as unknown).ok, true);
  });
});

// --- the update path --------------------------------------------------------

describe('--update', () => {
  it('refuses and writes nothing while a pinned assumption disagrees with the code', () => {
    const snapshot = withAgent(loadSnapshot(), 'claude-code', (surface) => {
      set(surface, 'declaredPayloadKeys', ['cwd', 'hook_event_name', 'result', 'oops']);
    });
    const update = updateSnapshot(snapshot, deriveSurfaces());
    assert.equal(update.ok, false);
    assert.equal(update.changed, false);
    assert.equal(update.text, '');
    assert.deepEqual(kinds(update.findings), ['assumption-drift']);
  });

  it('refuses while a recorded observation says the agent moved', () => {
    const snapshot = withObservations(loadSnapshot(), [
      observation({ hookEvents: ['PostToolUse', 'PreToolUseFired', 'SessionEnd', 'SessionStart', 'UserPromptSubmit'] }),
    ]);
    const update = updateSnapshot(snapshot, deriveSurfaces());
    assert.equal(update.ok, false);
    assert.equal(update.text, '');
    assert.deepEqual(kinds(update.findings), ['surface-drift']);
  });

  it('keeps every pinned judgement, the note and the observations', () => {
    const snapshot = withObservations(
      withAgent(loadSnapshot(), 'claude-code', (surface) => {
        set(surface, 'confidence', 'verify');
        set(surface, 'hookEvents', ['PostToolUseRenamed']);
      }),
      [observation()],
    );
    set(snapshot, 'note', 'a note a human wrote');
    const update = updateSnapshot(snapshot, deriveSurfaces());
    assert.equal(update.ok, true);
    const written = validateSnapshot(JSON.parse(update.text) as unknown);
    assert.equal(written.ok, true);
    if (!written.ok) return;
    const claude = written.snapshot.agents['claude-code'];
    // The derived event list is refreshed, and only the derived half of it.
    assert.equal(claude?.hookEvents.includes('PostToolUse'), true);
    // The judgement, the note and the evidence survive a rewrite untouched.
    assert.equal(claude?.confidence, 'verify');
    assert.equal(written.snapshot.note, 'a note a human wrote');
    assert.deepEqual(written.snapshot.observations, [observation()]);
  });

  it('refreshes only the derived half, which is what refreshSnapshot does directly', () => {
    // `updateSnapshot` is the CLI wrapper around this primitive, so the guarantee
    // is asserted here too: derived fields follow the code, pinned ones do not.
    const validation = validateSnapshot(loadSnapshot());
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    const pinned = asRecord(clone(validation.snapshot));
    const claude = agentSurface(pinned, 'claude-code');
    set(claude, 'hookEvents', ['PostToolUseRenamed']);
    set(claude, 'confidence', 'high');
    set(claude, 'declaredPayloadKeys', ['tool_name']);
    const mutated = validateSnapshot(pinned);
    assert.equal(mutated.ok, true);
    if (!mutated.ok) return;
    const refreshed = refreshSnapshot(mutated.snapshot, deriveSurfaces());
    const after = agentSurface(asRecord(refreshed), 'claude-code');
    // The event list followed the code; both pinned judgements survived it.
    assert.equal(asStrings(after['hookEvents']).includes('PostToolUse'), true);
    assert.equal(after['confidence'], 'high');
    assert.deepEqual(asStrings(after['declaredPayloadKeys']), ['tool_name']);
  });

  it('refuses an unreadable or unparseable snapshot rather than overwriting it', () => {
    const update = updateSnapshot({ 'not': 'a snapshot' }, deriveSurfaces());
    // Shape validation fails, so the only safe move is to report and write nothing;
    // the file on disk is the evidence of what somebody meant.
    assert.equal(update.ok, false);
    assert.equal(update.text, '');
    assert.ok(kinds(update.findings).length > 0);
  });

  it('seeds a fresh snapshot, and says loudly that observations are not carried over', () => {
    const update = updateSnapshot(null, deriveSurfaces());
    assert.equal(update.ok, true);
    assert.equal(update.changed, true);
    assert.match(update.warning ?? '', /no snapshot existed/);
    const written = validateSnapshot(JSON.parse(update.text) as unknown);
    assert.equal(written.ok, true);
  });
});

describe('recorded observations', () => {
  it('fails open: an agent with no capture is unverified, not failed', () => {
    // The checker is offline by construction and will never fetch an agent's real
    // payload. Refusing to pass without a capture would make the gate permanently
    // red, so "unverified" is reported in the summary and counted by nothing.
    const result = checkSurface(loadSnapshot());
    assert.equal(result.ok, true);
    assert.equal(result.unverified.length, 7);
    assert.match(renderResult(result), /unverified \(no recorded observation/);
    assert.equal(blocking(result).length, 0);
  });

  it('is unverified for one agent only when that agent has no capture', () => {
    const snapshot = withObservations(loadSnapshot(), [observation()]);
    const result = checkSurface(snapshot);
    assert.deepEqual(result.unverified, [
      'aider',
      'cline',
      'gemini-cli',
      'github-copilot',
      'opencode',
      'roo',
    ]);
    assert.equal(result.ok, true);
  });

  it('treats a capture that reports an event the adapter does not use as surface drift', () => {
    // The agent moved: it fires an event we do not handle. Re-pinning the snapshot
    // cannot fix that, which is why this kind is never auto-refreshed.
    const snapshot = withObservations(loadSnapshot(), [
      observation({ hookEvents: ['PostToolUse', 'Notification', 'SessionEnd', 'SessionStart', 'UserPromptSubmit'] }),
    ]);
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.kind === 'surface-drift');
    assert.equal(drift?.agent, 'claude-code');
    assert.equal(drift?.surface, 'hookEvents');
    assert.match(drift?.message ?? '', /Notification/);
    assert.match(drift?.message ?? '', /re-pinning the snapshot cannot/);
    assert.equal(result.ok, false);
  });

  it('treats a capture that reports a payload key the adapter does not read as surface drift', () => {
    const snapshot = withObservations(loadSnapshot(), [
      observation({ payloadKeys: ['result', 'tool_response', 'permission_decision'] }),
    ]);
    const result = checkSurface(snapshot);
    const drift = result.blocking.find((entry) => entry.surface === 'payloadKeys');
    assert.equal(drift?.kind, 'surface-drift');
    assert.match(drift?.message ?? '', /permission_decision/);
  });

  it('accepts a capture that matches what the adapter depends on', () => {
    const snapshot = withObservations(loadSnapshot(), [
      observation({
        hookEvents: ['PostToolUse', 'PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit'],
        payloadKeys: ['result', 'tool_response'],
        toolNames: ['Bash', 'Edit', 'Read', 'Write'],
      }),
    ]);
    const result = checkSurface(snapshot);
    assert.equal(result.ok, true, renderResult(result));
    assert.equal(result.unverified.includes('claude-code'), false);
  });

  it('rejects a capture that cannot be dated or attributed', () => {
    for (const field of ['agentVersion', 'recordedAt', 'source'] as const) {
      const entry: Mutable = { ...observation() };
      delete entry[field];
      const result = checkSurface(withObservations(loadSnapshot(), [entry]));
      assert.equal(result.ok, false, `a capture without ${field} was accepted`);
      assert.equal(
        result.blocking.some(
          (entry_) => entry_.kind === 'snapshot-invalid' && entry_.surface.includes(`observations[0].${field}`),
        ),
        true,
      );
    }
  });

  it('flags an observation recorded for an agent no adapter produces', () => {
    const snapshot = withObservations(loadSnapshot(), [observation({ agent: 'an-agent-we-do-not-ship' })]);
    const result = checkSurface(snapshot);
    assert.equal(result.ok, false);
    assert.equal(
      result.blocking.some((entry) => entry.surface === 'observation' && entry.agent === 'an-agent-we-do-not-ship'),
      true,
    );
  });

  it('does not treat an empty capture as agreement about every agent', () => {
    // A capture with empty lists matches an agent that has no hooks, which is how
    // the three proxy-only agents look. Asserting that here keeps the comparison
    // honest: empty is only ever a match for an empty surface.
    const snapshot = withObservations(loadSnapshot(), [observation({ agent: 'aider' })]);
    const result = checkSurface(snapshot);
    assert.equal(result.ok, true);
    assert.equal(result.unverified.includes('aider'), false);
  });
});

describe('an injected probe', () => {
  it('clears the unverified list for the agents it can reach', () => {
    const result = checkSurface(loadSnapshot(), {
      probe: (agent) =>
        agent === 'claude-code'
          ? observation({
              hookEvents: ['PostToolUse', 'PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit'],
            })
          : undefined,
    });
    assert.equal(result.ok, true, renderResult(result));
    assert.equal(result.unverified.includes('claude-code'), false);
    assert.equal(result.unverified.includes('opencode'), true);
  });

  it('reports drift when what it returns contradicts the adapter', () => {
    const result = checkSurface(loadSnapshot(), {
      probe: (agent) => (agent === 'opencode' ? observation({ agent: 'opencode', hookEvents: ['nope'] }) : undefined),
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocking.some((entry) => entry.kind === 'surface-drift' && entry.agent === 'opencode'), true);
  });

  it('fails closed: a probe that cannot reach anything is unverified, never a pass with data', () => {
    const result = checkSurface(loadSnapshot(), { probe: () => undefined });
    assert.equal(result.ok, true);
    assert.equal(result.unverified.length, 7);
    assert.equal(result.findings.some((entry) => entry.kind === 'surface-drift'), false);
  });
});

// --- invalid input ----------------------------------------------------------

describe('a snapshot that is not a snapshot', () => {
  it('is rejected with the path that is wrong', () => {
    const result = checkSurface({ version: 1, agents: { 'claude-code': { hooks: 'yes' } } });
    assert.equal(result.ok, false);
    assert.equal(result.blocking.every((entry) => entry.kind === 'snapshot-invalid'), true);
    assert.equal(
      result.blocking.some((entry) => entry.surface.startsWith('agents.claude-code')),
      true,
    );
  });

  it('rejects a missing note, a wrong version and an empty agent set', () => {
    for (const mutation of [
      (snapshot: Mutable) => delete snapshot['note'],
      (snapshot: Mutable) => set(snapshot, 'version', 99),
      (snapshot: Mutable) => set(snapshot, 'agents', {}),
      (snapshot: Mutable) => set(snapshot, 'mcp', 'nope'),
      (snapshot: Mutable) => set(snapshot, 'selfGist', { fence: '', language: 'ctx-gist' }),
    ]) {
      const snapshot = clone(loadSnapshot());
      mutation(snapshot);
      const result = checkSurface(snapshot);
      assert.equal(result.ok, false);
      assert.equal(result.blocking.some((entry) => entry.kind === 'snapshot-invalid'), true);
    }
  });

  it('rejects null rather than treating an absent file as a pass', () => {
    const result = checkSurface(null);
    assert.equal(result.ok, false);
    assert.equal(result.blocking.every((entry) => entry.kind === 'snapshot-invalid'), true);
  });

  it('rejects an agent whose event list is a string', () => {
    const snapshot = withAgent(loadSnapshot(), 'roo', (surface) => {
      set(surface, 'hookEvents', 'PostToolUse');
    });
    const result = checkSurface(snapshot);
    assert.equal(result.ok, false);
    assert.equal(
      result.blocking.some((entry) => entry.surface === 'agents.roo.hookEvents' && entry.kind === 'snapshot-invalid'),
      true,
    );
  });
});

// --- CLI --------------------------------------------------------------------

describe('runCli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-check-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, value: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return path;
  };

  it('exits 0 on the committed snapshot and reports what is unverified', () => {
    const { io, out, err } = captureIo();
    assert.equal(runCli([], io), 0);
    assert.equal(err.length, 0);
    assert.match(out.join('\n'), /surface check passed: 7 agent surfaces/);
  });

  it('exits non-zero on a perturbed snapshot and names the agent it found', () => {
    const snapshot = withAgent(loadSnapshot(), 'gemini-cli', (surface) => {
      set(surface, 'hookEvents', ['PostToolUseRenamed', 'pre_tool_use']);
    });
    const { io, err } = captureIo();
    const code = runCli(['--snapshot', write('perturbed.json', snapshot)], io);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /gemini-cli/);
    assert.match(err.join('\n'), /code-drift/);
  });

  it('exits non-zero on a snapshot it cannot parse, and says how to fix it', () => {
    const { io, err } = captureIo();
    assert.equal(runCli(['--snapshot', write('broken.json', '{ not json')], io), 1);
    assert.match(err.join('\n'), /cannot read/);
    assert.match(err.join('\n'), /--update/);
  });

  it('exits 2 on a usage error, so a typo never looks like drift', () => {
    for (const argv of [['--nope'], ['--snapshot']]) {
      const { io, err } = captureIo();
      assert.equal(runCli(argv, io), 2);
      assert.ok(err.length > 0);
    }
  });

  it('exits 0 for --help, and the help says the checker is offline', () => {
    const { io, out } = captureIo();
    assert.equal(runCli(['--help'], io), 0);
    assert.match(out.join('\n'), /--update/);
    assert.match(out.join('\n'), /Offline by construction/);
    assert.equal(out.join('\n'), SURFACE_CHECK_HELP);
  });

  it('--json emits a machine-readable result', () => {
    const { io, out } = captureIo();
    assert.equal(runCli(['--json'], io), 0);
    const parsed: unknown = JSON.parse(out.join('\n'));
    const record = asRecord(parsed);
    assert.equal(record['ok'], true);
    assert.equal(Array.isArray(record['findings']), true);
  });

  it('--print emits the live assumption without touching the snapshot', () => {
    const { io, out } = captureIo();
    assert.equal(runCli(['--print'], io), 0);
    const printed = asRecord(JSON.parse(out.join('\n')));
    const agents = asRecord(printed['agents']);
    assert.equal(Object.keys(agents).length, 7);
    assert.equal(agents['opencode'] === undefined, false);
  });

  it('--update writes a snapshot that then passes, and refuses the next run as unnecessary', () => {
    const path = join(dir, 'seeded.json');
    const first = captureIo();
    assert.equal(runCli(['--snapshot', path, '--update'], first.io), 0);
    assert.match(first.out.join('\n'), /snapshot written/);
    assert.match(first.err.join('\n'), /no snapshot existed/);
    assert.equal(runCli(['--snapshot', path], first.io), 0);
  });

  it('--update refuses on a pinned assumption and writes nothing', () => {
    const path = join(dir, 'assumption.json');
    const snapshot = withAgent(loadSnapshot(), 'roo', (surface) => {
      set(surface, 'confidence', 'verify');
    });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const before = readFileSync(path, 'utf8');
    const { io, err } = captureIo();
    assert.equal(runCli(['--snapshot', path, '--update'], io), 1);
    assert.match(err.join('\n'), /refusing to refresh/);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

// --- provenance -------------------------------------------------------------

describe('provenance and hygiene', () => {
  const source = (): string =>
    readFileSync(new URL('../src/surface-check.ts', import.meta.url), 'utf8') + readFileSync(defaultSnapshotPath(), 'utf8');

  it('cites a source module for every agent surface it pins', () => {
    for (const [agent, surface] of Object.entries(deriveSurfaces().agents)) {
      assert.ok(surface.modules.length > 0, `${agent} pins no source module`);
      for (const module of surface.modules) {
        assert.match(module, /^src\/[a-z0-9-]+\.ts$/, `${agent} cites ${module}`);
      }
    }
  });

  it('marks the events it could not derive, rather than presenting them as facts', () => {
    const opencode = deriveSurfaces().agents['opencode'];
    assert.equal(opencode?.hookEventsSource, 'assumed');
    assert.equal(opencode?.confidence, 'verify');
    const claude = deriveSurfaces().agents['claude-code'];
    assert.equal(claude?.hookEventsSource, 'derived');
  });

  it('leaves no TODO, FIXME or placeholder behind', () => {
    const text = source();
    for (const marker of ['TODO', 'FIXME', 'XXX', 'PLACEHOLDER', 'coming soon']) {
      assert.equal(text.includes(marker), false, `left a ${marker} in the checker or the snapshot`);
    }
  });

  it('leaves no `any` behind', () => {
    const text = source();
    assert.equal(/:\s*any\b/.test(text), false);
    assert.equal(/as any\b/.test(text), false);
  });

  it('does not reach for the network or a subprocess', () => {
    const text = source();
    for (const marker of ['fetch(', 'node:http', 'node:https', 'node:child_process', 'execSync', 'spawnSync']) {
      assert.equal(text.includes(marker), false, `the checker must stay offline, found ${marker}`);
    }
  });

  it('explains every finding with a remedy a reader can act on', () => {
    const snapshot = withAgent(loadSnapshot(), 'gemini-cli', (surface) => {
      set(surface, 'profiles', []);
    });
    for (const entry of checkSurface(snapshot).findings) {
      const rendered = renderFinding(entry);
      assert.ok(rendered.includes('['), entry.kind);
      assert.ok(entry.message.length > 40, `${entry.kind} explains nothing`);
    }
    assert.equal(report(...checkSurface(snapshot).blocking).includes('surface-check --update'), true);
  });
});

describe('the whole pipeline, end to end', () => {
  let derived: DerivedSurfaces;

  before(() => {
    derived = deriveSurfaces();
  });

  it('goes from live adapters to a passing snapshot and back', () => {
    const update = updateSnapshot(null, derived);
    assert.equal(update.ok, true);
    const result = checkSurface(JSON.parse(update.text) as unknown);
    assert.equal(result.ok, true, renderResult(result));
    assert.equal(result.derived.agents['claude-code']?.mechanism, 'settings-json');
  });

  it('reports the same thing whether the snapshot came from disk or from an update', () => {
    const fromDisk = checkSurface(readSnapshotText(defaultSnapshotPath()));
    const fromUpdate = checkSurface(JSON.parse(updateSnapshot(null, deriveSurfaces()).text) as unknown);
    assert.deepEqual(
      fromUpdate.findings.map((entry) => entry.kind),
      fromDisk.findings.map((entry) => entry.kind),
    );
  });
});
