import type { Gist } from '@strata-ctx/core-types';

/**
 * A gist whose raw transcript has not been written, and the two claims it must
 * not make while that is true.
 *
 * The frozen contract fixes both fields and leaves no third place to put the
 * fact: `log_gist.raw_uri` is a required non-empty string
 * (core-types/src/gist.ts:61) and `raw_recoverable` is `z.literal(true)`
 * (core-types/src/gist.ts:102), so `false` is not a schema-valid `Gist` at all.
 * What is left is exactly what the transaction already does: the builder emits
 * a placeholder, and whoever stores the bytes replaces it with the URI the
 * store returned (transaction.ts:387). Until then the URI says in words that
 * there is nothing to point at, and the recoverability claim is left off
 * rather than asserted.
 *
 * `unstored:` rather than `artifact://`: `parseArtifactUri` (acl.ts:203) refuses
 * any other scheme with `bad_scheme`, so a marker cannot be mistaken for a
 * pointer by a store, by `isResolvableArtifactUri`, or by a reader who greps a
 * transcript for `artifact://`.
 */
export const RAW_URI_UNSTORED = 'unstored:raw-transcript';

/**
 * A `Gist` that has not yet been written to a store.
 *
 * Narrower than `Gist` in exactly one place: the recoverability claim may be
 * absent, and when present it is `true`. Optional rather than `boolean` because
 * a draft cannot assert `false` -- that value is not a `Gist` -- so the only
 * two states a caller can build are "claims recovery" and "has not earned it
 * yet".
 */
export type GistDraft = Omit<Gist, 'raw_recoverable'> & {
  readonly raw_recoverable?: true;
};