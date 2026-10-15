#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'skills', 'outfit-me');
const COMMERCE = path.join(ROOT, 'integrations', 'commerce-browser-mcp');
const HELP = `Outfit Me setup (Node >=18; full setup also requires Python >=3.11)
Usage: outfit-me-agent [setup] [--agent claude|codex] [--scope project|user]
       outfit-me-agent [setup] --target <skills-parent-directory>
Options:
  --dry-run       Read/validate only: no writes, prompts or subprocesses
  --yes          Explicitly approve replacement conflicts (with backups)
  --overwrite    Same explicit replacement consent as --yes
  --skill-only   Copy skill only; no dependencies, MCP or configuration
  --python PATH  Python >=3.11 executable (otherwise auto-discovered)
  --help, -h
Defaults: Claude project in current directory; full commerce MCP setup.
Full setup: installs Python dependencies from PyPI into a durable private venv,
merges project .mcp.json, generates a local token, and prints Chrome extension
onboarding. No browser launch, model changes, database or account login.
Claude user and Codex require --skill-only (MCP configuration is manual).
--target is skill-only and cannot be combined with --agent or --scope.
Claude skill paths: .claude/skills or ~/.claude/skills.
Codex skill paths: .agents/skills or ~/.agents/skills.
Existing content prompts with default No; noninteractive conflicts require
--yes or --overwrite. No --force. XHS/weather require separate onboarding.
`;

