import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVELOPE_FIELDS,
  ENVELOPE_LANGUAGE,
  FENCE,
  GOVERNANCE_LANGUAGE,
  NEVER_COMPRESSED,
  OUTPUT_PROTOCOL_VERSION,
  SELF_GIST_BODY_FIELDS,
  SELF_GIST_DIRECTIVE,
  SELF_GIST_LANGUAGE,
  SELF_GIST_SENTINEL,
  TEMPLATE_VERSION,
  TemplateError,
  renderClaudeMd,
  renderOutputProtocol,
  renderSelfGistBlock,
  type ClaudeMdOptions,
  type GistDraft,
  type OutputProtocolOptions,
  type SelfGistEnvelope,
} from '../src/templates.js';

const CONSTRAINTS: readonly string[] = Object.freeze([
  'Never execute rm -rf /',
  'Prefer TypeScript over JavaScript',
  'Pinned constraint with "quotes", a backslash \\ and a tab\there',
]);

const DRAFT: GistDraft = {
  task_id: 'T42',
  status: 'partial',
  goal: 'Replace the parser without dropping pinned constraints.',
  changed: [{ path: 'src/parser.ts', what: 'Handle empty input.', why: 'It threw.' }],
  decided: [
    {
      id: 'D1',
      choice: 'Return an empty list.',
      why: 'Callers treat null as an error.',
      alternatives_rejected: ['Throw, which makes a normal case a failure.'],
    },
  ],
  unresolved: ['The whitespace-only case is still untested.'],
  current_values: { test_command: 'npm test', coverage: 'not measured' },
  next: {
    question: 'Does the whitespace-only case still throw?',
    next_command: 'npm test -- tests/parser.test.ts',
    blockers: ['CI is red on main'],
  },
  verification: { tests_run: ['npm test'], status: 'failing' },
  constraints: CONSTRAINTS,
};

const BASE_OPTIONS: ClaudeMdOptions = Object.freeze({ projectName: 'strata-ctx' });

function parseSelfGistPayload(block: string): SelfGistEnvelope {
  const lines = block.split('\n');
  assert.equal(lines[0], FENCE + SELF_GIST_LANGUAGE);
  assert.equal(lines[1], SELF_GIST_SENTINEL);
  assert.equal(lines[3], FENCE);
  assert.equal(lines.length, 4);
  return JSON.parse(lines[2] as string) as SelfGistEnvelope;
}

function governanceSlice(markdown: string): string {
  const open = markdown.indexOf(FENCE + GOVERNANCE_LANGUAGE);
  assert.notEqual(open, -1, 'document has no governance block');
  const start = open + (FENCE + GOVERNANCE_LANGUAGE).length + 1;
  const end = markdown.indexOf(`\n${FENCE}`, start);
  assert.notEqual(end, -1, 'governance block is not closed');
  return markdown.slice(start, end);
}

