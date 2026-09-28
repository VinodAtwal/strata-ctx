import type { Message } from '@strata-ctx/core-types';

/**
 * A-6. Provider-aware token estimation.
 *
 * ## What this is not
 *
 * This is not a tokenizer and nothing here pretends to be one. Each vendor ships
 * a byte-level BPE over a private vocabulary; the vocabulary is per-model, the
 * counts move between model releases without notice, and Anthropic's, OpenAI's
 * and Google's are three unrelated segmenters. Reimplementing any of them
 * offline is out of scope and would be wrong within two model generations.
 *
 * The honest position, and the one core-types already takes in `./tokens.ts`: a
 * ratio estimate is good enough for *budgeting* -- and budgeting is coarse by
 * design, triggers fire at 0.85 of a window and not at 0.851 -- and it is not
 * good enough to quote anywhere. Every published token or dollar figure must
 * come from the provider's own `usage` field, never from here.
 *
 * ## Why per-provider at all
 *
 * core-types takes no provider-specific inputs, so a char/4 estimate is the
 * provider-neutral floor and it lives there. This module is the other half: at
 * the gateway edge we *do* know which provider is on the other end, and the
 * three ratios differ enough that a single number mis-sizes a context window by
 * tens of percent in the wrong direction. A budget computed at 3.5 chars/token
 * against a provider that packs 4.5 under-estimates the prompt, which means the
 * compaction trigger fires late, which means the request fails with a context
 * overflow instead of compacting. Over-estimating is the safe direction: it
 * compacts slightly early and costs a little money.
 *
 * ## The constants
 *
 * | provider    | chars/token | non-ASCII weight | per block | per message | reply priming |
 * |-------------|-------------|------------------|-----------|--------------|---------------|
 * | `anthropic` | 3.5         | 2.0              | 3         | 4            | 3             |
 * | `openai`    | 4.0         | 2.0              | 2         | 3            | 3             |
 * | `gemini`    | 4.5         | 1.5              | 1         | 2            | 2             |
 *
 * - **chars/token.** The folklore floor everywhere is "1 token ~= 4 chars" for
 *   English prose. Agent context is not English prose: it is code, JSON, stack
 *   traces and tool output, all of which pack into *fewer* characters per token
 *   because the merges are long and repetitive. 3.5 is the aggressive end of
 *   that for a byte-level BPE, 4.0 the middle, and 4.5 the conservative end
 *   appropriate to a very large sentencePiece vocabulary.
 * - **non-ASCII weight**, in ASCII-equivalent characters, charged once per
 *   *code point* (not per UTF-16 code unit -- see `isAscii`). A CJK ideograph is
 *   one BPE token on its own or two at worst, versus roughly 3.5 ASCII
 *   characters, so 2.0 is a fair charge. 1.5 for Gemini reflects a 256k-entry
 *   vocabulary that has seen a lot of multilingual text.
 * - **per block.** The `type` discriminator and the block delimiters a provider
 *   puts on the wire. Anthropic carries a typed envelope per block, the
 *   tool_use envelope is the fat case, and this matches
 *   `PER_BLOCK_OVERHEAD_TOKENS` in core-types' `./tokens.ts`.
 * - **per message.** Role marker plus message delimiters. Gemini's `user:` /
 *   `model:` turns are the bare form, so it is the cheapest of the three.
 * - **reply priming.** Charged once per request, not per message: the assistant
 *   turn is prefixed by a control preamble before the model can emit anything.
 *   The 3-token figure is the widely quoted chat-completions preamble. An empty
 *   conversation is charged nothing, because nothing is being replied to.
 *
 * None of this is folklore we are willing to defend indefinitely.
 * TODO(WS-A, A-6): every row above should be re-fitted from recorded
 * `usage.input_tokens` against our own traffic (the WS-F harness can produce the
 * corpus) and the error curve reported per provider. Until that exists these are
 * engineering judgement, and they are labelled as such wherever they surface.
 */

/** The providers this module carries a ratio for. */
export type TokenProvider = 'anthropic' | 'openai' | 'gemini';

/** Runtime-iterable form, for config validation and for tests. */
export const TOKEN_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
] as const satisfies readonly TokenProvider[];

/**
 * Used when a provider key is not one we know. The gateway is configured from
 * a YAML file (`upstream: anthropic # or gemini | openai-compat`) and that key
 * is not a typechecked call site, so a typo or an adapter we have not written
 * yet is a runtime reality. Degrading to a documented default is right here: a
 * slightly wrong ratio costs a slightly early compaction, and throwing would
 * 502 a request the gateway is otherwise able to serve.
 */
export const DEFAULT_PROVIDER: TokenProvider = 'anthropic';

