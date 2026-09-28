import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  FIXTURE_FORMAT_VERSION,
  FixtureExistsError,
  FixtureValidationError,
  FixtureVersionError,
  loadFixtureDir,
  loadFixtureFile,
  parseFixtureFile,
  renderSseStream,
  responseBytes,
  serializeFixtureFile,
  summarizeFixtureFile,
  writeFixtureFile,
} from '../src/index.js';

import { RECORDED_AT, dataFrame, entry, fixtureFile, frame, jsonResponse, sseResponse, tempDir } from './fixtures.js';

describe('fixture format: versioning', () => {
  it('rejects a fixture from a different format version, and says so', () => {
    // The whole reason the version exists. A v0 fixture read by a v1 harness
    // parses under the wrong assumptions, and the suite is green while testing
    // nothing -- the worst outcome a harness has.
    assert.throws(
      () => parseFixtureFile(fixtureFile({ version: 0 })),
      (err: unknown) => {
        assert.ok(err instanceof FixtureVersionError, `got ${String(err)}`);
        assert.match(err.message, /fixture format version 0/);
        assert.match(err.message, /reads version 1/);
        return true;
      },
    );
  });

  it('rejects a fixture from the future for the same reason', () => {
    assert.throws(() => parseFixtureFile(fixtureFile({ version: 99 })), FixtureVersionError);
  });

  it('reports a version problem as a version problem, not a missing-key complaint', () => {
    // A bare `safeParse` would say "expected 1, received 2" buried in a zod issue
    // list. The explicit pre-check runs first so the message is about the
    // harness being wrong, and names the file so the bad artifact is findable.
    try {
      parseFixtureFile({ fixtureFormatVersion: 2, provider: 'p', name: 'n', entries: [] }, 'turns.json');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof FixtureVersionError);
      assert.ok(!(err instanceof FixtureValidationError), 'the two classes stay distinguishable');
      assert.match(err.message, /turns\.json/);
    }
  });

  it('reports a missing version as a schema problem, not a version problem', () => {
    // A document with no version is a corrupt file, not an old one, and the two
    // call for different responses from whoever holds it.
    const corrupt: Record<string, unknown> = { ...fixtureFile() };
    delete corrupt['fixtureFormatVersion'];
    assert.throws(() => parseFixtureFile(corrupt), FixtureValidationError);
  });

  it('rejects a version that is not a number', () => {
    assert.throws(() => parseFixtureFile({ ...fixtureFile(), fixtureFormatVersion: '1' }), FixtureValidationError);
  });

  it('accepts the version this harness writes', () => {
    assert.equal(parseFixtureFile(fixtureFile()).fixtureFormatVersion, FIXTURE_FORMAT_VERSION);
  });
});

describe('fixture format: strictness', () => {
  it('rejects an unknown key rather than stripping it', () => {
    // zod strips unknown keys by default. A dropped field or a misspelled
    // `delayMs` would replay something the provider never said, so every object
    // in the format is `.strict()`.
    try {
      parseFixtureFile({ ...fixtureFile(), experimental: true });
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof FixtureValidationError);
      assert.ok(
        err.issues.some((i) => i.includes('experimental')),
        `issues should name the key: ${err.issues.join(' | ')}`,
      );
    }
  });

  it('rejects a canonicalHash that is not a lowercase sha256', () => {
    const bad = ['abc', 'A'.repeat(64), 'z'.repeat(64), `${'0123456789abcdef'.repeat(4)}GG`];
    for (const canonicalHash of bad) {
      const base = entry();
      const tampered = { ...base, request: { ...base.request, canonicalHash } };
      assert.throws(
        () => parseFixtureFile(fixtureFile({ entries: [tampered] })),
        FixtureValidationError,
        `accepted ${canonicalHash.slice(0, 12)}...`,
      );
    }
  });

  it('rejects a relative path and a lowercase method', () => {
    const e = entry({ path: 'v1/messages', method: 'post' });
    assert.throws(() => parseFixtureFile(fixtureFile({ entries: [e] })), FixtureValidationError);
  });

  it('rejects a fixture with no entries', () => {
    // A fixture that replays nothing is a file that makes every test miss.
    assert.throws(() => parseFixtureFile(fixtureFile({ entries: [] })), FixtureValidationError);
  });

  it('rejects an unknown response kind', () => {
    const e = entry();
    const tampered = { ...fixtureFile(), entries: [{ ...e, response: { ...e.response, kind: 'protobuf' } }] };
    assert.throws(() => parseFixtureFile(tampered), FixtureValidationError);
  });

  it('rejects a non-ISO timestamp', () => {
    assert.throws(() => parseFixtureFile(fixtureFile({ recordedAt: '11/02/2026' })), FixtureValidationError);
  });

  it('rejects a stream frame that omits `data` entirely', () => {
    // `data: null` means "the frame carried no data field". An absent key is
    // ambiguous between that and a typo, so the schema insists it be said.
    const withMissingData: Record<string, unknown> = { ...frame() };
    delete withMissingData['data'];
    const tampered = { ...fixtureFile(), entries: [{ ...entry(), response: { ...entry().response, events: [withMissingData] } }] };
    assert.throws(() => parseFixtureFile(tampered), FixtureValidationError);
  });

  it('accepts an empty SSE stream', () => {
    // A provider that fails before its first event returns a 200 with an empty
    // body. Refusing to record it would make the interesting case untestable.
    const parsed = parseFixtureFile(fixtureFile({ entries: [entry({ events: [] })] }));
    const only = parsed.entries[0]?.response;
    assert.equal(only?.kind, 'sse');
    assert.equal(only?.kind === 'sse' ? only.events.length : -1, 0);
  });
});

