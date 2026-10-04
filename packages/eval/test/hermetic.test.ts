import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadCorpus, resolveCorpusHermetic, resolveCorpus} from '../src/corpus.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(HERE, '..', 'corpus', 'aegis-backlog.json');

describe('hermeticity', () => {
  it('uses committed fixture by default without network', async () => {
    const corpus = loadCorpus(CORPUS_PATH);
    const tasks = await resolveCorpusHermetic(corpus);
    assert.equal(tasks.length, corpus.entries.length);
    for (const t of tasks) {
      assert.ok(t.prompt.length > 0);
      assert.ok(t.citation.startsWith('VinodAtwal/aegis#') || t.citation.startsWith('docs/tasks.csv#'));
    }
  });

  it('hermetic resolution requires complete resolved fixture', async () => {
    const {validateResolvedCorpus} = await import('../src/corpus.js');
    const issues = validateResolvedCorpus({formatVersion: 1, name: 'x', entries: []});
    assert.ok(issues.some((i) => i.code === 'format'));
  });

  it('refresh with timeout and bounded retry path exists', async () => {
    const corpus = loadCorpus(CORPUS_PATH);
    await assert.rejects(async () => {
      await resolveCorpus(corpus, async () => {
        await execFileAsync('false', [], {timeout: 1000}).catch((e) => {
          throw e;
        });
        return 'x';
      });
    });
  });
});