export interface ProviderTokenProfile {
  readonly provider: TokenProvider;
  /** ASCII characters per token. See the table in the module header. */
  readonly charsPerToken: number;
  /** Charge for one non-ASCII code point, in ASCII-equivalent characters. */
  readonly nonAsciiCharWeight: number;
  /** Envelope cost of one content block. */
  readonly perBlockOverhead: number;
  /** Envelope cost of one message. */
  readonly perMessageOverhead: number;
  /** Once per request, for a non-empty conversation. */
  readonly replyOverhead: number;
}

const ANTHROPIC_PROFILE: ProviderTokenProfile = Object.freeze({
  provider: 'anthropic',
  charsPerToken: 3.5,
  nonAsciiCharWeight: 2,
  perBlockOverhead: 3,
  perMessageOverhead: 4,
  replyOverhead: 3,
});

const OPENAI_PROFILE: ProviderTokenProfile = Object.freeze({
  provider: 'openai',
  charsPerToken: 4,
  nonAsciiCharWeight: 2,
  perBlockOverhead: 2,
  perMessageOverhead: 3,
  replyOverhead: 3,
});

const GEMINI_PROFILE: ProviderTokenProfile = Object.freeze({
  provider: 'gemini',
  charsPerToken: 4.5,
  nonAsciiCharWeight: 1.5,
  perBlockOverhead: 1,
  perMessageOverhead: 2,
  replyOverhead: 2,
});

/**
 * Deliberately typed as `Record<string, ...>` rather than `Record<TokenProvider, ...>`:
 * the fallback in `providerProfile` has to be a real runtime possibility, not a
 * branch the type system has already proven unreachable. Keyed by an unknown
 * string, the index genuinely is `| undefined` and the default genuinely is
 * doing work.
 */
const PROFILES: Readonly<Record<string, ProviderTokenProfile>> = Object.freeze({
  anthropic: ANTHROPIC_PROFILE,
  openai: OPENAI_PROFILE,
  gemini: GEMINI_PROFILE,
});

export function providerProfile(provider: TokenProvider): ProviderTokenProfile {
  return PROFILES[provider] ?? ANTHROPIC_PROFILE;
}

/* -------------------------------------------------------------------------- */
/* The estimate                                                                */
/* -------------------------------------------------------------------------- */

const ASCII_LIMIT = '\u007f';

/**
 * A single code point, as `for..of` yields it.
 *
 * The unit matters. `String.length` counts UTF-16 code units, so an emoji is
 * 2 and a combining accent is 1, and neither corresponds to anything a
 * tokenizer sees. Iterating by code point charges a grapheme that happens to be
 * a surrogate pair once, which is closer to the truth and is at least a unit
 * with a defensible definition.
 */
const isAscii = (ch: string): boolean => ch <= ASCII_LIMIT;

/**
 * Billable characters, i.e. the ASCII-equivalent width of `text`.
 *
 * The running sum is a sum of `1`s and of `nonAsciiCharWeight`s only. Both
 * weights are exactly representable in binary floating point (2 = 2, 1.5 = 1 + 1/2)
 * and the magnitudes here are far below 2^53, so the sum cannot lose a ULP and
 * the accumulation order cannot matter. That is what makes `estimateTokens`
 * provably monotonic: the units of a prefix are never greater than the units of
 * the string, and `Math.ceil` is itself non-decreasing.
 */
const billableChars = (text: string, nonAsciiCharWeight: number): number => {
  let units = 0;
  for (const ch of text) units += isAscii(ch) ? 1 : nonAsciiCharWeight;
  return units;
};

/**
 * Estimated tokens in `text`, for `provider`. Zero for an empty string, and an
 * integer for anything else.
 *
 * Deterministic and side-effect free: the same arguments always produce the same
 * number, which is a product requirement (N6) and is also what lets the
 * compaction trigger be tested at all.
 */
export function estimateTokens(text: string, provider: TokenProvider): number {
  const profile = providerProfile(provider);
  return Math.ceil(billableChars(text, profile.nonAsciiCharWeight) / profile.charsPerToken);
}

/**
 * Estimated tokens for a whole conversation, in the canonical shape the gateway
 * holds after an adapter has run.
 *
 * `Σ_blocks (estimateTokens(block.text) + perBlockOverhead) + perMessageOverhead`,
 * summed over messages, plus the reply priming once at the end. An empty
 * conversation is 0 and is not charged the priming: there is no reply to it.
 *
 * Blocks are measured separately, each with its own rounding, rather than by
 * concatenating the message. A four-block tool turn really does pay four
 * envelope costs, and rounding per block is what a vendor does too.
 */