describe('renderSelfGistBlock', () => {
  it('emits exactly the documented delimiters', () => {
    const lines = renderSelfGistBlock(DRAFT).split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[0], '```ctx-gist');
    assert.equal(lines[1], '<<<STRATA-SELF-GIST>>>');
    assert.equal(lines[3], '```');
  });

  it('is byte-identical across two calls', () => {
    assert.equal(renderSelfGistBlock(DRAFT), renderSelfGistBlock(DRAFT));
  });

  it('does not mutate the draft it is given', () => {
    const snapshot: GistDraft = structuredClone(DRAFT);
    renderSelfGistBlock(DRAFT);
    assert.deepEqual(DRAFT, snapshot);
  });

  it('marks the payload as never compressed', () => {
    assert.equal(parseSelfGistPayload(renderSelfGistBlock(DRAFT)).compress, NEVER_COMPRESSED);
  });

  it('stamps the protocol version', () => {
    assert.equal(parseSelfGistPayload(renderSelfGistBlock(DRAFT)).v, OUTPUT_PROTOCOL_VERSION);
  });

  it('preserves governance text byte-identically', () => {
    const block = renderSelfGistBlock(DRAFT);
    for (const constraint of CONSTRAINTS) {
      assert.ok(block.includes(JSON.stringify(constraint).slice(1, -1)), `missing: ${constraint}`);
    }
  });

  it('round-trips governance text through JSON without loss', () => {
    const payload = parseSelfGistPayload(renderSelfGistBlock(DRAFT));
    assert.deepEqual(payload.constraints, [...CONSTRAINTS]);
  });

  it('preserves pin-set order rather than sorting it', () => {
    const reversed: GistDraft = { ...DRAFT, constraints: [...CONSTRAINTS].reverse() };
    const payload = parseSelfGistPayload(renderSelfGistBlock(reversed));
    assert.deepEqual(payload.constraints, [...CONSTRAINTS].reverse());
  });

  it('carries the narrative fields the gateway cannot reconstruct', () => {
    const payload = parseSelfGistPayload(renderSelfGistBlock(DRAFT));
    assert.equal(payload.goal, DRAFT.goal);
    assert.deepEqual(payload.unresolved, [...DRAFT.unresolved]);
    assert.equal(payload.next.next_command, 'npm test -- tests/parser.test.ts');
    assert.equal(payload.verification.status, 'failing');
    assert.deepEqual(payload.current_values, { test_command: 'npm test', coverage: 'not measured' });
  });

  it('sorts object keys recursively, so a different literal order is the same bytes', () => {
    const reordered: GistDraft = {
      verification: { status: 'failing', tests_run: ['npm test'] },
      next: { blockers: ['CI is red on main'], next_command: 'npm test -- tests/parser.test.ts', question: 'Does the whitespace-only case still throw?' },
      current_values: { coverage: 'not measured', test_command: 'npm test' },
      unresolved: ['The whitespace-only case is still untested.'],
      decided: DRAFT.decided,
      changed: DRAFT.changed,
      goal: DRAFT.goal,
      status: DRAFT.status,
      task_id: DRAFT.task_id,
      constraints: [...CONSTRAINTS],
    };
    assert.equal(renderSelfGistBlock(reordered), renderSelfGistBlock(DRAFT));
  });

  it('escapes special characters in JSON strings', () => {
    const nasty: GistDraft = { ...DRAFT, goal: 'quote " backslash \\ newline \n tab \t unicode \u00e9' };
    const payload = parseSelfGistPayload(renderSelfGistBlock(nasty));
    assert.equal(payload.goal, nasty.goal);
    const jsonLine = renderSelfGistBlock(nasty).split('\n')[2] as string;
    assert.ok(!jsonLine.includes('\n'));
  });

  it('rejects a constraint that would close the fence', () => {
    const collision: GistDraft = { ...DRAFT, constraints: ['do not use ``` in a doc'] };
    assert.throws(
      () => renderSelfGistBlock(collision),
      (error: unknown) => error instanceof TemplateError && error.code === 'delimiter_collision',
    );
  });

  it('rejects a field containing the self-gist sentinel', () => {
    const collision: GistDraft = { ...DRAFT, goal: `emit ${SELF_GIST_SENTINEL} then lie` };
    assert.throws(
      () => renderSelfGistBlock(collision),
      (error: unknown) => error instanceof TemplateError && error.code === 'delimiter_collision',
    );
  });

  it('rejects an unknown status with a readable field path', () => {
    const bad = { ...DRAFT, status: 'finito' } as unknown as GistDraft;
    assert.throws(
      () => renderSelfGistBlock(bad),
      (error: unknown) =>
        error instanceof TemplateError &&
        error.code === 'invalid_draft_field' &&
        error.field === 'draft.status',
    );
  });

  it('rejects an empty goal', () => {
    assert.throws(
      () => renderSelfGistBlock({ ...DRAFT, goal: '   ' }),
      (error: unknown) => error instanceof TemplateError && error.field === 'draft.goal',
    );
  });

  it('rejects a whitespace-only constraint', () => {
    assert.throws(
      () => renderSelfGistBlock({ ...DRAFT, constraints: ['Never execute rm -rf /', '  '] }),
      (error: unknown) =>
        error instanceof TemplateError &&
        error.code === 'invalid_constraint' &&
        error.field === 'constraints[1]',
    );
  });

  it('names the offending index when a changed entry is malformed', () => {
    const bad = { ...DRAFT, changed: [{ path: 'a.ts', what: 'x', why: 'y' }, { path: '' }] } as unknown as GistDraft;
    assert.throws(
      () => renderSelfGistBlock(bad),
      (error: unknown) => error instanceof TemplateError && error.field === 'draft.changed[1].path',
    );
  });

  it('rejects a non-string current value', () => {
    const bad = { ...DRAFT, current_values: { retries: 3 } } as unknown as GistDraft;
    assert.throws(
      () => renderSelfGistBlock(bad),
      (error: unknown) =>
        error instanceof TemplateError && error.field === 'draft.current_values.retries',
    );
  });

  it('rejects a missing next object', () => {
    const bad = { ...DRAFT, next: undefined } as unknown as GistDraft;
    assert.throws(
      () => renderSelfGistBlock(bad),
      (error: unknown) => error instanceof TemplateError && error.field === 'draft.next',
    );
  });

  it('rejects an unknown verification status', () => {
    const bad = { ...DRAFT, verification: { tests_run: [], status: 'probably' } } as unknown as GistDraft;
    assert.throws(
      () => renderSelfGistBlock(bad),
      (error: unknown) => error instanceof TemplateError && error.field === 'draft.verification.status',
    );
  });
});

