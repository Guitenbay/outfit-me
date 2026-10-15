'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, install, sourceFiles, SOURCE, discoverPython } = require('../bin/setup.cjs');
const CLI = path.resolve(__dirname, '../bin/setup.cjs');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfit-me-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tree(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? tree(path.join(root, e.name)).map(p => path.join(e.name, p)) : [e.name]).sort();
}
function fixture(t, args = []) {
  const root = temp(t), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  return { root, cwd, home, plan: parse(args, cwd, home) };
}
function fakeRun(calls, fail = '') {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    if (fail && args.includes(fail)) return { status: 1, stdout: '', stderr: 'synthetic error' };
    return { status: 0, stdout: args.includes('-c') && args.at(-1).includes('sys.executable') ? process.execPath + '\n' : '' };
  };
}
function link(t, target, name) {
  try { fs.symlinkSync(target, name, 'junction'); return true; }
  catch (err) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) { t.skip('Symlinks unavailable'); return false; } throw err; }
}
test('defaults, scopes and current documented discovery paths', () => {
  const cwd = path.resolve('project-fixture'), home = path.resolve('home-fixture');
  assert.equal(parse([], cwd, home).destination, path.join(cwd, '.claude/skills/outfit-me'));
  assert.equal(parse(['--scope', 'user', '--skill-only'], cwd, home).destination, path.join(home, '.claude/skills/outfit-me'));
  assert.equal(parse(['setup', '--agent', 'codex', '--skill-only'], cwd, home).destination, path.join(cwd, '.agents/skills/outfit-me'));
  assert.equal(parse(['--agent', 'codex', '--scope', 'user', '--skill-only'], cwd, home).destination, path.join(home, '.agents/skills/outfit-me'));
  assert.equal(parse(['--target', '~/skills'], cwd, home).parent, path.join(home, 'skills'));
  assert.equal(parse(['--target', 'custom skills'], cwd, home).skillOnly, true);
});
test('invalid flags, traversal and unsupported full MCP scopes fail early', () => {
  for (const args of [['--force'], ['install'], ['--scope', 'team'], ['--agent', 'other'], ['--target'], ['--target', '../outside'], ['--target', 'x\\..\\outside'], ['--target', 'x', '--scope', 'project'], ['--target', 'x', '--agent', 'claude'], ['--scope', 'user', '--scope', 'user'], ['--scope', 'user'], ['--agent', 'codex']]) assert.throws(() => parse(args), undefined, args.join(' '));
});
test('full dry-run performs no writes or subprocesses, even with absent parents', t => {
  const { root, plan } = fixture(t, ['--dry-run']);
  const before = tree(root);
  const io = new Proxy(fs, { get(target, key) {
    if (/^(mkdir|mkdtemp|copyFile|rename|rm|rmdir|write|chmod|unlink)/.test(key)) return () => assert.fail(`Dry run attempted ${key}`);
    return target[key];
  } });
  const result = install(plan, { io, run: () => assert.fail('Dry run spawned process') });
  assert.equal(result.installed, false);
  assert.deepEqual(tree(root), before);
});
test('skill-only installs all bundled bytes without Python/config/database', t => {
  const { root, plan } = fixture(t, ['--skill-only']);
  const result = install(plan, { run: () => assert.fail('Skill-only spawned process') });
  assert.equal(result.installed, true);
  assert.deepEqual(tree(plan.destination), sourceFiles(SOURCE));
  for (const rel of result.files) assert.deepEqual(fs.readFileSync(path.join(plan.destination, rel)), fs.readFileSync(path.join(SOURCE, rel)));
  assert.deepEqual(fs.readdirSync(plan.parent), ['outfit-me']);
  assert.equal(fs.existsSync(plan.config), false);
  assert.equal(fs.existsSync(plan.appParent), false);
  const before = tree(root);
  assert.throws(() => install(plan), /Refusing overwrite/);
  assert.deepEqual(tree(root), before);
});
test('explicit overwrite retains original backup; empty/file targets stay protected', t => {
  const { plan } = fixture(t, ['--skill-only']);
  fs.mkdirSync(plan.destination, { recursive: true });
  fs.writeFileSync(path.join(plan.destination, 'custom.txt'), 'keep');
  assert.throws(() => install(plan), /confirmation/);
  const result = install({ ...plan, yes: true });
  assert.equal(result.backups.length, 1);
  assert.equal(fs.readFileSync(path.join(result.backups[0], 'custom.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(plan.destination, 'SKILL.md')));
  fs.rmSync(plan.destination, { recursive: true }); fs.writeFileSync(plan.destination, 'keep');
  assert.throws(() => install({ ...plan, yes: true }), /Unsafe path/);
});
test('full installation subprocesses mocked: private durable paths, secure token, safe merge', t => {
  const { plan, home } = fixture(t);
  const old = { otherTopLevel: { retain: 1 }, mcpServers: { unrelated: { command: 'keep-me' } } };
  fs.writeFileSync(plan.config, JSON.stringify(old));
  const calls = [];
  const result = install(plan, { run: fakeRun(calls) });
  const config = JSON.parse(fs.readFileSync(plan.config, 'utf8'));
  assert.deepEqual(config.otherTopLevel, old.otherTopLevel);
  assert.deepEqual(config.mcpServers.unrelated, old.mcpServers.unrelated);
  const entry = config.mcpServers['outfit-me-commerce'];
  assert.ok(result.runtime.startsWith(home + path.sep));
  assert.equal(path.isAbsolute(entry.command), true);
  assert.deepEqual(entry.args, ['-B', path.join(result.runtime, 'component', 'server.py')]);
  assert.equal(entry.env.BROWSER_MODE, 'extension');
  assert.equal(entry.env.ALLOW_STATE_CHANGING_ACTIONS, 'false');
  assert.equal(entry.env.PYTHON_DOTENV_DISABLED, '1');
  assert.equal(entry.env.EXTENSION_BRIDGE_HOST, '127.0.0.1');
  assert.match(entry.env.EXTENSION_BRIDGE_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runtime, 'connection.json'))).token, entry.env.EXTENSION_BRIDGE_TOKEN);
  assert.ok(fs.existsSync(path.join(result.runtime, 'component/chrome-extension/manifest.json')));
  assert.equal(calls.length, 4);
  assert.ok(calls[1].args.includes('venv'));
  assert.ok(calls[2].args.includes('pip'));
  assert.equal(calls.every(c => c.opts.shell === false), true);
  assert.equal(calls.some(c => c.args.includes('chromium')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backups[0])), old);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(plan.config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.runtime).mode & 0o777, 0o700);
  }
});
test('MCP entry conflict requires explicit consent before downloads', t => {
  const { plan } = fixture(t);
  const old = { mcpServers: { 'outfit-me-commerce': { command: 'custom' } } };
  fs.writeFileSync(plan.config, JSON.stringify(old));
  assert.throws(() => install(plan, { run: () => assert.fail('Unconfirmed conflict spawned process') }), /confirmation/);
  const result = install(plan, { approved: true, run: fakeRun([]) });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backups[0])), old);
});
test('malformed JSON and unsafe config fail before writes/downloads', t => {
  for (const text of ['broken', '[]', '{"mcpServers":[]}']) {
    const { plan, root } = fixture(t);
    fs.writeFileSync(plan.config, text);
    const before = tree(root);
    assert.throws(() => install(plan, { run: () => assert.fail('Invalid config spawned process') }), /Invalid/);
    assert.deepEqual(tree(root), before);
  }
});
test('Python discovery checks actual version; missing Python writes nothing', t => {
  const { root, plan } = fixture(t);
  const before = tree(root);
  assert.throws(() => install(plan, { run: () => ({ status: 1, stdout: '' }) }), /Python >=3.11 not found/);
  assert.deepEqual(tree(root), before);
  const calls = [];
  discoverPython({ python: 'custom-python' }, fakeRun(calls));
  assert.equal(calls[0].command, 'custom-python');
  assert.match(calls[0].args.at(-1), /version_info >= \(3,11\)/);
});
test('venv/pip/import failures rollback everything with original skill/config untouched', t => {
  for (const failure of ['venv', 'pip', 'import mcp, playwright, dotenv']) {
    const { root, plan } = fixture(t, ['--yes']);
    fs.mkdirSync(plan.destination, { recursive: true });
    fs.writeFileSync(path.join(plan.destination, 'custom'), 'original');
    const old = '{"mcpServers":{"other":{"command":"untouched"}}}';
    fs.writeFileSync(plan.config, old);
    const before = tree(root);
    assert.throws(() => install(plan, { run: fakeRun([], failure) }), /failed.*rolled back/);
    assert.deepEqual(tree(root), before);
    assert.equal(fs.readFileSync(plan.config, 'utf8'), old);
    assert.equal(fs.readFileSync(path.join(plan.destination, 'custom'), 'utf8'), 'original');
  }
});
test('copy/publication/config write failures rollback and restore originals', t => {
  for (const failure of ['copyFileSync', 'renameSync', 'configPublish']) {
    const { plan, root } = fixture(t, ['--yes']);
    fs.mkdirSync(plan.destination, { recursive: true });
    fs.writeFileSync(path.join(plan.destination, 'custom'), 'original');
    fs.writeFileSync(plan.config, '{"retain":true}');
    const before = tree(root);
    let count = 0, failed = false;
    const io = new Proxy(fs, { get(target, key) {
      if (key === failure || (failure === 'configPublish' && key === 'copyFileSync')) return (...args) => {
        if (!failed && ((failure === 'configPublish' && args[1] === plan.config) || (failure !== 'configPublish' && ++count === 2))) { failed = true; throw new Error('Injected failure'); }
        return target[key](...args);
      };
      return target[key];
    } });
    assert.throws(() => install(plan, { io, run: fakeRun([]) }), /Injected failure.*rolled back/);
    assert.deepEqual(tree(root), before);
    assert.equal(fs.readFileSync(plan.config, 'utf8'), '{"retain":true}');
    assert.equal(fs.readFileSync(path.join(plan.destination, 'custom'), 'utf8'), 'original');
  }
});
test('concurrent config edit aborts without overwriting new bytes and restores old skill', t => {
  const { plan } = fixture(t, ['--yes']);
  fs.mkdirSync(plan.destination, { recursive: true });
  fs.writeFileSync(path.join(plan.destination, 'custom'), 'original');
  fs.writeFileSync(plan.config, '{"original":true}');
  const run = fakeRun([]);
  const concurrent = (command, args, opts) => {
    if (args.includes('import mcp, playwright, dotenv')) fs.writeFileSync(plan.config, '{"concurrent":true}');
    return run(command, args, opts);
  };
  assert.throws(() => install(plan, { run: concurrent }), /changed during setup.*rolled back/);
  assert.equal(fs.readFileSync(plan.config, 'utf8'), '{"concurrent":true}');
  assert.equal(fs.readFileSync(path.join(plan.destination, 'custom'), 'utf8'), 'original');
  assert.equal(fs.existsSync(plan.appParent), false);
});
test('rejects junction ancestors/dangling target even with overwrite', t => {
  const root = temp(t), real = path.join(root, 'real');
  fs.mkdirSync(real);
  if (!link(t, real, path.join(root, 'linked'))) return;
  assert.throws(() => install(parse(['--target', 'linked/skills', '--yes'], root)), /Unsafe path/);
  assert.deepEqual(tree(real), []);
  const parent = path.join(root, 'skills'); fs.mkdirSync(parent);
  if (!link(t, path.join(root, 'missing'), path.join(parent, 'outfit-me'))) return;
  assert.throws(() => install(parse(['--target', 'skills', '--yes'], root)), /Unsafe path/);
});
test('source traversal rejects bundled junctions', t => {
  const root = temp(t), source = path.join(root, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'synthetic');
  if (!link(t, root, path.join(source, 'linked'))) return;
  assert.throws(() => sourceFiles(source), /link\/junction/);
});
test('exclusive destination reservation never overwrites a competing install', t => {
  const { plan } = fixture(t, ['--skill-only']);
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'mkdirSync') return (name, opts) => {
      if (name === plan.destination) { fs.mkdirSync(name); fs.writeFileSync(path.join(name, 'keep'), 'other installer'); }
      return fs.mkdirSync(name, opts);
    };
    return target[key];
  } });
  assert.throws(() => install(plan, { io }), /Setup failed/);
  assert.equal(fs.readFileSync(path.join(plan.destination, 'keep'), 'utf8'), 'other installer');
  assert.deepEqual(fs.readdirSync(plan.parent), ['outfit-me']);
});
test('CLI arbitrary cwd, help/dry-run, noninteractive conflict, explicit overwrite', t => {
  const root = temp(t);
  function cli(args) { return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' }); }
  const help = cli(['--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Usage:/);
  const dry = cli(['--dry-run']); assert.equal(dry.status, 0, dry.stderr); assert.deepEqual(tree(root), []);
  const first = cli(['--agent', 'codex', '--skill-only']); assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(path.join(root, '.agents/skills/outfit-me/SKILL.md')));
  const second = cli(['--agent', 'codex', '--skill-only']); assert.equal(second.status, 1); assert.match(second.stderr, /Refusing overwrite/);
  const overwrite = cli(['--agent', 'codex', '--skill-only', '--overwrite']); assert.equal(overwrite.status, 0, overwrite.stderr); assert.match(overwrite.stdout, /backups retained/);
  assert.match(overwrite.stdout, /Not configured: Xiaohongshu/);
});
test('npm package has no npm dependencies or lifecycle install scripts; ships licenses', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.license, 'MIT'); assert.equal(pkg.engines.node, '>=18');
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined);
  assert.deepEqual(Object.keys(pkg.scripts), ['test']);
  assert.ok(pkg.files.includes('integrations/commerce-browser-mcp/LICENSE'));
  assert.equal(pkg.files.some(p => p.includes('.env') || p.includes('config_examples')), false);
});
