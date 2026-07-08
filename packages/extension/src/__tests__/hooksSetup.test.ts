import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerClaudeHooks, removeClaudeHooks } from '../hooks/setup.js';

// Use a temp dir so tests never touch the real ~/.claude/settings.json.
let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awaitful-test-'));
  origHome = process.env['HOME'];
  process.env['HOME'] = tmpDir;
  // Create .claude and .awaitful dirs.
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awaitful'), { recursive: true });
});

afterEach(() => {
  process.env['HOME'] = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  const file = path.join(tmpDir, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('registerClaudeHooks', () => {
  it('creates settings.json with start/stop + pause/resume hooks', async () => {
    await registerClaudeHooks();
    const s = readSettings();
    const hooks = s['hooks'] as Record<string, unknown[]>;
    expect(hooks['UserPromptSubmit']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['PreToolUse']).toHaveLength(1);
    expect(hooks['PostToolUse']).toHaveLength(1);
  });

  it('hook commands contain the awaitful marker and the right endpoints', async () => {
    await registerClaudeHooks();
    const s = readSettings();
    const hooks = s['hooks'] as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    const startCmd = hooks['UserPromptSubmit']![0]!.hooks[0]!.command;
    const stopCmd = hooks['Stop']![0]!.hooks[0]!.command;
    const pauseCmd = hooks['Notification']![0]!.hooks[0]!.command;
    const resumeCmd = hooks['PostToolUse']![0]!.hooks[0]!.command;
    expect(startCmd).toContain('# awaitful');
    expect(startCmd).toContain('thinking/start');
    expect(stopCmd).toContain('thinking/stop');
    expect(pauseCmd).toContain('thinking/pause');
    expect(resumeCmd).toContain('thinking/resume');
    // Notification / PostToolUse need a matcher; the bounded timeout guards CC's tool loop.
    expect(hooks['Notification']![0]!.matcher).toBe('');
    expect(hooks['PostToolUse']![0]!.matcher).toBe('');
    expect(resumeCmd).toContain('-m 2');
    // Plan-mode / question approvals block the turn without a Notification → scoped pause.
    const preToolCmd = hooks['PreToolUse']![0]!.hooks[0]!.command;
    expect(preToolCmd).toContain('thinking/pause');
    expect(hooks['PreToolUse']![0]!.matcher).toBe('ExitPlanMode|AskUserQuestion');
  });

  it('preserves existing non-awaitful hooks', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
      },
    }));
    await registerClaudeHooks();
    const s = readSettings();
    const hooks = s['hooks'] as Record<string, unknown[]>;
    expect(hooks['UserPromptSubmit']).toHaveLength(2);
  });

  it('is idempotent — re-registering does not duplicate hooks', async () => {
    await registerClaudeHooks();
    await registerClaudeHooks();
    const s = readSettings();
    const hooks = s['hooks'] as Record<string, unknown[]>;
    expect(hooks['UserPromptSubmit']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
  });
});

describe('removeClaudeHooks', () => {
  it('removes awaitful hooks and leaves others intact', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo hello' }] },
          { hooks: [{ type: 'command', command: 'curl something # awaitful' }] },
        ],
      },
    }));
    await removeClaudeHooks();
    const s = readSettings();
    const hooks = s['hooks'] as Record<string, unknown[]>;
    expect(hooks['UserPromptSubmit']).toHaveLength(1);
    expect(hooks['Stop']).toBeUndefined();
  });

  it('removes hooks key entirely when no hooks remain', async () => {
    await registerClaudeHooks();
    await removeClaudeHooks();
    const s = readSettings();
    expect(s['hooks']).toBeUndefined();
  });

  it('also removes legacy pre-rename (# codecue) hooks — one-release migration', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'keep me' }] },
          { hooks: [{ type: 'command', command: 'curl old # codecue' }] },
        ],
      },
    }));
    await removeClaudeHooks();
    const hooks = readSettings()['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks['UserPromptSubmit']).toHaveLength(1);
    expect(hooks['UserPromptSubmit']![0]!.hooks[0]!.command).toBe('keep me');
  });

  it('does nothing if settings.json does not exist', async () => {
    await expect(removeClaudeHooks()).resolves.toBeUndefined();
  });
});
