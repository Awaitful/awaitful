import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeCodeAgent } from '../agents/claudeCode.js';
import { findOnPath } from '../agents/binary.js';
import { detectAgents, initialPresence, anyCli, anyEditor, cliAgents, statusLineAgents } from '../agents/presence.js';

/**
 * Agent presence decides whether Awaitful writes into another product's config at all, so getting it
 * wrong is a golden-rule-2 failure in both directions. The headline case: `isPresent()` used to
 * return a hardcoded `true`, so on a machine with no Claude Code the extension installed hooks,
 * claimed the terminal surface was enabled, and CREATED ~/.claude for a product that was not there.
 *
 * The environment is neutralised hard - temp HOME, emptied PATH, no CLAUDE_CONFIG_DIR - because
 * every developer running this suite very likely does have Claude Code installed, and a leak would
 * make the negative cases silently pass.
 */
const ENV_KEYS = ['HOME', 'PATH', 'CLAUDE_CONFIG_DIR', 'AWAITFUL_SYSTEM_BIN_DIRS'] as const;

let tmpDir: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awaitful-presence-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['HOME'] = tmpDir;
  process.env['PATH'] = ''; // no real `claude` may leak in via $PATH
  process.env['AWAITFUL_SYSTEM_BIN_DIRS'] = ''; // ...nor via /usr/local/bin or /opt/homebrew/bin
  delete process.env['CLAUDE_CONFIG_DIR'];
  // NOTE: deliberately no mkdir of ~/.claude — a bare machine is the case under test.
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const claudeDir = () => path.join(tmpDir, '.claude');

/** A dir with an executable in it, put on PATH. */
function fakeBin(name: string): string {
  const dir = path.join(tmpDir, 'fakebin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}

describe('claudeCodeAgent.detectCli — absent', () => {
  it('reports absent on a bare machine', async () => {
    expect(await claudeCodeAgent.detectCli()).toBe(false);
  });

  it('does NOT treat an empty ~/.claude as evidence', async () => {
    // The reported bug: Awaitful creates this directory itself (writeClaudeSettings does mkdir -p),
    // so trusting it would make the extension detect its own leftovers as Claude Code.
    fs.mkdirSync(claudeDir(), { recursive: true });
    expect(await claudeCodeAgent.detectCli()).toBe(false);
  });

  it('does NOT treat a settings.json holding only OUR hooks as evidence', async () => {
    // The exact self-detection case. This is the file an older Awaitful wrote on a machine that
    // never had Claude Code; reading it as presence is how the bug perpetuated itself.
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir(), 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl … # awaitful' }] }] } }),
    );
    expect(await claudeCodeAgent.detectCli()).toBe(false);
  });

  it('does NOT treat our own ~/.awaitful as evidence', async () => {
    fs.mkdirSync(path.join(tmpDir, '.awaitful'), { recursive: true });
    expect(await claudeCodeAgent.detectCli()).toBe(false);
  });
});

describe('claudeCodeAgent.detectCli — present', () => {
  it('detects ~/.claude.json, which lives outside the directory we create', async () => {
    fs.writeFileSync(path.join(tmpDir, '.claude.json'), '{}');
    expect(await claudeCodeAgent.detectCli()).toBe(true);
  });

  // Every one of these is written by Claude Code itself and never by Awaitful.
  for (const marker of ['projects', 'statsig', 'history.jsonl', 'todos', 'ide', 'shell-snapshots']) {
    it(`detects ~/.claude/${marker}`, async () => {
      fs.mkdirSync(claudeDir(), { recursive: true });
      const target = path.join(claudeDir(), marker);
      if (marker.includes('.')) fs.writeFileSync(target, '');
      else fs.mkdirSync(target);
      expect(await claudeCodeAgent.detectCli()).toBe(true);
    });
  }

  it('detects the binary on $PATH', async () => {
    process.env['PATH'] = fakeBin(process.platform === 'win32' ? 'claude.cmd' : 'claude');
    expect(await claudeCodeAgent.detectCli()).toBe(true);
  });

  it('detects a local install that is not on $PATH', async () => {
    // `claude migrate-installer` puts the binary here without necessarily exporting the dir.
    const local = path.join(claudeDir(), 'local');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '', { mode: 0o755 });
    expect(process.env['PATH']).toBe('');
    expect(await claudeCodeAgent.detectCli()).toBe(true);
  });

  it('honours CLAUDE_CONFIG_DIR', async () => {
    const relocated = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(path.join(relocated, 'projects'), { recursive: true });
    process.env['CLAUDE_CONFIG_DIR'] = relocated;
    // ~/.claude stays empty, so only the relocated dir can be the reason this passes.
    fs.mkdirSync(claudeDir(), { recursive: true });
    expect(await claudeCodeAgent.detectCli()).toBe(true);
  });
});