describe('renderOutputProtocol', () => {
  it('is byte-identical across two calls', () => {
    assert.equal(renderOutputProtocol(BASE_OPTIONS), renderOutputProtocol(BASE_OPTIONS));
  });

  it('renders with no options at all', () => {
    assert.ok(renderOutputProtocol().includes('## 1. Block delimiters'));
  });

  it('documents every block delimiter', () => {
    const doc = renderOutputProtocol(BASE_OPTIONS);
    for (const language of [ENVELOPE_LANGUAGE, SELF_GIST_LANGUAGE, GOVERNANCE_LANGUAGE]) {
      assert.ok(doc.includes(FENCE + language), `missing delimiter for ${language}`);
    }
  });

  it('documents the full envelope schema in fixed order', () => {
    const doc = renderOutputProtocol(BASE_OPTIONS);
    const positions = ENVELOPE_FIELDS.map((field) => doc.indexOf(field.key));
    assert.ok(positions.every((p) => p > -1), 'every envelope field must be documented');
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'fields must be in schema order');
  });

  it('documents the full self-gist schema', () => {
    const doc = renderOutputProtocol(BASE_OPTIONS);
    for (const field of SELF_GIST_BODY_FIELDS) {
      assert.ok(doc.includes(field.key), `missing self-gist field ${field.key}`);
    }
  });

  it('includes the directive, the sentinel and a valid example block', () => {
    const doc = renderOutputProtocol(BASE_OPTIONS);
    assert.ok(doc.includes(SELF_GIST_DIRECTIVE));
    assert.ok(doc.includes(SELF_GIST_SENTINEL));
    const example = doc
      .split('\n')
      .filter((line) => line === SELF_GIST_SENTINEL || line.startsWith('{"changed"'));
    assert.equal(example.length, 2);
    const payload = JSON.parse((example[1] as string).replace(/^>/, '').replace(/>$/, '')) as SelfGistEnvelope;
    assert.equal(payload.compress, NEVER_COMPRESSED);
    assert.equal(payload.v, OUTPUT_PROTOCOL_VERSION);
  });

  it('the example block is a block this module can itself render', () => {
    const doc = renderOutputProtocol(BASE_OPTIONS);
    const anchor = doc.indexOf('**Example.**');
    assert.notEqual(anchor, -1);
    const tail = doc.slice(anchor);
    const start = tail.indexOf(`${FENCE}${SELF_GIST_LANGUAGE}`);
    const end = tail.indexOf(`\n${FENCE}`, start);
    const block = tail.slice(start, end + FENCE.length + 1);
    assert.equal(block.split('\n')[0], FENCE + SELF_GIST_LANGUAGE);
    assert.doesNotThrow(() => parseSelfGistPayload(block));
  });

  it('states the compression exclusions for prose and code', () => {
    const doc = renderOutputProtocol(BASE_OPTIONS).toLowerCase();
    assert.ok(doc.includes('prose'));
    assert.ok(doc.includes('never'));
    assert.ok(doc.includes('governance'));
  });

  it('interpolates a custom project name and protocol version', () => {
    const doc = renderOutputProtocol({ projectName: 'acme-api', protocolVersion: 7 });
    assert.ok(doc.startsWith('# Output protocol v7 — acme-api\n'));
    assert.ok(doc.includes('## 3. Self-gist block (protocol v7)'));
    assert.ok(!doc.includes('— this project'));
  });

  it('defaults the project name rather than emitting undefined', () => {
    assert.ok(renderOutputProtocol().includes('# Output protocol v1 — this project'));
  });

  it('escapes markdown metacharacters in a project name', () => {
    const doc = renderOutputProtocol({ projectName: 'a `b` *c* | d' });
    assert.ok(doc.includes('a `b` *c* | d'));
    assert.ok(!doc.includes('undefined'));
  });

  it('survives a project name containing a backtick run', () => {
    const doc = renderOutputProtocol({ projectName: 'weird ``name' });
    assert.ok(doc.includes('weird ``name'));
  });

  it('omits the self-gist section when self-gist is disabled', () => {
    const doc = renderOutputProtocol({ selfGist: false });
    assert.ok(doc.includes('Self-gist is disabled'));
    assert.ok(!doc.includes(SELF_GIST_SENTINEL));
    assert.ok(!doc.includes(SELF_GIST_DIRECTIVE));
    assert.ok(doc.includes('## 1. Block delimiters'));
  });

  it('rejects a blank project name', () => {
    assert.throws(
      () => renderOutputProtocol({ projectName: '  ' }),
      (error: unknown) => error instanceof TemplateError && error.code === 'invalid_project_name',
    );
  });

  it('rejects a project name containing a newline', () => {
    assert.throws(
      () => renderOutputProtocol({ projectName: 'a\nb' }),
      (error: unknown) => error instanceof TemplateError && error.code === 'invalid_project_name',
    );
  });

  it('rejects a non-positive or fractional protocol version', () => {
    for (const protocolVersion of [0, -1, 1.5]) {
      assert.throws(
        () => renderOutputProtocol({ protocolVersion }),
        (error: unknown) => error instanceof TemplateError && error.code === 'invalid_protocol_version',
      );
    }
  });

  it('rejects an unknown machine format', () => {
    assert.throws(
      () => renderOutputProtocol({ machineFormat: 'yaml' as never }),
      (error: unknown) => error instanceof TemplateError && error.field === 'machineFormat',
    );
  });

  it('rejects a constraint that collides with a delimiter', () => {
    assert.throws(
      () => renderOutputProtocol({ constraints: ['never write ``` in markdown'] }),
      (error: unknown) => error instanceof TemplateError && error.code === 'delimiter_collision',
    );
  });

  it('renders an explicit empty pin set rather than a broken block', () => {
    const doc = renderClaudeMd({ constraints: [] });
    assert.ok(governanceSlice(doc).includes('no constraints pinned'));
  });
});

