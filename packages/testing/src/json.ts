import { z } from 'zod';

/**
 * JSON as a value type, recursively.
 *
 * A fixture is a JSON file, so a body that is not JSON cannot be round-tripped
 * through one. Modelling the restriction in the schema turns "the fixture
 * loaded and the body is now something else" into a load-time error, which is
 * the only version of this that anyone will notice.
 *
 * Key order is *not* part of the value: matching and hashing both go through
 * `hashCanonical`, which sorts keys recursively. A fixture that differs from a
 * live request only in key order is the same request, and treating it as a
 * different one would make every hand-edited fixture a trap.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue, z.ZodTypeDef, JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    // A non-finite number serialises to `null` in JSON, so accepting it would
    // let a fixture file silently disagree with the value it was built from.
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

/**
 * Parses a raw request or response body.
 *
 * An absent body is `null`, which is JSON's own reading of "nothing here" and
 * makes `hashCanonical` agree between recording and replay. Anything that is
 * present but unparseable throws: a body we cannot parse is a body we cannot
 * redact, and an unredacted body is the one failure mode that must never be
 * papered over.
 */
export function parseJsonBody(raw: string, source: string): JsonValue {
  if (raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = JsonValueSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `${source}: body is JSON but not a JSON value (${result.error.issues[0]?.message ?? 'unknown'})`,
      );
    }
    return result.data;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${source}: body is not valid JSON (${err.message})`);
    }
    throw err;
  }
}

/** Two-space-indented JSON with a trailing newline, so fixtures diff cleanly. */
export function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
