import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Lang } from '@/components/constants';
import type { Workspace } from '@/lib/workspace/model';

import { parse, resolvePath } from './parse';
import { Shell, type ShellJob, type ShellJobResult } from './shell';

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

function shell(files: Record<string, string>, lang: Lang = 'python', run?: (job: ShellJob) => ShellJobResult) {
  let ws: Workspace = { files, dirs: [] };
  let out = '';
  const jobs: ShellJob[] = [];
  const sh = new Shell({
    lang: () => lang,
    workspace: () => ws,
    setWorkspace: (next) => (ws = next),
    write: (text) => (out += text),
    clear: () => (out = ''),
    columns: () => 80,
    run: async (job) => {
      jobs.push(job);
      return run?.(job) ?? { exitCode: 0 };
    },
  });
  return {
    sh,
    jobs,
    ws: () => ws,
    async $(line: string) {
      out = '';
      const code = await sh.execute(line);
      return { code, out: plain(out) };
    },
  };
}

test('parse: quotes, escapes, operators and redirects', () => {
  const parsed = parse(`echo "a b" 'c d' e\\ f && cat < in.txt > out.txt; ls`);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(
    parsed.chain.map((c) => [c.after, c.command.words.map((w) => w.text), c.command.redirects.map((r) => r.op + r.target.text)]),
    [
      [';', ['echo', 'a b', 'c d', 'e f'], []],
      ['&&', ['cat'], ['<in.txt', '>out.txt']],
      [';', ['ls'], []],
    ],
  );
  assert.equal(parse('ls | wc').ok, false);
  assert.equal(parse('echo "open').ok, false);
  assert.equal(parse('ls &&').ok, false);
  assert.ok(parse('ls;').ok);
});

test('resolvePath stays inside the workspace', () => {
  assert.equal(resolvePath('data', '../x.txt'), 'x.txt');
  assert.equal(resolvePath('data', '/a/./b'), 'a/b');
  assert.equal(resolvePath('', '../../..'), '');
});

test('cd, pwd and ls move around the workspace', async () => {
  const s = shell({ 'main.py': '', 'data/a.txt': 'A', 'data/b.txt': 'B' });
  assert.equal((await s.$('ls')).out, 'data/    main.py\n');
  assert.equal((await s.$('cd data && pwd')).out, '/data\n');
  assert.equal((await s.$('ls')).out, 'a.txt  b.txt\n');
  assert.equal((await s.$('cat ../main.py a.txt')).out, 'A');
  assert.equal((await s.$('cd nope')).code, 1);
  assert.equal((await s.$('cd ~ && pwd')).out, '/\n');
});

test('files: mkdir, touch, echo >, >>, cp, mv, rm', async () => {
  const s = shell({ 'main.py': '' });
  await s.$('mkdir -p out/logs && touch out/logs/x.txt');
  await s.$('echo hello > out/a.txt; echo again >> out/a.txt');
  assert.equal(s.ws().files['out/a.txt'], 'hello\nagain\n');
  await s.$('cp out/a.txt b.txt && mv b.txt out/logs');
  assert.ok('out/logs/b.txt' in s.ws().files);
  assert.equal((await s.$('rm out')).code, 1);
  await s.$('rm -r out');
  assert.deepEqual(Object.keys(s.ws().files), ['main.py']);
  const denied = await s.$('rm main.py');
  assert.equal(denied.code, 1);
  assert.match(denied.out, /where runs start/);
});

test('globs expand against the folder', async () => {
  const s = shell({ 'main.py': '', 'a.txt': '1', 'b.txt': '2', 'c.md': '' });
  assert.equal((await s.$('echo *.txt')).out, 'a.txt b.txt\n');
  assert.equal((await s.$('echo *.none')).out, '*.none\n');
});

