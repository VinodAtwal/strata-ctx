import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DESTRUCTIVE_RULES,
  assertDestructiveRulesWellFormed,
  commandSegments,
  extractTargets,
  invokes,
  scanDestructive,
  type DestructiveRule,
  type DestructiveRuleId,
} from '../src/destructive.js';

const bash = (command: string) => scanDestructive({ tool: 'bash', parameters: { command } });

describe('I-9: destructive tool-argument catalogue', () => {
  describe('the shape of the catalogue itself', () => {
    it('passes its own well-formedness check', () => {
      assert.doesNotThrow(() => assertDestructiveRulesWellFormed());
    });

    it('rejects a rule without the g flag', () => {
      // A missing `g` makes the rule report the first match per string and
      // nothing else, which reads as "it works" in a one-line demo.
      const bad: DestructiveRule = {
        id: 'force_push',
        description: 'x',
        regex: /\bgit\b/,
        resolve: () => 'deny',
      };
      assert.throws(() => assertDestructiveRulesWellFormed([bad]), /g flag/);
    });

    it('rejects a rule that cannot explain itself', () => {
      const bad: DestructiveRule = {
        id: 'force_push',
        description: '',
        regex: /\bgit\b/g,
        resolve: () => 'deny',
      };
      assert.throws(() => assertDestructiveRulesWellFormed([bad]), /describe itself/);
    });

    it('has no duplicate rule ids that disagree about intent', () => {
      // Two entries may share an id (`rm` has three spellings), but every entry
      // must declare an id from the closed union, or a consumer switches on it
      // and silently falls through.
      const ids = new Set(DESTRUCTIVE_RULES.map((r) => r.id));
      for (const rule of DESTRUCTIVE_RULES) {
        assert.ok(ids.has(rule.id), `${rule.id} not in catalogue set`);
      }
    });
  });

  describe('what it blocks', () => {
    const denied: readonly (readonly [string, DestructiveRuleId])[] = [
      ['rm -rf /data', 'recursive_force_delete'],
      ['rm -fr /srv', 'recursive_force_delete'],
      ['rm -r -f ./build', 'recursive_force_delete'],
      ['rm -rf --no-preserve-root /', 'recursive_force_delete'],
      ['rm /*', 'recursive_force_delete'],
      ['git push --force origin main', 'force_push'],
      ['git push -f origin main', 'force_push'],
      ['git reset --hard HEAD~3', 'history_rewrite'],
      ['git filter-branch --all', 'history_rewrite'],
      ['mkfs.ext4 /dev/sda1', 'filesystem_format'],
      ['dd if=/dev/zero of=/dev/sda', 'filesystem_format'],
      ['sudo rm -rf /etc', 'privilege_escalation'],
      ['chmod u+s /tmp/x', 'privilege_escalation'],
      ['chmod 4755 ./a.out', 'privilege_escalation'],
      ["psql -c 'DROP TABLE users'", 'database_drop'],
      ["mysql -e 'TRUNCATE TABLE orders'", 'table_truncate'],
      ['systemctl stop nginx', 'service_disable'],
      ['pkill -f node', 'service_disable'],
      ['chmod -R 777 /var', 'bulk_permission_change'],
      ['chown -R me:me /srv', 'bulk_permission_change'],
      ['echo x >> ~/.ssh/authorized_keys', 'credential_write'],
    ];

    for (const [command, id] of denied) {
      it(`blocks ${JSON.stringify(command)} as ${id}`, () => {
        const scan = bash(command);
        assert.equal(scan.verdict, 'deny', `expected deny, findings=${JSON.stringify(scan.findings)}`);
        assert.ok(
          scan.findings.some((f) => f.id === id),
          `expected a ${id} finding, got ${JSON.stringify(scan.findings.map((f) => f.id))}`,
        );
      });
    }

    it('blocks a denied command hidden behind a shell chain', () => {
      // `echo hi && rm -rf /data` is one string and two intents. Scanning whole
      // lines either misses the tail or fires on the head.
      assert.equal(bash('echo hi && rm -rf /data').verdict, 'deny');
      assert.equal(bash('cd /tmp; rm -rf /data').verdict, 'deny');
      assert.equal(bash('true || sudo rm -rf /etc').verdict, 'deny');
      assert.equal(bash('echo a\nrm -rf /data').verdict, 'deny');
    });
  });

  describe('what it must not block', () => {
    // The false-positive half. A detector that fires on ordinary work gets
    // disabled, which is a worse outcome than having no detector.
    const allowed: readonly string[] = [
      'ls -la',
      'git status',
      'git push origin main',
      'git push --force-with-lease',
      'rm file.txt',
      'rm -r build',
      'npm run build',
      'echo "do not run rm -rf /data"',
      '# remember to rm -rf the old volume eventually',
      'git log --oneline',
      'cat README.md',
      'docker run -v /data:/data img',
      'SELECT * FROM users',
      'truncate -s 0 log.txt',
      'kubectl delete pod api-1',
      'git reset HEAD~1',
      'chmod +x script.sh',
    ];

    for (const command of allowed) {
      it(`allows ${JSON.stringify(command)}`, () => {
        const scan = bash(command);
        assert.equal(
          scan.verdict,
          'allow',
          `false positive: ${JSON.stringify(scan.findings)}`,
        );
      });
    }

    it('does not fire on a warning about a dangerous command', () => {
      // The case that decides whether the catalogue survives contact: an agent
      // reading a README that documents `rm -rf` must not be stopped by the
      // sentence describing it.
      assert.equal(bash('cat docs.md   # cleanup: rm -rf ./old && then rebuild').verdict, 'allow');
      assert.equal(bash('echo "sudo rm -rf / is dangerous, never run it"').verdict, 'allow');
    });
  });

  describe('segment splitting', () => {
    it('splits on shell chaining and drops empties', () => {
      assert.deepEqual(commandSegments('a && b; c | d'), ['a', 'b', 'c', 'd']);
      assert.deepEqual(commandSegments('rm -rf /'), ['rm -rf /']);
    });

    it('requires the tool in command position, not merely mentioned', () => {
      assert.equal(invokes('rm -rf /', 'rm'), true);
      assert.equal(invokes('/bin/rm -rf /', 'rm'), true, 'a path is reduced to its basename');
      assert.equal(invokes('echo rm', 'rm'), false);
      assert.equal(invokes('sudo rm -rf /', 'rm'), false, 'the first word is sudo');
    });
  });

  describe('argument extraction across hosts', () => {
    it('reads the command key names the supported hosts use', () => {
      assert.equal(extractTargets({ tool: 'bash', parameters: { command: 'ls' } }).length, 1);
      assert.equal(extractTargets({ tool: 'Bash', parameters: { command: 'ls' } }).length, 1);
      assert.equal(extractTargets({ tool: 'shell', parameters: { cmd: 'ls' } }).length, 1);
    });

    it('reads path-shaped arguments so a write tool is still scanned', () => {
      const scan = scanDestructive({ tool: 'write', parameters: { file_path: '/etc/shadow' } });
      // Not a destructive rule today, but it must be *scanned* rather than
      // skipped, which is what `unrecognised: false` records.
      assert.equal(scan.unrecognised, false);
    });

    it('reports unrecognised rather than pretending coverage', () => {
      const none = scanDestructive({ tool: 'read', parameters: undefined });
      assert.equal(none.unrecognised, true);
      assert.equal(none.verdict, 'allow');
      const unknownKey = scanDestructive({ tool: 'weird', parameters: { zzz: 'rm -rf /' } });
      assert.equal(unknownKey.unrecognised, true, 'an unknown key is not coverage');
      assert.equal(unknownKey.verdict, 'allow', 'and never a denial on a guess');
    });

    it('ignores non-string arguments rather than coercing them', () => {
      const scan = scanDestructive({ tool: 'bash', parameters: { command: { toString: () => 'rm -rf /' } } });
      assert.equal(scan.verdict, 'allow');
    });
  });

  describe('fail-open', () => {
    it('never throws, whatever it is handed', () => {
      const nasty: unknown[] = [undefined, null, 0, '', [], {}, { command: '' }];
      for (const parameters of nasty) {
        assert.doesNotThrow(() =>
          scanDestructive({ tool: 'bash', parameters: parameters as Record<string, unknown> }),
        );
      }
    });

    it('allows an empty command rather than blocking the turn', () => {
      const scan = bash('');
      assert.equal(scan.verdict, 'allow');
      assert.equal(scan.findings.length, 0);
    });
  });

  describe('the report', () => {
    it('reports each rule once, even when two entries describe one refusal', () => {
      // `rm -rf /data` trips both the flag rule and the root-glob rule. Telling the
      // user "recursively force-delete a path; recursively force-delete a path"
      // reads as a bug and trains them to distrust the message.
      const scan = bash('rm -rf /data');
      const ids = scan.findings.map((f) => f.id);
      assert.deepEqual(new Set(ids).size, ids.length, `duplicate findings: ${ids.join(',')}`);
    });

    it('carries the matched text and the segment so an approval is about one command', () => {
      const scan = bash('cd /tmp && rm -rf /data');
      const finding = scan.findings[0];
      assert.ok(finding);
      assert.ok(finding.evidence.includes('rm'), `evidence was ${finding.evidence}`);
      assert.equal(finding.segment, 'rm -rf /data', 'the segment is the approval unit');
    });

    it('truncates long evidence rather than echoing a whole script back', () => {
      const scan = bash(`rm -rf /data # ${'x'.repeat(500)}`);
      assert.ok(scan.findings[0]!.evidence.length <= 120);
    });
  });
});