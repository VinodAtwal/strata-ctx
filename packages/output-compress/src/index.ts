/**
 * The public surface of the output-compression stream.
 *
 * ## Why this barrel is explicit
 *
 * A `export *` from nine modules would publish nine files' worth of internal
 * vocabulary as API, and every one of those names would then be something a
 * downstream package could depend on. The list below is the contract: the
 * operator shape (`applyOutputCompression`), the formats, the per-block pieces a
 * caller may reasonably want to use on their own, and the types needed to talk
 * about any of it.
 *
 * `grammar.ts` is deliberately absent. It is shared machinery for the two
 * format modules and is not part of the contract; `assertFieldName` is re-exported
 * from `table.ts` for the callers that genuinely validate user-supplied names.
 */

// H-8 first: the registry decides which formats exist for a model, so everything
// that takes a `MachineFormat` is downstream of it.
export type {
  MachineFormat,
  ModelRegistry,
  ModelSupport,
  SupportOptions,
  SupportStatus,
} from './registry.js';
export { MACHINE_FORMATS, DEFAULT_REGISTRY, UNKNOWN_MODEL_SUPPORT } from './registry.js';
export {
  modelSupport,
  supportsFormat,
  supportedFormats,
  registryWith,
  registryFrom,
  withSupport,
  describeRegistry,
} from './registry.js';

// H-1 TOON, H-2 TRON, and the shared table grammar they are built on.
export { TOON_MAGIC, TOON_ROW_INDENT, TOON_FRAMING, serializeToon, parseToon } from './toon.js';
export { TRON_MAGIC, TRON_ROW_INDENT, TRON_FRAMING, serializeTron, parseTron } from './tron.js';
export type { TableFraming, TableOptions } from './table.js';
export { headerLine, serializeTable, parseTable, assertFieldName } from './table.js';

// H-2's selector, which is what a caller needs to serialize one value with the
// same rules the stage uses.
export type { Selection, SelectionCode, SelectionInput, Candidate, AttemptRecord } from './select.js';
export { DEFAULT_MIN_SAVINGS_FRAC, selectMachineFormat, selectionSaving } from './select.js';

// H-3 the classifier, exported on its own so a caller can ask the question
// without rewriting anything.
export type { MachineClassification, MachineReason } from './classify.js';
export {
  classifyMachineText,
  classifyMachineBlock,
  isMachineBlock,
  classificationDefect,
  PASSTHROUGH_REASONS,
} from './classify.js';

// H-4 directives: prompt text, never applied to a block.
export type { DirectiveId, DirectiveConfig, RenderedDirectives } from './directives.js';
export {
  DIRECTIVE_ORDER,
  DIRECTIVE_TEXT,
  DIRECTIVE_SUMMARY,
  NO_DIRECTIVES,
  renderDirectives,
  directiveText,
} from './directives.js';

// H-5 cost and the breakeven verdict.
export type { TokenMeasure, FormatSavings, CostVerdict, EpsInput, EpsReport } from './cost.js';
export {
  estimateTextTokens,
  measureText,
  measureFormatSavings,
  measureEps,
  inputReductionFraction,
} from './cost.js';

// H-6 reference instead of inline.
export type { PendingArtifact, ReferencePolicy, ReferenceReport } from './reference.js';
export {
  REFERENCE_MARKER,
  REFERENCE_SCHEME,
  referenceUriFor,
  isReferenced,
  referenceStub,
  referenceOversized,
} from './reference.js';

// H-7 bounded repair.
export type { RepairRequest, RepairResult, RepairPrompt, RepairFailure, RepairAttemptLog } from './repair.js';
export {
  MAX_REPAIR_ATTEMPTS,
  stripEnclosingFence,
  repairFormat,
  repairInstruction,
} from './repair.js';

// The JSON domain, the error type every module in this stream throws, and the
// stage that ties the rest together.
export type { JsonValue, JsonObject, JsonArray, JsonPrimitive } from './json-value.js';
export { MAX_JSON_DEPTH, isJsonValue, assertJsonValue, jsonDefect, jsonEqual } from './json-value.js';
export type { ToonErrorCode } from './errors.js';
export { ToonError, toonError } from './errors.js';

export type { OutputCompressPolicy, CompressInput, CompressResult, CompressReport, BlockAction, BlockDecision } from './compress.js';
export { DEFAULT_POLICY, applyOutputCompression } from './compress.js';
