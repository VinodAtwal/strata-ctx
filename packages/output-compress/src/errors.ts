/**
 * One error type for the whole package, with a machine-readable `code`.
 *
 * Why a code and not just a message: a permissive parser's failure mode is not
 * throwing, it is quietly returning less data than it was given. When it does
 * fail, the caller (H-7's repair loop, the fail-open path in ./compress.ts) has
 * to decide *whether to retry* based on what went wrong, and a prose message is
 * not a decidable input. `unexpected_line` is not repairable by stripping a code
 * fence; `unterminated_string` is not repairable at all. Telemetry needs the
 * code for the same reason.
 *
 * Kept in their own module because ./json-value.ts and ./toon.ts both raise them
 * and neither may import the other.
 */

export type ToonErrorCode =
  /** A number JSON cannot represent, or a value of a type JSON has no encoding for. */
  | 'unsupported_value'
  /** A property name that cannot be written in a table header. */
  | 'unsupported_key'
  /** A Date/Map/class instance/function. JSON.stringify would silently mangle it. */
  | 'not_plain_object'
  | 'circular_reference'
  | 'too_deep'
  /** The value is not a non-empty array of uniform flat records. */
  | 'not_a_table'
  | 'malformed_header'
  | 'malformed_cell'
  | 'unterminated_string'
  /** `a,,b`. We never emit one; a lenient reader would guess null or "". */
  | 'empty_cell'
  | 'row_count_mismatch'
  | 'row_width_mismatch'
  | 'empty_field_name'
  | 'duplicate_field'
  /**
   * TOON only: a data line that does not carry TOON's two-space indent.
   *
   * Deliberately *not* used for a line that appears after the declared row
   * count: that is a `row_count_mismatch`, because the count is what the reader
   * trusts, and an overrun contradicts it whether or not the extra line happens
   * to be indented. TRON has no indent and so cannot raise this at all, which is
   * why it is not shared with it.
   */
  | 'unexpected_line';

export class ToonError extends Error {
  readonly code: ToonErrorCode;
  /** Character offset into the input, when the failure has a position. */
  readonly offset: number | undefined;

  constructor(code: ToonErrorCode, message: string, offset?: number) {
    // The code leads the message so that a log line truncated by a sink still
    // carries the decidable part. `offset` is a character index into the exact
    // string that was passed in, so it stays meaningful to a caller that has
    // that string.
    super(`${code}: ${message}${offset === undefined ? '' : ` (at ${offset})`}`);
    this.name = 'ToonError';
    this.code = code;
    this.offset = offset;
  }
}

export const toonError = (code: ToonErrorCode, message: string, offset?: number): ToonError =>
  new ToonError(code, message, offset);
