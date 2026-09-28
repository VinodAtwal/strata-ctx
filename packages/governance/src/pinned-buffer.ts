import type {
  ContextState,
  Gist,
  PinApplication,
  PinIntegrity,
  PinnedConstraint,
  StrataPolicy,
} from '@strata-ctx/core-types';
import {
  collectGovernanceText,
  enforcePins,
  pinDrift,
  pinSetText,
  verifyPinIntegrity,
} from '@strata-ctx/core-types';
import { pinHashOf, type PolicyStore } from './policy-store.js';
import { ViolationRecorder, type ViolationRecord } from './violations.js';

/**
 * D-1/D-2/D-5: the pinned buffer, applied on every outbound request.
 *
 * docs/architecture.md §7 gives three properties and each one is implemented
 * here rather than described in a comment somewhere else:
 *
 * 1. **Replace, never merge.** `apply` overwrites the buffer wholesale from an
 *    immutable snapshot. A gist or a summary that *appends* to `pinned` could
 *    inject text that reads like policy; overwriting makes that structurally
 *    impossible. The work is `enforcePins` in core-types, which also
 *    materialises the buffer as real governance-tier blocks -- a buffer nothing
 *    reads is a comment, and that bug shipped once.
 * 2. **Record on the pre-apply check.** A constraint that is already missing
 *    when we get here was removed by something upstream. That is a P0 event.
 * 3. **Every turn, not just at compaction.** Decay scales with compaction
 *    aggressiveness, but the mechanism is generic and the check is free.
 *
 * ## What the missing-check can and cannot see
 *
 * The structural guarantee does not depend on any of this: the buffer is
 * re-applied from the immutable snapshot on every outbound request, so what the
 * provider sees is the policy text whatever the client did with it. The
 * pre-apply check is diagnostic, and diagnostics are only as good as what they
 * can observe:
 *
 * - **Injected text is always a finding.** The governance channel has exactly
 *   one legitimate writer and it is us, so undeclared text there is a finding
 *   on the first turn as well. This is the Compaction-Eviction Attack trying to
 *   install a rule of its own (Governance Decay: optimised injection defeats all
 *   models, 0% -> 65%).
 * - **Damage to `state.pinned` is always a finding.** That field is ours; if it
 *   arrives non-empty and incomplete, something removed a constraint.
 * - **Damage to the *echoed* governance message is checked only when the client
 *   claims to carry one** (`expectsEcho`). Not every agent round-trips our
 *   system message -- the Copilot MCP-only path never will -- and a check that
 *   fires forever on a client that cannot satisfy it is a check that gets
 *   switched off. So the caller states the client contract, and the buffer
 *   believes it.
 */

export interface PinnedBufferOptions {
  readonly recorder?: ViolationRecorder;
  /**
   * True when the agent echoes the system prompt back on every request, so a
   * constraint that vanished from it really did vanish. Anthropic and Gemini
   * sessions do; MCP-only integrations do not.
   */
  readonly expectsEcho?: boolean;
}

export interface PinApplicationResult extends PinApplication {
  /** Violations raised by this call, oldest first. */
  readonly violations: readonly ViolationRecord[];
  /**
   * Damage found in the *inbound* context, or null when the client does not
   * echo the buffer and the check does not apply. Never about the buffer we are
   * about to send: that one is immutable.
   */
  readonly drift: PinIntegrity | null;
  /**
   * Whether the inbound context actually carried any of our governance text:
   * `null` before the second turn, `false` for a client that does not echo.
   * Telemetry, not a violation -- an agent that does not echo has not violated
   * anything, it just cannot be checked this way.
   */
  readonly echoObserved: boolean | null;
}

export type CompactionDecision = 'commit' | 'abort_keep_transcript';

export interface ReassertOptions {
  /**
   * True when the context handed to the compactor carried the pin set.
   *
   * `reassert` runs at step 6, mid-transaction, so the caller knows this and the
   * result does not. It only matters for the eviction that drops governance
   * from the message list without touching the gist: after such a compaction
   * both the message list and `state.pinned` can be empty, which is
   * indistinguishable from a context that never carried the buffer. Default
   * (`undefined`) infers it from those two channels, which is right whenever the
   * gateway does populate `pinned`; passing it explicitly is what catches an
   * eviction on a gateway that rebuilds `ContextState` from the wire.
   */
  readonly carriedGovernance?: boolean | undefined;
}

export interface ReassertionResult {
  readonly ok: boolean;
  readonly action: CompactionDecision;
  /**
   * Always pin-complete, even when `ok` is false: the request that goes out
   * carries the policy either way. What `ok` decides is whether the *eviction*
   * may be committed.
   */
  readonly state: ContextState;
  readonly violations: readonly ViolationRecord[];
  readonly integrity: PinIntegrity | null;
}