describe('fixture format: loading from disk', () => {
  it('names the file and the JSON error when the file is not JSON', (t) => {
    const dir = tempDir(t);
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json', 'utf8');
    assert.throws(
      () => loadFixtureFile(path),
      (err: unknown) => {
        assert.ok(err instanceof FixtureValidationError);
        assert.match(err.message, /not valid JSON/);
        assert.match(err.message, /broken\.json/);
        return true;
      },
    );
  });

  it('returns fixtures in a sorted, filesystem-order-independent list', (t) => {
    // `readdirSync` order is filesystem-dependent. A list that reorders between
    // machines turns every diff into noise and any order-dependent replay into
    // a flake with extra steps.
    const dir = tempDir(t);
    for (const name of ['zulu.json', 'alpha.json', 'mike.json']) {
      writeFileSync(join(dir, name), serializeFixtureFile(fixtureFile({ name })), 'utf8');
    }
    writeFileSync(join(dir, 'notes.txt'), 'ignored', 'utf8');

    const loaded = loadFixtureDir(dir);
    assert.deepEqual(
      loaded.map((l) => l.path),
      [join(dir, 'alpha.json'), join(dir, 'mike.json'), join(dir, 'zulu.json')],
    );
    assert.deepEqual(
      loaded.map((l) => l.file.name),
      ['alpha.json', 'mike.json', 'zulu.json'],
    );
  });

  it('refuses a directory wearing a .json name instead of an EISDIR trace', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'real.json'), serializeFixtureFile(fixtureFile()), 'utf8');
    mkdirSync(join(dir, 'nested.json'));

    assert.throws(() => loadFixtureDir(dir), (err: unknown) => {
      assert.ok(err instanceof FixtureValidationError);
      assert.match(err.message, /not a file/);
      return true;
    });
  });
});

describe('fixture format: writing', () => {
  it('refuses to overwrite a reviewed fixture unless told to', (t) => {
    // Re-recording over a good fixture without a human noticing is how a good
    // fixture becomes a bad one and every test still passes.
    const dir = tempDir(t);
    const path = join(dir, 'turn.json');
    writeFixtureFile(path, fixtureFile({ name: 'turn' }));

    assert.throws(() => writeFixtureFile(path, fixtureFile({ name: 'other' })), FixtureExistsError);
    assert.throws(() => writeFixtureFile(path, fixtureFile({ name: 'other' })), /overwrite: true/);
    assert.doesNotThrow(() => writeFixtureFile(path, fixtureFile({ name: 'other' }), { overwrite: true }));
  });

  it('writes a file it can read back identically', (t) => {
    const dir = tempDir(t);
    const path = join(dir, 'round.json');
    const file = fixtureFile({ name: 'round', recordedAt: RECORDED_AT, entries: [entry({ name: 'turn-1' })] });
    writeFixtureFile(path, file);

    const reloaded = loadFixtureFile(path);
    assert.deepEqual(reloaded, file);
    assert.equal(serializeFixtureFile(reloaded), serializeFixtureFile(file), 'stable bytes');
  });

  it('validates on the way out, not only on the way in', (t) => {
    // A caller that hand-builds a fixture in TypeScript can still get the shape
    // wrong, and a malformed file on disk is discovered by whoever runs the
    // suite next. Catching it at the write is one person earlier.
    const dir = tempDir(t);
    const path = join(dir, 'bad.json');
    const base = entry();
    const broken = { ...fixtureFile(), entries: [{ ...base, request: { ...base.request, canonicalHash: 'nope' } }] };

    assert.throws(() => writeFixtureFile(path, broken), FixtureValidationError);
    assert.throws(() => readFileSync(path, 'utf8'), /ENOENT/, 'nothing was written');
  });

  it('ends with a newline so the file diffs cleanly', () => {
    const text = serializeFixtureFile(fixtureFile());
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.includes('\n  "provider"'), 'two-space indent');
  });
});