function statOrNull(name, io = fs) {
  try { return io.lstatSync(name); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function checkAncestors(name, io = fs) {
  const parts = [];
  for (let p = path.resolve(name); ; p = path.dirname(p)) {
    parts.push(p);
    if (path.dirname(p) === p) break;
  }
  for (const p of parts.reverse()) {
    const s = statOrNull(p, io);
    if (s && (s.isSymbolicLink() || !s.isDirectory())) throw new Error(`Unsafe path (link/junction or not a directory): ${p}`);
  }
}
function regularFile(name, io = fs) {
  checkAncestors(path.dirname(name), io);
  const s = statOrNull(name, io);
  if (s && (s.isSymbolicLink() || !s.isFile())) throw new Error(`Unsafe file: ${name}`);
  return s;
}
function sourceFiles(source, io = fs, required = 'SKILL.md') {
  checkAncestors(source, io);
  const files = [];
  function walk(dir, relative) {
    for (const name of io.readdirSync(dir)) {
      const full = path.join(dir, name), rel = path.join(relative, name), s = io.lstatSync(full);
      if (s.isSymbolicLink()) throw new Error(`Bundled source contains a link/junction: ${rel}`);
      if (s.isDirectory()) walk(full, rel);
      else if (s.isFile()) files.push(rel);
      else throw new Error(`Bundled source contains a special file: ${rel}`);
    }
  }
  walk(source, '');
  if (!files.includes(required)) throw new Error(`Bundled source incomplete: ${required} missing. Reinstall package.`);
  return files.sort();
}
function parse(args, cwd = process.cwd(), home = os.homedir()) {
  const opts = { agent: 'claude', scope: 'project', dryRun: false, yes: false, skillOnly: false, cwd, home };
  const seen = new Set();
  if (args[0] === 'setup') args = args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--skill-only') opts.skillOnly = true;
    else if (flag === '--yes' || flag === '--overwrite') opts.yes = true;
    else if (['--agent', '--scope', '--target', '--python'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${flag}`);
      opts[flag.slice(2)] = value;
    } else throw new Error(`Unknown option or command: ${flag}. Use --help.`);
  }
  if (!['claude', 'codex'].includes(opts.agent)) throw new Error('Unknown agent; use claude, codex, or --target.');
  if (!['project', 'user'].includes(opts.scope)) throw new Error('Scope must be project or user.');
  if (opts.target && (seen.has('--agent') || seen.has('--scope'))) throw new Error('--target cannot be combined with --agent or --scope.');
  if (opts.target) {
    if (opts.target.split(/[\\/]/).includes('..')) throw new Error('Path traversal (..) is not accepted in --target.');
    let value = opts.target;
    if (value === '~' || /^[~][\\/]/.test(value)) value = path.join(home, value.slice(2));
    else if (value.startsWith('~')) throw new Error('Only ~/path home expansion is supported.');
    opts.parent = path.resolve(cwd, value);
    opts.skillOnly = true;
  } else opts.parent = path.join(opts.scope === 'user' ? home : cwd, opts.agent === 'claude' ? '.claude' : '.agents', 'skills');
  if (!opts.skillOnly && (opts.agent !== 'claude' || opts.scope !== 'project')) throw new Error('Automatic MCP merge supports Claude project only. Add --skill-only; see docs/SETUP.md for manual MCP onboarding.');
  opts.destination = path.join(opts.parent, 'outfit-me');
  opts.config = path.join(cwd, '.mcp.json');
  opts.appParent = path.join(home, '.outfit-me', 'runtimes');
  return opts;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function inspect(plan, io = fs) {
  const files = sourceFiles(SOURCE, io);
  checkAncestors(plan.parent, io);
  const existing = statOrNull(plan.destination, io);
  if (existing) checkAncestors(plan.destination, io);
  let oldConfig = null, config = {}, commerceFiles = [];
  if (!plan.skillOnly) {
    checkAncestors(plan.appParent, io);
    commerceFiles = sourceFiles(COMMERCE, io, 'server.py');
    if (regularFile(plan.config, io)) {
      oldConfig = io.readFileSync(plan.config);
      try { config = JSON.parse(oldConfig.toString('utf8').replace(/^﻿/, '')); }
      catch { throw new Error('Invalid .mcp.json JSON. Repair it manually; no files changed.'); }
      if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) throw new Error('Invalid .mcp.json structure; expected object with mcpServers object.');
    }
  }
  const conflicts = [];
  if (existing) conflicts.push(plan.destination);
  if (config.mcpServers && Object.hasOwn(config.mcpServers, 'outfit-me-commerce')) conflicts.push('MCP entry outfit-me-commerce');
  return { files, commerceFiles, existing, oldConfig, config, conflicts };
}
function runChecked(run, command, args, label) {
  const result = run(command, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 600000 });
  if (result.error || result.status !== 0) throw new Error(`${label} failed. Check Python/venv support, network/proxy and PyPI access, then retry. No agent configuration was intentionally changed.`);
  return result.stdout || '';
}
function discoverPython(plan, run) {
  const candidates = plan.python ? [[plan.python, []]] : (process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]);
  for (const [command, prefix] of candidates) {
    const r = run(command, [...prefix, '-B', '-c', 'import sys; print(sys.executable); sys.exit(0 if sys.version_info >= (3,11) else 1)'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 });
    if (!r.error && r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('Python >=3.11 not found. Install Python with venv/pip support or pass --python <executable>; alternatively use --skill-only.');
}
function install(plan, { io = fs, run = spawnSync, approved = false } = {}) {
  const state = inspect(plan, io);
  if (plan.dryRun) return { ...plan, files: state.files, installed: false, conflicts: state.conflicts };
  if (state.conflicts.length && !plan.yes && !approved) throw new Error(`Refusing overwrite without confirmation: ${state.conflicts.join(', ')}. Rerun interactively (default No) or explicitly pass --overwrite/--yes; backups are retained.`);
  const python = plan.skillOnly ? null : discoverPython(plan, run);
  const created = [], backups = [];
  let stage, runtime, ownsSkill = false, configWritten = false, skillBackup, configBackup, configStage;
  function mkdirs(dir) {
    const missing = [];
    for (let p = dir; !statOrNull(p, io); p = path.dirname(p)) missing.push(p);
    for (const p of missing.reverse()) { checkAncestors(path.dirname(p), io); io.mkdirSync(p, { mode: 0o700 }); created.push(p); }
  }
  function copy(source, target, files) {
    for (const rel of files) {
      const from = path.join(source, rel);
      regularFile(from, io);
      const to = path.join(target, rel);
      io.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      io.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
  const id = crypto.randomUUID();
  try {
    mkdirs(plan.parent);
    stage = io.mkdtempSync(path.join(plan.parent, '.outfit-me-stage-'));
    copy(SOURCE, stage, state.files);
    let entry;
    if (!plan.skillOnly) {
      mkdirs(plan.appParent);
      runtime = io.mkdtempSync(path.join(plan.appParent, 'commerce-'));
      io.chmodSync(runtime, 0o700);
      const component = path.join(runtime, 'component');
      io.mkdirSync(component);
      copy(COMMERCE, component, state.commerceFiles);
      const venv = path.join(runtime, 'venv');
      runChecked(run, python, ['-B', '-m', 'venv', venv], 'Python virtual environment creation');
      const vpython = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      runChecked(run, vpython, ['-B', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', component], 'MCP dependency installation');
      runChecked(run, vpython, ['-B', '-c', 'import mcp, playwright, dotenv'], 'MCP dependency verification');
      const token = crypto.randomBytes(32).toString('hex');
      const env = { BROWSER_MODE: 'extension', EXTENSION_BRIDGE_HOST: '127.0.0.1', EXTENSION_BRIDGE_PORT: '8765', EXTENSION_BRIDGE_TOKEN: token, PYTHON_DOTENV_DISABLED: '1', ALLOW_STATE_CHANGING_ACTIONS: 'false', BROWSER_PROFILE_DIR: path.join(runtime, 'profile'), ARTIFACTS_DIR: path.join(runtime, 'artifacts') };
      entry = { type: 'stdio', command: vpython, args: ['-B', path.join(component, 'server.py')], env };
      // Token remains only in private local configuration, never printed.
      io.writeFileSync(path.join(runtime, 'connection.json'), JSON.stringify({ port: 8765, token }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    checkAncestors(plan.parent, io);
    // Detect concurrent changes before making backups or replacing content.
    const current = statOrNull(plan.destination, io);
    if (state.existing ? !current || current.ino !== state.existing.ino || current.mtimeMs !== state.existing.mtimeMs : current) throw new Error('Skill target changed during setup; retry after reviewing it.');
    if (current) {
      checkAncestors(plan.destination, io);
      skillBackup = `${plan.destination}.backup-${id}`;
      io.renameSync(plan.destination, skillBackup);
      backups.push(skillBackup);
    }
    io.mkdirSync(plan.destination); // exclusive reservation; never replaces a competing destination
    ownsSkill = true;
    for (const name of io.readdirSync(stage)) {
      checkAncestors(plan.destination, io);
      io.renameSync(path.join(stage, name), path.join(plan.destination, name));
    }
    io.rmdirSync(stage); stage = undefined;
    if (!plan.skillOnly) {
      const exists = regularFile(plan.config, io);
      const now = exists ? io.readFileSync(plan.config) : null;
      if (state.oldConfig ? !now || !state.oldConfig.equals(now) : now) throw new Error('.mcp.json changed during setup; retry after reviewing it.');
      const merged = { ...state.config, mcpServers: { ...(state.config.mcpServers || {}), 'outfit-me-commerce': entry } };
      configStage = `${plan.config}.stage-${id}`;
      io.writeFileSync(configStage, JSON.stringify(merged, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (exists) {
        configBackup = `${plan.config}.backup-${id}`;
        io.renameSync(plan.config, configBackup);
        backups.push(configBackup);
      }
      // Exclusive copy avoids overwriting a config created by another process.
      io.copyFileSync(configStage, plan.config, fs.constants.COPYFILE_EXCL);
      configWritten = true;
      io.chmodSync(plan.config, 0o600);
      io.unlinkSync(configStage); configStage = undefined;
    }
    return { ...plan, installed: true, files: state.files, runtime, backups };
  } catch (err) {
    const cleanup = [];
    function attempt(fn) { try { fn(); } catch (e) { cleanup.push(e.message); } }
    if (configWritten) attempt(() => io.unlinkSync(plan.config));
    if (configBackup) attempt(() => { if (statOrNull(plan.config, io)) throw new Error(`Config changed concurrently; original preserved at ${configBackup}`); io.renameSync(configBackup, plan.config); });
    if (configStage) attempt(() => io.rmSync(configStage, { force: true }));
    if (ownsSkill) attempt(() => io.rmSync(plan.destination, { recursive: true, force: true }));
    if (skillBackup) attempt(() => { if (statOrNull(plan.destination, io)) throw new Error(`Target changed concurrently; original preserved at ${skillBackup}`); io.renameSync(skillBackup, plan.destination); });
    if (stage) attempt(() => io.rmSync(stage, { recursive: true, force: true }));
    if (runtime) attempt(() => io.rmSync(runtime, { recursive: true, force: true }));
    for (const p of created.reverse()) attempt(() => { try { io.rmdirSync(p); } catch (e) { if (!['ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; } });
    throw new Error(`Setup failed: ${err.message}; ${cleanup.length ? `manual recovery needed: ${cleanup.join('; ')}` : 'rolled back installer-created files and restored originals.'}`);
  }
}
async function main(args = process.argv.slice(2)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node >=18 is required.');
    const plan = parse(args);
    if (plan.help) { console.log(HELP); return; }
    const state = inspect(plan);
    let approved = false;
    if (!plan.dryRun && state.conflicts.length && !plan.yes && process.stdin.isTTY && process.stdout.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { approved = /^y(es)?$/i.test((await rl.question(`Replace ${state.conflicts.join(', ')} with backups? [y/N] `)).trim()); }
      finally { rl.close(); }
      if (!approved) { console.log('Cancelled; no changes made.'); return; }
    }
    if (!plan.dryRun && !plan.skillOnly) console.log('Installing bundled commerce MCP and Python dependencies (network/PyPI); merging Claude project .mcp.json. No browser or database will be started.');
    const result = install(plan, { approved });
    console.log(`${result.installed ? 'Installed' : 'Dry run: would install'} ${result.files.length} skill files at ${result.destination}`);
    if (plan.dryRun) {
      console.log(plan.skillOnly ? 'Skill-only; no MCP/config changes.' : `Would create a private runtime under ${plan.appParent}, install Python dependencies, and merge ${plan.config}.`);
      if (result.conflicts.length) console.log(`Replacement confirmation required: ${result.conflicts.join(', ')}`);
    } else if (result.runtime) {
      console.log(`Commerce MCP configured, not yet connected. Chrome: open chrome://extensions, enable Developer mode, Load unpacked: ${path.join(result.runtime, 'component', 'chrome-extension')}`);
      console.log(`Open private local file ${path.join(result.runtime, 'connection.json')} yourself; paste its port/token into the extension. Do not share it or send it to chat.`);
      console.log('Restart Claude, approve the project MCP server, call browser_start, then explicitly authorize JD and Taobao/Tmall tabs separately. Login/CAPTCHA/SKU selection are manual. Port 8765 must be free; do not start duplicate bridges.');
    } else console.log('Skill-only installation: MCP configuration remains manual; see docs/SETUP.md.');
    if (result.backups?.length) console.log(`Original backups retained: ${result.backups.join(', ')}`);
    console.log('Not configured: Xiaohongshu reference-workflow connector and QWeather/weather credentials. See docs/SETUP.md for explicit onboarding; no live integration is claimed ready.');
  } catch (err) { console.error(`outfit-me-agent: ${err.message}`); process.exitCode = 1; }
}
module.exports = { parse, install, inspect, sourceFiles, SOURCE, COMMERCE, discoverPython, main };
if (require.main === module) main();