describe('renderClaudeMd', () => {
  it('is byte-identical across two calls', () => {
    const options: ClaudeMdOptions = { ...BASE_OPTIONS, constraints: CONSTRAINTS };
    assert.equal(renderClaudeMd(options), renderClaudeMd(options));
  });

  it('renders with no options at all', () => {
    const doc = renderClaudeMd();
    assert.ok(doc.startsWith('# this project — working under strata-ctx\n'));
    assert.ok(doc.endsWith('\n'));
  });

  it('covers the three governance rules', () => {
    const doc = renderClaudeMd(BASE_OPTIONS);
    assert.ok(doc.includes('### 1.1 Pinned constraints are immutable'));
    assert.ok(doc.includes('### 1.2 Governance blocks are byte-identical'));
    assert.ok(doc.includes('### 1.3 The pinned constraint set'));
    assert.ok(doc.includes('### 1.4 Lossy compression never applies to prose or code'));
  });

  it('numbers its sections in ascending order', () => {
    const doc = renderClaudeMd({ constraints: CONSTRAINTS });
    const headings = doc.split('\n').filter((line) => /^#{2,3} /.test(line));
    const numbers = headings.map((h) => Number(/^#+ (\d+(?:\.\d+)?)/.exec(h)?.[1]));
    assert.ok(numbers.every((n) => Number.isFinite(n)), 'every heading is numbered');
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  });

  it('explains that constraints are replaced, never merged', () => {
    const doc = renderClaudeMd(BASE_OPTIONS);
    assert.ok(doc.includes('replaced from an immutable buffer'));
    assert.ok(doc.includes('never merged'));
  });

  it('explains that the byte-equality failure aborts the transaction', () => {
    const doc = renderClaudeMd(BASE_OPTIONS);
    assert.ok(doc.includes('aborts the transaction'));
  });

  it('reproduces the pin set verbatim in a governance block', () => {
    const doc = renderClaudeMd({ ...BASE_OPTIONS, constraints: CONSTRAINTS });
    assert.equal(governanceSlice(doc), CONSTRAINTS.join('\n'));
  });

  it('documents the strata CLI commands', () => {
    const doc = renderClaudeMd(BASE_OPTIONS);
    for (const command of [
      'strata status',
      'strata init',
      'strata hooks install',
      'strata verify-pins',
      'strata purge',
    ]) {
      assert.ok(doc.includes(command), `missing command: ${command}`);
    }
  });

  it('documents the MCP retrieval tools', () => {
    const doc = renderClaudeMd(BASE_OPTIONS);
    for (const tool of ['ctx_search', 'ctx_get_task', 'ctx_get_artifact']) {
      assert.ok(doc.includes(tool), `missing tool: ${tool}`);
    }
  });

  it('interpolates a custom CLI binary', () => {
    const doc = renderClaudeMd({ cli: 'npx strata-ctx' });
    assert.ok(doc.includes('`npx strata-ctx status`'));
    assert.ok(!doc.includes('`strata status`'));
  });

  it('interpolates a custom agent label', () => {
    const doc = renderClaudeMd({ agentLabel: 'Gemini CLI' });
    assert.ok(doc.includes('Instructions for Gemini CLI'));
  });

  it('embeds the output protocol verbatim, quoted', () => {
    const options: OutputProtocolOptions = { projectName: 'embedded-check' };
    const doc = renderClaudeMd({ ...options, constraints: CONSTRAINTS });
    const protocol = renderOutputProtocol({ ...options, constraints: CONSTRAINTS });
    for (const line of protocol.trimEnd().split('\n')) {
      assert.ok(doc.includes(line === '' ? '>' : `> ${line}`), `missing protocol line: ${line}`);
    }
  });

  it('omits the protocol when asked, leaving a pointer', () => {
    const doc = renderClaudeMd({ includeOutputProtocol: false });
    assert.ok(doc.includes('The output protocol lives in a separate file'));
    assert.ok(!doc.includes(SELF_GIST_SENTINEL));
  });

  it('interpolates the inline limit', () => {
    assert.ok(renderClaudeMd({ inlineLimitLines: 3 }).includes('never pasted past 3 lines'));
  });

  it('interpolates the machine format', () => {
    assert.ok(renderClaudeMd({ machineFormat: 'csv' }).includes('`csv`'));
  });

  it('stamps the template and protocol versions', () => {
    const doc = renderClaudeMd({ protocolVersion: 4 });
    assert.ok(doc.includes(`v${TEMPLATE_VERSION}`));
    assert.ok(doc.includes('output protocol v4'));
  });

  it('tells the agent that a blocked task is a correct outcome', () => {
    const doc = renderClaudeMd(BASE_OPTIONS);
    assert.ok(doc.includes('`blocked`'));
    assert.ok(doc.includes('Governance wins'));
  });

  it('is byte-identical for a given option object reused twice', () => {
    const options: ClaudeMdOptions = { projectName: 'stable', constraints: CONSTRAINTS };
    const first = renderClaudeMd(options);
    const second = renderClaudeMd(options);
    assert.equal(first, second);
    assert.equal(first.length, second.length);
  });

  it('renders a document whose every line ends in LF', () => {
    const doc = renderClaudeMd({ constraints: CONSTRAINTS });
    assert.ok(!doc.includes('\r'));
  });

  it('rejects a CLI value that could break out of a code span', () => {
    for (const cli of ['strata`', 'strata\nrm -rf /', '', 'a  b']) {
      assert.throws(
        () => renderClaudeMd({ cli }),
        (error: unknown) => error instanceof TemplateError && error.code === 'invalid_cli',
        `expected rejection for ${JSON.stringify(cli)}`,
      );
    }
  });

  it('rejects a blank agent label', () => {
    assert.throws(
      () => renderClaudeMd({ agentLabel: '' }),
      (error: unknown) => error instanceof TemplateError && error.code === 'invalid_project_name',
    );
  });

  it('propagates the protocol option errors unchanged', () => {
    assert.throws(
      () => renderClaudeMd({ protocolVersion: Number.NaN }),
      (error: unknown) => error instanceof TemplateError && error.code === 'invalid_protocol_version',
    );
  });
});

describe('TemplateError', () => {
  it('carries a machine-readable code and a field path', () => {
    try {
      renderOutputProtocol({ projectName: '' });
      assert.fail('expected a TemplateError');
    } catch (error) {
      assert.ok(error instanceof TemplateError);
      assert.equal(error.name, 'TemplateError');
      assert.equal(error.code, 'invalid_project_name');
      assert.equal(error.field, 'projectName');
      assert.ok(error.message.startsWith('invalid_project_name at projectName:'));
    }
  });
});