export class PinnedBuffer {
  readonly #texts: readonly string[];
  readonly #constraints: readonly PinnedConstraint[];
  readonly #pinHash: string;
  readonly #recorder: ViolationRecorder;
  readonly #expectsEcho: boolean;
  /** What we last put on the wire, or null before the first `apply`. */
  #lastSent: readonly string[] | null = null;
  #echoObserved: boolean | null = null;

  constructor(
    readonly policy: StrataPolicy,
    options: PinnedBufferOptions = {},
  ) {
    this.#texts = Object.freeze(pinSetText(policy));
    this.#constraints = Object.freeze([...policy.constraints]);
    this.#pinHash = pinHashOf(policy);
    this.#recorder = options.recorder ?? new ViolationRecorder();
    this.#expectsEcho = options.expectsEcho ?? false;
  }

  static fromStore(store: PolicyStore, options: PinnedBufferOptions = {}): PinnedBuffer {
    return new PinnedBuffer(store.policy, options);
  }

  get size(): number {
    return this.#texts.length;
  }
  get texts(): readonly string[] {
    return this.#texts;
  }
  get constraints(): readonly PinnedConstraint[] {
    return this.#constraints;
  }
  /** The hash step 4c compares byte-wise. */
  get pinHash(): string {
    return this.#pinHash;
  }
  get recorder(): ViolationRecorder {
    return this.#recorder;
  }
  get violations(): readonly ViolationRecord[] {
    return this.#recorder.log.all();
  }
  /** What this buffer last sent, or null before the first `apply`. */
  get lastSent(): readonly string[] | null {
    return this.#lastSent;
  }
  get echoObserved(): boolean | null {
    return this.#echoObserved;
  }

  idsFor(texts: readonly string[]): readonly string[] {
    const byId = new Map(this.#constraints.map((c) => [c.text, c.id]));
    return texts.map((t) => byId.get(t) ?? `unknown:${t.slice(0, 12)}`);
  }

  /** What this context claims to be carrying in the governance channel. */
  #carried(state: ContextState): { readonly pinned: readonly string[]; readonly inbound: readonly string[] } {
    return { pinned: state.pinned, inbound: collectGovernanceText(state) };
  }

  /**
   * Stage 4. Must be called on every outbound request, after every transform.
   * Final_Context = Compact(H) u P.
   */
  apply(state: ContextState): PinApplicationResult {
    const ctx = { runId: state.runId, turn: state.turn };
    const violations: ViolationRecord[] = [];
    const buffer = new Set(this.#texts);
    const { pinned, inbound } = this.#carried(state);

    // 1. Injected text. The only legitimate writer of the governance channel is
    //    us, so undeclared text is a finding on turn 1 as well.
    const injected = [...pinned, ...inbound].filter((t) => !buffer.has(t));
    if (injected.length > 0) {
      violations.push(
        this.#recorder.record(
          {
            kind: 'pin_injected_text',
            severity: 'P0',
            constraintIds: [],
            detail: `${injected.length} undeclared text(s) in the governance channel: ${injected
              .map((t) => `${t.length}b/${t.slice(0, 24).replace(/\s+/g, ' ')}`)
              .join(' | ')}`,
          },
          ctx,
        ),
      );
    }

    // 2. Damage to our own buffer field. Empty means "nobody populated it",
    //    which is unverifiable rather than a violation; non-empty and short is
    //    damage.
    const carriedPins = new Set([...pinned, ...inbound]);
    const lostPins = pinned.length > 0 ? this.#texts.filter((t) => !carriedPins.has(t)) : [];
    if (lostPins.length > 0) {
      violations.push(
        this.#recorder.record(
          {
            kind: 'pin_missing_pre_apply',
            severity: 'P0',
            constraintIds: this.idsFor(lostPins),
            detail: `${lostPins.length} constraint(s) missing before the pin stage ran`,
          },
          ctx,
        ),
      );
    }