test('python runs a file with args, cwd, input from a file and output to a file', async () => {
  const s = shell({ 'main.py': '', 'tools/count.py': '', 'in.txt': 'x\n' }, 'python', () => ({
    exitCode: 0,
    stdout: 'counted\n',
    files: { written: { '/tools/made.txt': new TextEncoder().encode('made') }, removed: [], truncated: false },
  }));
  await s.$('cd tools && python count.py -n 3 < ../in.txt > ../result.txt');
  const job = s.jobs[0]!;
  assert.equal(job.entry, '/tools/count.py');
  assert.deepEqual(job.args, ['-n', '3']);
  assert.equal(job.cwd, '/tools');
  assert.equal(job.stdin, 'x\n');
  assert.equal(job.capture, true);
  assert.equal(s.ws().files['result.txt'], 'counted\n');
  assert.equal(s.ws().files['tools/made.txt'], 'made');
  const missing = await s.$('python nope.py');
  assert.equal(missing.code, 2);
  assert.equal(s.jobs.length, 1);
});

test('g++ builds the chosen sources; ./app runs what was built', async () => {
  const s = shell({ 'main.cpp': 'int main(){}', 'other.cpp': 'x', 'util.h': '', 'data.txt': 'd' }, 'c');
  assert.equal((await s.$('g++ -std=c++17 -Wall main.cpp -o app')).code, 0);
  const build = s.jobs[0]!;
  assert.equal(build.build, true);
  assert.deepEqual(Object.keys(build.files).sort(), ['data.txt', 'main.cpp', 'util.h']);
  assert.match((await s.$('ls')).out, /app\*/);
  await s.$('echo changed > data.txt');
  await s.$('./app one two');
  const runJob = s.jobs[1]!;
  assert.equal(runJob.build, undefined);
  assert.deepEqual(runJob.args, ['one', 'two']);
  assert.equal(runJob.files['main.cpp'], 'int main(){}');
  assert.equal(runJob.files['data.txt'], 'changed\n');
  assert.match((await s.$('app')).out, /type \.\/app/);
  assert.match((await s.$('python main.py')).out, /C\+\+ workspace/);
});

test('a failed build skips what follows &&, and records no program', async () => {
  const s = shell({ 'main.rs': 'fn main(){}' }, 'rust', (job) => ({ exitCode: job.build ? 1 : 0 }));
  const result = await s.$('rustc main.rs && ./main');
  assert.equal(result.code, 1);
  assert.equal(s.jobs.length, 1);
  assert.equal((await s.$('./main')).code, 127);
});

test('a stopped program ends the rest of the line', async () => {
  const s = shell({ 'main.py': '' }, 'python', () => ({ exitCode: 130, stopped: true }));
  await s.$('python main.py; python main.py');
  assert.equal(s.jobs.length, 1);
});

test('tab completes commands and paths', async () => {
  const s = shell({ 'main.py': '', 'data/numbers.txt': '', 'data/names.txt': '' });
  assert.deepEqual(s.sh.complete('hist'), { insert: 'ory ', options: [] });
  assert.deepEqual(s.sh.complete('cat da'), { insert: 'ta/', options: [] });
  assert.deepEqual(s.sh.complete('cat data/n'), { insert: '', options: ['names.txt', 'numbers.txt'] });
  assert.deepEqual(s.sh.complete('cat data/nu'), { insert: 'mbers.txt ', options: [] });
});

test('python -m and -c start from a launcher the workspace never sees', async () => {
  const s = shell({ 'main.py': '', 'tests/test_a.py': '' });
  await s.$('cd tests && python3 -m unittest -v');
  const module = s.jobs[0]!;
  assert.equal(module.entry, '/__glassjar_main__.py');
  assert.deepEqual(module.args, ['-v']);
  assert.equal(module.cwd, '/tests');
  const launcher = module.files['__glassjar_main__.py']!;
  assert.match(launcher, /runpy\.run_module\("unittest", run_name="__main__", alter_sys=True\)/);
  assert.match(launcher, /^if False:\n {4}import unittest$/m);
  assert.ok(!('__glassjar_main__.py' in s.ws().files));

  await s.$(`python -c 'import sys; print(sys.argv)' a b`);
  const inline = s.jobs[1]!;
  assert.equal(inline.files['__glassjar_c__.py'], 'import sys; print(sys.argv)');
  assert.deepEqual(inline.args, ['a', 'b']);

  assert.equal((await s.$('python -m')).code, 2);
  assert.equal((await s.$('python -m "os; x"')).code, 1);
  assert.equal(s.jobs.length, 2);
});
