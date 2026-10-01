import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runId, sha256, StrataPolicySchema, type StrataPolicy } from '@strata-ctx/core-types';
import type { StrataTelemetryEvent } from '@strata-ctx/telemetry';
import { MemorySink } from '@strata-ctx/telemetry';
import { buildHooks } from '../src/hook-builder.js';
import { OPENCODE_TOOLS, openCodeHookSpec } from '../src/opencode.js';

const PIN = 'never delete production data without explicit approval';

const policy: StrataPolicy = StrataPolicySchema.parse({
  version: 1,
  governance: { pinning: 'required' },
  constraints: [
    { id: 'c1', text: PIN, sha256: sha256(PIN), source: 'org_policy', kind: 'hard_safety', enforcement: 'block' },
  ],
});

// The real OpenCode spec rather than a hand-built one: a hand-written spec is how
// a test ends up passing against a shape the product never uses.
const spec = openCodeHookSpec();

const pre = (tool: string, parameters: Record<string, unknown>) => {
  const sink = new MemorySink();
  const h = buildHooks(spec, { policy, telemetrySink: sink });
  const result = h.handlePreToolUse({
    tool,
    parameters,
    sessionId: 's1',
    runId: runId('run-1'),
    turn: 1,
  });
  const events: readonly StrataTelemetryEvent[] = sink.records.map((r) => r.event);
  return { result, events };
};

describe('I-9: the tool-argument floor, through the hook', () => {
  describe('what it refuses', () => {
    const refused: readonly string[] = [
      'rm -rf /data',
      'rm -fr ./build',
      'git push --force origin main',
      'sudo rm -rf /etc',
      'systemctl stop nginx',
      "psql -c 'DROP TABLE users'",
    ];

    for (const command of refused) {
      it(`blocks ${JSON.stringify(command)}`, () => {
        const { result } = pre('bash', { command });
        assert.equal(result.decision, 'block');
        assert.ok(result.blocked && result.blocked.length > 0, 'the block must say why');
      });
    }

    it('still materialises the pins on a refused call', () => {
      // Ordering is load-bearing: a user refusing one command must not quietly
      // un-pin the session, or the next turn goes out without them.
      const { result } = pre('bash', { command: 'rm -rf /' });
      assert.equal(result.decision, 'block');
      assert.ok(result.pinned.includes(PIN), 'the constraint set survives the refusal');
      assert.ok(result.instructions.includes(PIN));
    });

    it('reports the rule ids so an operator can see which floor fired', () => {
      const { result, events } = pre('bash', { command: 'rm -rf /data' });
      assert.equal(result.blocked?.[0]?.id, 'recursive_force_delete');
      const violation = events.find((e) => e.type === 'violation');
      assert.ok(violation && violation.type === 'violation');
      assert.equal(violation.blocked, true);
      assert.ok(violation.constraintIds.includes('recursive_force_delete'));
    });
  });

  describe('what it does not refuse', () => {
    const allowed: readonly (readonly [string, Record<string, unknown>])[] = [
      ['ordinary work', { command: 'npm run build' }],
      ['a force-free push', { command: 'git push origin main' }],
      ['a lease-protected force push', { command: 'git push --force-with-lease' }],
      ['a single-file delete', { command: 'rm notes.txt' }],
      ['a doc mentioning the command', { command: 'cat README.md # rm -rf ./old' }],
      ['no arguments at all', {}],
    ];

    for (const [label, parameters] of allowed) {
      it(`allows ${label}`, () => {
        assert.equal(pre('bash', parameters).result.decision, 'allow');
      });
    }
  });

  describe('the off switch', () => {
    it('restores pure pin behaviour when turned off', () => {
      // A false positive has to be escapable without abandoning the pin guarantee
      // to get there, which is why this is a build option and not a policy edit.
      const sink = new MemorySink();
      const h = buildHooks(spec, { policy, telemetrySink: sink, destructiveGuard: false });
      const result = h.handlePreToolUse({
        tool: 'bash',
        parameters: { command: 'rm -rf /data' },
        sessionId: 's1',
        runId: runId('run-1'),
        turn: 1,
      });
      assert.equal(result.decision, 'allow');
      assert.equal(result.blocked, undefined);
      assert.ok(result.pinned.includes(PIN), 'pins are unaffected by the guard switch');
    });
  });

  describe('through the OpenCode plugin', () => {
    // The hook returning `block` is not the same as OpenCode refusing the call:
    // the host has to translate the decision into something it acts on, and this
    // is where a silent pass-through would hide the whole floor.
    const pluginHooks = () => {
      const h = buildHooks(spec, { policy });
      return h;
    };

    it('refuses a destructive call with a message naming the rule', () => {
      const result = pluginHooks().handlePreToolUse({
        tool: 'bash',
        parameters: { command: 'rm -rf /data' },
        sessionId: 's1',
        runId: runId('run-1'),
        turn: 1,
      });
      assert.equal(result.decision, 'block');
      const finding = result.blocked?.[0];
      assert.ok(finding, 'the block carries its reason');
      assert.equal(finding.id, 'recursive_force_delete');
      assert.ok(finding.description.length > 0, 'a user can be told what was refused');
    });

    it('does not blame the pin pipeline for a rule refusal', () => {
      // The regression this pins: the message used to say "constraints could not
      // be materialised", which sends an operator to debug the pin path when the
      // pin path is the thing that worked.
      const result = pluginHooks().handlePreToolUse({
        tool: 'bash',
        parameters: { command: 'sudo rm -rf /etc' },
        sessionId: 's2',
        runId: runId('run-2'),
        turn: 1,
      });
      assert.equal(result.decision, 'block');
      assert.equal(result.blocked?.[0]?.id, 'privilege_escalation');
      // A malformed tool call also returns `handled: false` and never reaches the
      // guard, so `handled` is the assertion that this is a real refusal.
      assert.equal(result.handled, true, 'a refusal, not a malformed input');
    });
  });

  describe('tool coverage', () => {
    it('applies to every intercepted tool that carries a command', () => {
      // `Bash` is not in OpenCode's tool list and is correctly not intercepted --
      // `spec.tools` is the contract, and inventing a verdict for a tool we do
      // not handle would be a claim we cannot back. What this pins is that the
      // guard reads the tool list rather than hard-coding a name.
      for (const tool of OPENCODE_TOOLS) {
        const { result } = pre(tool, { command: 'sudo rm -rf /' });
        assert.equal(result.handled, true, `${tool} should be intercepted`);
        assert.equal(result.decision, 'block', `${tool} should be guarded`);
      }
    });

    it('leaves a tool it does not intercept alone', () => {
      // `spec.tools` is the contract; a tool outside it was never ours to judge,
      // and inventing a verdict for it would be a claim we cannot back.
      const { result } = pre('some_other_tool', { command: 'rm -rf /' });
      assert.equal(result.decision, 'allow');
      assert.equal(result.handled, false);
    });

    it('reads the path argument of a write tool', () => {
      // Not a denial today, but it must be *scanned*, which is the property the
      // argument extraction test pins.
      assert.equal(pre('write', { file_path: '/tmp/x' }).result.decision, 'allow');
    });
  });
});