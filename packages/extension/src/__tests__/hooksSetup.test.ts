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

  it('does nothing if settings.json does not exist', async () => {
    await expect(removeClaudeHooks()).resolves.toBeUndefined();
  });

  it('never CREATES the settings file - a product that is not installed gets no config dir', async () => {
    // This runs from Orchestrator.stop() on every deactivate. It used to read {}, delete nothing,
    // then write settings.json back - so simply installing Awaitful and reloading the window left a
    // ~/.claude behind on a machine that had no Claude Code.
    fs.rmSync(path.join(tmpDir, '.claude'), { recursive: true, force: true });
    await removeClaudeHooks();
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
  });
});

/**
 * ~/.claude/settings.json is machine-global, so every Awaitful client on the machine writes into
 * the same file. A peer platform marks its hooks `# awaitful:<platform>` — which CONTAINS this
 * platform's `# awaitful` marker. Ownership therefore has to be a tail match: with a substring
 * test, whichever client ran last would strip the other's hook, and the two would keep silently
 * un-installing each other on every reconcile, so one of them would stop earning for reasons
 * nothing reports.
 */
describe('peer platforms sharing ~/.claude/settings.json', () => {
  const macHook = { type: 'command', command: 'curl mac # awaitful:macos' };

  function seedWithMacHook(): void {
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [macHook] }] } }),
    );
  }

  function commandsFor(event: string): string[] {
    const hooks = readSettings()['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    return (hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  }

  it('installing ours leaves a peer platform\'s hook in place', async () => {
    seedWithMacHook();
    await registerClaudeHooks();
    const commands = commandsFor('UserPromptSubmit');
    expect(commands).toContain(macHook.command);
    expect(commands.some((c) => c.trimEnd().endsWith('# awaitful'))).toBe(true);
  });

  it('uninstalling ours leaves a peer platform\'s hook in place', async () => {
    seedWithMacHook();
    await registerClaudeHooks();
    await removeClaudeHooks();
    expect(commandsFor('UserPromptSubmit')).toEqual([macHook.command]);
  });

  it('re-installing ours does not accumulate duplicates alongside a peer', async () => {
    seedWithMacHook();
    await registerClaudeHooks();
    await registerClaudeHooks();
    const commands = commandsFor('UserPromptSubmit');
    expect(commands.filter((c) => c.trimEnd().endsWith('# awaitful'))).toHaveLength(1);
    expect(commands).toContain(macHook.command);
  });
});

/**
 * The callback names the agent that fired it.
 *
 * The host cannot tell one agent from another: every agent's hook is an identical shell command
 * arriving on the same port. Without this, a machine running two agents would have every impression
 * attributed to whichever one happened to be registered - attribution invented rather than observed,
 * which is what golden rule 3 exists to prevent.
 *
 * Doing it while there is exactly one agent is what keeps it cheap. The hooks already written into
 * developers' settings.json do not carry it and are only rewritten when the extension reinstalls
 * them, so "absent" has to keep meaning "we do not know" indefinitely.
 */
describe('agent attribution in the hook command', () => {
  it('names the agent in every thinking callback', async () => {
    await registerClaudeHooks();
    const hooks = readSettings()['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;

    for (const event of ['UserPromptSubmit', 'Stop', 'Notification', 'PostToolUse']) {
      const commands = (hooks[event] ?? []).flatMap(g => g.hooks.map(h => h.command));
      expect(commands.some(c => c.includes('?agent=claude-code')), `${event} does not name its agent`).toBe(true);
    }
  });

  it('keeps the marker at the very end, where ownership is decided', async () => {
    // The query parameter is appended inside the quoted URL, so the tail match that decides which
    // client owns a hook must still see the marker last.
    await registerClaudeHooks();
    const hooks = readSettings()['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const command = hooks['Stop']![0]!.hooks[0]!.command;
    expect(command.trimEnd().endsWith('# awaitful')).toBe(true);
  });

  it('still bounds the request and swallows its failure', async () => {
    // Unchanged by the new parameter, and load-bearing: this runs inside the agent's tool loop, so
    // an unbounded curl at a listener that is not there would stall the developer's own turn.
    await registerClaudeHooks();
    const hooks = readSettings()['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const command = hooks['Stop']![0]!.hooks[0]!.command;
    expect(command).toContain('-m 2');
    expect(command).toContain('>/dev/null 2>&1');
  });
});