    // 3. The echoed governance message, when this client claims to send one.
    let drift: PinIntegrity | null = null;
    if (this.#expectsEcho && this.#lastSent !== null) {
      const arrived = this.#texts.filter((t) => inbound.includes(t)).length;
      this.#echoObserved = this.#texts.length === 0 ? true : arrived > 0;
      if (this.#echoObserved) {
        drift = pinDrift(this.#lastSent, inbound);
        if (!drift.ok) {
          for (const [kind, label] of [
            ['missing', 'did not come back'],
            ['extra', 'came back undeclared'],
            ['reordered', 'came back out of order'],
          ] as const) {
            const defects = drift.defects.filter((d) => d.kind === kind);
            if (defects.length === 0) continue;
            violations.push(
              this.#recorder.record(
                {
                  kind: kind === 'extra' ? 'pin_injected_text' : 'pin_missing_pre_apply',
                  severity: 'P0',
                  constraintIds: kind === 'extra' ? [] : this.idsFor(defects.map((d) => d.text)),
                  detail: `${defects.length} constraint(s) ${label}: ${this.idsFor(defects.map((d) => d.text)).join(', ')}`,
                },
                ctx,
              ),
            );
          }
        }
      }
    }

    const applied = enforcePins(state, this.policy);
    this.#lastSent = applied.expected;
    return { ...applied, violations, drift, echoObserved: this.#echoObserved };
  }

  /**
   * D-5: re-assertion after compaction. This is the transaction's step 6, and
   * the runtime cross-check on step 4c.
   *
   * The returned state always carries the full policy. `ok` is the commit
   * decision for the *transaction*: false means "abort and keep the
   * transcript", which is docs/architecture.md §5's instruction to fail toward
   * more context.
   */
  reassert(
    state: ContextState,
    gist?: Gist,
    options: ReassertOptions = {},
  ): ReassertionResult {
    const ctx = { runId: state.runId, turn: state.turn };
    const violations: ViolationRecord[] = [];
    let ok = true;
    let integrity: PinIntegrity | null = null;

    if (gist !== undefined) {
      // Step 4c. A gist's `constraints` field is a verification target, not a
      // writable field: if it does not byte-equal the pin set, something in the
      // summarizer path lost or rewrote policy and the eviction must not
      // happen.
      const result = verifyPinIntegrity(this.#texts, gist.constraints);
      integrity = result;
      if (!result.ok) {
        ok = false;
        for (const [kind, label] of [
          ['missing', 'is missing'],
          ['extra', 'carries undeclared'],
          ['reordered', 'reordered'],
        ] as const) {
          const defects = result.defects.filter((d) => d.kind === kind);
          if (defects.length === 0) continue;
          violations.push(
            this.#recorder.record(
              {
                kind: kind === 'extra' ? 'pin_injected_text' : 'pin_post_compact_missing',
                severity: 'P0',
                // Same rule as the pre-apply path: an undeclared rule has no id.
                // Minting `unknown:<prefix>` here would make two different
                // injections that share a prefix collide on one key, so the log
                // could not tell them apart.
                constraintIds: kind === 'extra' ? [] : this.idsFor(defects.map((d) => d.text)),
                detail: `gist for task ${gist.task_id} ${label} ${defects.length} constraint(s)`,
                blocked: true,
              },
              ctx,
            ),
          );
        }
      }
    }

    // Belt-and-braces with step 4c: the state the compactor handed back is
    // itself checked, because a compactor can drop a pin from the message list
    // without ever touching the gist.
    //
    // "Was carrying it" cannot be inferred reliably. A gateway that rebuilds
    // ContextState from the wire has no way to populate `pinned` -- it is our
    // bookkeeping, not the client's -- so a compactor that evicts the governance
    // message leaves both channels empty and looks exactly like a context that
    // never had one. Guessing "yes" for every empty context would fire on every
    // non-echoing client, and a check that fires forever gets switched off; so
    // the caller states it, the same way `expectsEcho` states the client
    // contract. See ReassertOptions.
    const { pinned, inbound } = this.#carried(state);
    const carried = new Set([...pinned, ...inbound]);
    const wasCarrying = options.carriedGovernance ?? (pinned.length > 0 || inbound.length > 0);
    if (wasCarrying) {
      const lost = this.#texts.filter((t) => !carried.has(t));
      if (lost.length > 0) {
        ok = false;
        const survived = verifyPinIntegrity(
          this.#texts,
          [...carried].filter((t) => this.#texts.includes(t)),
        );
        integrity = integrity ?? survived;
        violations.push(
          this.#recorder.record(
            {
              kind: 'pin_post_compact_missing',
              severity: 'P0',
              constraintIds: this.idsFor(lost),
              detail: `${lost.length} constraint(s) did not survive compaction`,
              blocked: true,
            },
            ctx,
          ),
        );
      }
    }

    const applied = this.apply(state);
    violations.push(...applied.violations);
    return {
      ok,
      action: ok ? 'commit' : 'abort_keep_transcript',
      state: applied.state,
      violations,
      integrity,
    };
  }

  /** The step-4c comparison, from the buffer this request actually used. */
  matches(gist: Gist): PinIntegrity {
    return verifyPinIntegrity(this.#texts, gist.constraints);
  }
}
