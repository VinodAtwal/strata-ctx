/**
 * C-14 — the store-backed `ContextMemory`: the MCP recovery path, bound to disk.
 *
 * ## The defect this closes
 *
 * Compaction pointer-izes an oversized read into an `artifact://` URI and the
 * gateway writes the bytes to an `ArtifactStore`. An MCP client holding the
 * in-memory context then asks `get_artifact` for that URI and is told
 * `artifact not found` -- a perfectly good object, reported as missing, because
 * the process answering the question never loaded it. `createInMemoryContext`
 * is a `Map`; it cannot hold what it was never given, and `syncLookup` has no
 * arm for "I could not ask".
 *
 * ## What is composed here, and what is not
 *
 * Everything the MCP surface needs *except* artifact bytes stays on the
 * in-memory store: tasks, notes, remembered facts, search and status are a
 * `Map`-shaped problem, and re-implementing them over a filesystem would buy
 * nothing -- those records are written by the server itself and read back in
 * the same process. Only reads cross the ACL.
 *
 * The artifact read crosses it through `AsyncArtifactReader`, the capability
 * `mcp-server.ts` defines precisely so `ContextMemory` did not have to grow a
 * synchronous lie. `get_artifact` prefers that capability when present, so the
 * store binding is reachable through the same tool, the same handler and the
 * same failure vocabulary as the in-memory one; there is no second server.
 *
 * `getArtifact` therefore *throws* rather than returning `undefined`. It is the
 * one method of `ContextMemory` this binding cannot honour -- the bytes are on
 * disk behind an async ACL -- and returning `undefined` would report the defect
 * above as "not found" a second time, through a different method. A caller that
 * reaches it is a caller that chose the sync path by mistake; the message says
 * which path to take.
 *
 * No cache, deliberately. A digest is already content-addressed, so a second
 * read of the same URI is answered by the filesystem page cache; an application
 * cache here would be a second, unverifiable copy of bytes the store's own
 * `verify` exists to prove.
 */
import { GistSchema } from '@strata-ctx/core-types';
import { recoverEvictedMessages } from '@strata-ctx/gist';
import type { ArtifactStore } from '@strata-ctx/security';
import { ArtifactAclError } from '@strata-ctx/security';

import type {
  ArtifactLookup,
  AsyncArtifactReader,
  AsyncGistRecoverer,
  ContextMemory,
  GistRecoveryResult,
  MemorySeed,
} from './mcp-server.js';
import { createInMemoryContext, parseArtifactRef } from './mcp-server.js';

/** Same wording `syncLookup` gives a ref the parser rejects. One sentence, one definition of malformed. */
const MALFORMED_DETAIL = 'expected artifact://<bucket>/<64 hex sha256> or a bare 64 hex digest';

export const createStoreBackedContext = (
  store: ArtifactStore,
  seed: MemorySeed = {},
): ContextMemory & AsyncArtifactReader & AsyncGistRecoverer => {
  const memory = createInMemoryContext(seed);

  return {
    search: (query) => memory.search(query),
    getTask: (id) => memory.getTask(id),
    addNote: (input) => memory.addNote(input),
    rememberFact: (input) => memory.rememberFact(input),
    status: () => memory.status(),

    getArtifact: (ref) => {
      throw new Error(
        `getArtifact(${JSON.stringify(ref)}) cannot be answered by a store-backed context: the bytes are ` +
          `behind an asynchronous ACL, and this method is synchronous by contract. Use lookupArtifact, ` +
          `or the get_artifact tool, which binds it.`,
      );
    },

    lookupArtifact: async (ref): Promise<ArtifactLookup> => {
      const parsed = parseArtifactRef(ref);
      if (parsed === undefined) {
        return { ok: false, failure: 'malformed_ref', uri: ref, detail: MALFORMED_DETAIL };
      }
      try {
        const result = await store.read(parsed.uri);
        return {
          ok: true,
          artifact: {
            uri: parsed.uri,
            sha256: result.stat.digest,
            bytes: result.stat.bytes,
            kind: result.stat.kind,
            text: result.text,
            createdAt: result.stat.writtenAt,
          },
          integrity: result.integrity,
        };
      } catch (e) {
        // Absent is the store's own refusal, and only that one: a well-formed
        // content-addressed URI with no object behind it raises `not_found`.
        // Everything else -- an unreadable store, a failed audit append, a
        // malformed alias -- means the store did not answer, and reporting it
        // as "missing" is the exact lie this file exists to prevent.
        if (e instanceof ArtifactAclError && e.violation === 'not_found') {
          return { ok: false, failure: 'absent', uri: parsed.uri, detail: e.message };
        }
        return {
          ok: false,
          failure: 'unresolved',
          uri: parsed.uri,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    },

    // `recover_task`'s implementation, and the one call in the product that
    // expands a gist back into the messages compaction dropped. This is the
    // other half of C-14: `get_artifact` resolves a single pointer, this
    // resolves the whole evicted segment, reading the raw transcript the
    // transaction wrote in its step 1 and re-substituting pointerized content.
    //
    // The gist is validated before it is trusted: `recoverEvictedMessages`
    // reads `log_gist.raw_uri` off it and hands it to the store, and an
    // unvalidated object is an attacker-controlled URI -- the same reason the
    // transaction parses its own artifact refs. A malformed gist throws, and the
    // tool wrapper reports it as an execution error rather than an empty result.
    recoverGist: async (gist, options): Promise<GistRecoveryResult> => {
      const parsed = GistSchema.safeParse(gist);
      if (!parsed.success) {
        throw new Error(
          'recover_task: the gist argument is not a valid v1 gist. Pass the object behind a ' +
            '`gist://` pointer, not the pointer string.',
        );
      }
      const recovered = await recoverEvictedMessages(
        parsed.data,
        store,
        options?.strict === true ? { strict: true } : {},
      );
      return {
        messages: recovered.messages,
        digests: recovered.digests,
        resolvedArtifacts: recovered.resolvedArtifacts.map((a) => a.uri),
        missingArtifacts: recovered.missingArtifacts,
        governanceIntact: recovered.governanceIntact,
        complete: recovered.complete,
      };
    },
  };
};