export function countMessageTokens(messages: readonly Message[], provider: TokenProvider): number {
  const profile = providerProfile(provider);
  let total = 0;
  for (const message of messages) {
    let perMessage = profile.perMessageOverhead + message.content.length * profile.perBlockOverhead;
    for (const block of message.content) {
      // A block with no text projection (an image reference, say) costs its
      // envelope and nothing else. `?? ''` rather than a truthiness check so a
      // deliberately empty block is not silently conflated with an absent one.
      perMessage += estimateTokens(block.text ?? '', provider);
    }
    total += perMessage;
  }
  return messages.length === 0 ? 0 : total + profile.replyOverhead;
}

/* -------------------------------------------------------------------------- */
/* The mock                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A pre-programmed estimator for tests.
 *
 * The point is not to test the arithmetic -- the arithmetic is covered by the
 * tests above -- but to stop the rest of the suite from depending on it. If a
 * gateway test asserts "this request costs 412 tokens", it is asserting our
 * chars-per-token constant as much as it is asserting the gateway, and every
 * retune of that constant (see the TODO in the module header) turns into a
 * failing test in a package that has nothing to do with it. Against a mock the
 * assertion is about the gateway.
 *
 * The mock is provider-blind on purpose: it ignores the provider entirely, which
 * is what proves a test is not quietly sensitive to the ratio. The provider is
 * still recorded in `calls`, so a test can assert it was threaded through.
 */
export interface MockTokenProgram {
  /** Exact text -> token count for `estimateTokens`. Checked before anything else. */
  readonly byText?: Readonly<Record<string, number>>;
  /** Message count -> token count for `countMessageTokens`. */
  readonly byMessageCount?: Readonly<Record<number, number>>;
  /** Returned for any input not programmed above. Defaults to 0. */
  readonly fallback?: number;
  /**
   * Throw on an unprogrammed input instead of returning `fallback`. Default
   * false. Worth turning on in tests that care about a specific number: a
   * fallback is a test that quietly asserts "0" and passes for the wrong reason.
   */
  readonly strict?: boolean;
}

export type MockTokenCall =
  | {
      readonly method: 'estimateTokens';
      readonly provider: TokenProvider;
      /** First 48 characters of the input, enough to identify it in a failure. */
      readonly preview: string;
      readonly chars: number;
    }
  | {
      readonly method: 'countMessageTokens';
      readonly provider: TokenProvider;
      readonly messages: number;
    };

const PREVIEW_LIMIT = 48;

const preview = (text: string): string => text.slice(0, PREVIEW_LIMIT);

/**
 * `Object.entries` rather than an index expression, and the reason is not
 * style: a bare `program.byText[text]` on a plain object finds
 * `Object.prototype.toString` when the text happens to be the string
 * `"toString"`, and a mock that returns a function where a number belongs is
 * worse than no mock at all. Own enumerable keys only, both tables.
 */
function textProgram(source: MockTokenProgram['byText']): Map<string, number> {
  if (source === undefined) return new Map();
  return new Map(Object.entries(source));
}

function countProgram(source: MockTokenProgram['byMessageCount']): Map<number, number> {
  if (source === undefined) return new Map();
  return new Map(Object.entries(source).map(([k, v]): [number, number] => [Number(k), v]));
}

export class MockTokenEstimator {
  private readonly byText: Map<string, number>;
  private readonly byMessageCount: Map<number, number>;
  private readonly fallback: number;
  private readonly strict: boolean;
  private readonly log: MockTokenCall[] = [];

  constructor(program: MockTokenProgram = {}) {
    this.byText = textProgram(program.byText);
    this.byMessageCount = countProgram(program.byMessageCount);
    this.fallback = program.fallback ?? 0;
    this.strict = program.strict ?? false;
  }

  /** Everything this estimator has been asked, in order. A frozen copy. */
  get calls(): readonly MockTokenCall[] {
    return Object.freeze([...this.log]);
  }

  /** Drops the call log. The programmed values are not affected. */
  reset(): void {
    this.log.length = 0;
  }

  estimateTokens(text: string, provider: TokenProvider): number {
    this.log.push({
      method: 'estimateTokens',
      provider,
      preview: preview(text),
      chars: text.length,
    });
    // `!== undefined` rather than a truthiness check: 0 is a perfectly good
    // programmed value and a `||` here would hand back the fallback instead.
    const hit = this.byText.get(text);
    if (hit !== undefined) return hit;
    return this.resolve(`text ${JSON.stringify(preview(text))}`);
  }

  countMessageTokens(messages: readonly Message[], provider: TokenProvider): number {
    this.log.push({ method: 'countMessageTokens', provider, messages: messages.length });
    const hit = this.byMessageCount.get(messages.length);
    if (hit !== undefined) return hit;
    return this.resolve(`${messages.length} messages`);
  }

  private resolve(what: string): number {
    if (this.strict) {
      throw new Error(`MockTokenEstimator: nothing programmed for ${what} and strict is on`);
    }
    return this.fallback;
  }
}