describe('detection is read-only', () => {
  it('creates no files - the scan must never become the reason the answer is yes', async () => {
    const before = fs.readdirSync(tmpDir).sort();
    await claudeCodeAgent.detectCli();
    await detectAgents(() => false);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(before);
    expect(fs.existsSync(claudeDir())).toBe(false);
  });
});

describe('findOnPath', () => {
  it('returns undefined when nothing matches, and never throws on a broken PATH', () => {
    process.env['PATH'] = path.join(tmpDir, 'does-not-exist');
    expect(findOnPath('claude')).toBeUndefined();
    delete process.env['PATH'];
    expect(findOnPath('claude')).toBeUndefined();
  });

  it('searches extraDirs after $PATH', () => {
    const dir = fakeBin(process.platform === 'win32' ? 'claude.cmd' : 'claude');
    expect(findOnPath('claude')).toBeUndefined(); // PATH is empty
    expect(findOnPath('claude', [dir])).toBeDefined();
  });
});

describe('detectAgents', () => {
  it('reports both axes false on a bare machine, and every derived helper agrees', async () => {
    const p = await detectAgents(() => false);
    expect(p).toHaveLength(1);
    expect(p[0]!.agent).toBe('claude-code');
    expect(p[0]!.cli).toBe(false);
    expect(p[0]!.editor).toBe(false);
    expect(anyCli(p)).toBe(false);
    expect(anyEditor(p)).toBe(false);
    expect(cliAgents(p)).toEqual([]);
    expect(statusLineAgents(p)).toEqual([]);
  });

  it('treats the editor extension as proof of the CLI', async () => {
    // The extension ships and drives the agent binary, so its presence settles both axes even when
    // the filesystem scan finds nothing.
    const p = await detectAgents((id) => id === 'anthropic.claude-code');
    expect(p[0]!.editor).toBe(true);
    expect(p[0]!.cli).toBe(true);
    expect(statusLineAgents(p)).toHaveLength(1);
  });

  it('lets a fired thinking hook override a negative scan', async () => {
    // The upgrade safety net: someone already earning must never be switched off by a detector that
    // is wrong about their unusual install.
    const p = await detectAgents(() => false, { provenCli: ['claude-code'] });
    expect(p[0]!.cli).toBe(true);
    expect(p[0]!.editor).toBe(false); // the proof is about the CLI only
  });

  it('never asks about an extension id the agent did not declare', async () => {
    const asked: string[] = [];
    await detectAgents((id) => { asked.push(id); return false; });
    expect(asked).toEqual(['anthropic.claude-code']);
  });

  it('fails to absent when the editor lookup throws, rather than crashing activation', async () => {
    const p = await detectAgents(() => { throw new Error('vscode blew up'); });
    expect(p[0]!.cli).toBe(false);
    expect(p[0]!.editor).toBe(false);
  });
});

describe('initialPresence', () => {
  it('has one all-false entry per integration, so the panel can render before detection lands', () => {
    const p = initialPresence();
    expect(p).toHaveLength(1);
    expect(p[0]!.cli).toBe(false);
    expect(p[0]!.editor).toBe(false);
    expect(p[0]!.label).toBe('Claude Code');
  });
});
