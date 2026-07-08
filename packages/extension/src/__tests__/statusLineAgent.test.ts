import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeCodeAgent } from '../agents/claudeCode.js';
import { statusLineScriptPath, prevJsonPath, prevScriptPath } from '../hooks/statusLineScript.js';

// Editor-safety: these touch the user's ~/.claude/settings.json, so they must preserve + restore
// it exactly. Temp HOME so the real settings are never touched (mirrors hooksSetup.test.ts).
let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awaitful-sl-'));
  origHome = process.env['HOME'];
  process.env['HOME'] = tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awaitful'), { recursive: true });
});

afterEach(() => {
  process.env['HOME'] = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const settingsPath = () => path.join(tmpDir, '.claude', 'settings.json');
function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
}
function writeSettings(obj: unknown): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2));
}

const scriptPath = () => statusLineScriptPath();

describe('claudeCodeAgent.installStatusLine', () => {
  it('registers our script as the status line', async () => {
    await claudeCodeAgent.installStatusLine(scriptPath());
    const sl = readSettings()['statusLine'] as { type: string; command: string; refreshInterval: number };
    expect(sl.type).toBe('command');
    expect(sl.command).toContain(scriptPath());
    expect(sl.command).toContain('claude-code'); // the agent id passed as $1
    expect(sl.refreshInterval).toBeGreaterThanOrEqual(1);
  });

  it('preserves the user\'s existing status line + other settings', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'my-line.sh' }, model: 'opus' });
    await claudeCodeAgent.installStatusLine(scriptPath());

    // Other settings untouched.
    expect(readSettings()['model']).toBe('opus');
    // The original was backed up for restore + chaining.
    const backup = JSON.parse(fs.readFileSync(prevJsonPath('claude-code'), 'utf8'));
    expect(backup).toEqual({ type: 'command', command: 'my-line.sh' });
    expect(fs.readFileSync(prevScriptPath('claude-code'), 'utf8')).toContain('my-line.sh');
  });

  it('never overwrites the saved backup on re-install (preserves the FIRST original)', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'original.sh' } });
    await claudeCodeAgent.installStatusLine(scriptPath());
    await claudeCodeAgent.installStatusLine(scriptPath()); // re-install
    const backup = JSON.parse(fs.readFileSync(prevJsonPath('claude-code'), 'utf8'));
    expect(backup.command).toBe('original.sh'); // not our own script
  });
});

describe('claudeCodeAgent.removeStatusLine', () => {
  it('restores the user\'s original status line exactly', async () => {
    const original = { type: 'command', command: 'my-line.sh', padding: 1 };
    writeSettings({ statusLine: original });
    await claudeCodeAgent.installStatusLine(scriptPath());
    await claudeCodeAgent.removeStatusLine();

    expect(readSettings()['statusLine']).toEqual(original);
    expect(fs.existsSync(prevJsonPath('claude-code'))).toBe(false); // backup cleaned up
  });

  it('removes our status line entirely when the user had none', async () => {
    writeSettings({ model: 'opus' });
    await claudeCodeAgent.installStatusLine(scriptPath());
    await claudeCodeAgent.removeStatusLine();

    expect(readSettings()['statusLine']).toBeUndefined();
    expect(readSettings()['model']).toBe('opus'); // unrelated settings intact
  });

  it('does not touch a status line the user changed after we installed', async () => {
    await claudeCodeAgent.installStatusLine(scriptPath());
    // User replaces it with their own.
    const s = readSettings();
    s['statusLine'] = { type: 'command', command: 'their-new-line.sh' };
    writeSettings(s);

    await claudeCodeAgent.removeStatusLine();
    expect((readSettings()['statusLine'] as { command: string }).command).toBe('their-new-line.sh');
  });
});

describe('claudeCodeAgent metadata', () => {
  it('is a status-line-capable, present agent', async () => {
    expect(claudeCodeAgent.agent).toBe('claude-code');
    expect(claudeCodeAgent.supportsStatusLine).toBe(true);
    expect(await claudeCodeAgent.isPresent()).toBe(true);
  });
});