describe('fixture format: byte accounting', () => {
  it('agrees with the renderer on frames carrying an empty field value', () => {
    // Regression. `responseBytes` used to be a second implementation of the SSE
    // framing rules and counted the space after `data:` on an empty payload,
    // while `sse.ts` correctly omits it. A byte count that disagrees with the
    // bytes a client receives is worse than none, because a test asserting
    // against it is asserting against a fiction.
    const events = [dataFrame(''), dataFrame('{"a":1}'), frame({ event: '', data: '' })];
    assert.equal(responseBytes(sseResponse(events)), renderSseStream(events, '\n').byteLength);
  });

  it('counts JSON bodies as the serialised replay will emit them', () => {
    const response = jsonResponse({ a: 1, b: [1, 2] });
    assert.equal(responseBytes(response), Buffer.byteLength(JSON.stringify(response.body), 'utf8'));
  });

  it('measures a truncated stream at its truncated length', () => {
    const events = [dataFrame('a'), dataFrame('b', { complete: false })];
    const bytes = responseBytes(sseResponse(events));
    // The unterminated frame contributes its lines but not its blank line.
    assert.equal(bytes, 'data: a\n\ndata: b\n'.length);
    assert.equal(bytes, renderSseStream(events, '\n').byteLength);
  });
});

describe('fixture format: summarise', () => {
  it('reports the fields a reviewer needs to spot a bad recording', () => {
    const summary = summarizeFixtureFile(
      fixtureFile({
        name: 'mixed',
        provider: 'anthropic',
        recordedAt: RECORDED_AT,
        entries: [
          entry({
            name: 'turn-1',
            events: [
              dataFrame('{"type":"message_start"}'),
              dataFrame('{"type":"message_stop"}', { delayMs: 12, complete: false }),
            ],
            redactedHeaders: ['authorization'],
            redactedBodyPaths: ['api_key'],
          }),
          entry({ name: 'turn-2', status: 429, responseBody: { error: 'rate_limited' } }),
        ],
      }),
    );

    assert.equal(summary.name, 'mixed');
    assert.equal(summary.provider, 'anthropic');
    assert.equal(summary.version, 1);
    assert.equal(summary.recordedAt, RECORDED_AT);

    const first = summary.entries[0];
    const second = summary.entries[1];
    assert.ok(first && second, 'two entries summarised');
    assert.equal(first.name, 'turn-1');
    assert.equal(first.kind, 'sse');
    assert.equal(first.eventCount, 2);
    assert.equal(first.totalDelayMs, 12);
    assert.equal(first.truncatedTail, true, 'the cut is visible without opening the file');
    assert.equal(first.redactedHeaders, 1);
    assert.equal(first.redactedBodyPaths, 1);
    assert.equal(first.responseBytes, 'data: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n'.length);

    assert.equal(second.name, 'turn-2');
    assert.equal(second.kind, 'json');
    assert.equal(second.status, 429);
    assert.equal(second.eventCount, 0);
    assert.equal(second.truncatedTail, false, 'a JSON body is never a truncated tail');
  });

  it('names an unnamed entry by its position so a diff points somewhere', () => {
    assert.equal(summarizeFixtureFile(fixtureFile({ entries: [entry()] })).entries[0]?.name, 'entry[0]');
  });

  it('reports an empty stream as zero events, not as a truncation', () => {
    const only = summarizeFixtureFile(fixtureFile({ entries: [entry({ events: [] })] })).entries[0];
    assert.equal(only?.eventCount, 0);
    assert.equal(only?.truncatedTail, false);
    assert.equal(only?.responseBytes, 0);
  });
});
