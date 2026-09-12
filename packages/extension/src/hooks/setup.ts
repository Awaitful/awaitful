import type { AgentId } from '@awaitful/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { awaitfulDir, claudeSettingsExists, readClaudeSettings, writeClaudeSettings } from './claudeSettings.js';

function portFile(): string {
  return path.join(awaitfulDir(), 'port');
}

// Marker appended to hook commands so we can identify and update them without
// touching any other hooks the user may have configured.
const HOOK_MARKER = '# awaitful';

/**
 * Does this command belong to the platform that owns `marker`?
 *
 * Markers are appended at the END of the command, so ownership is a TAIL match — deliberately not
 * `.includes()`. `~/.claude/settings.json` is machine-global and shared by every Awaitful client on
 * it, and a peer platform's marker is this one's marker plus a suffix: `'# awaitful:macos'`
 * contains `'# awaitful'`. With a substring test, whichever client installed second would strip the
 * other's hook, and each would keep silently un-installing the other on every reconcile. A tail
 * match makes the two disjoint, so peers coexist.
 */
const ownsHookCommand = (command: string, marker: string): boolean =>
  command.trimEnd().endsWith(marker);

const isOurHookCommand = (command: string): boolean => ownsHookCommand(command, HOOK_MARKER);

type HookCommand = { type: string; command: string };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HooksBlock = Record<string, HookGroup[]>;

// The Claude Code hooks Awaitful installs, mapping each event to a host endpoint.
//   UserPromptSubmit → start  : the agent began a turn (start earning).
//   Stop             → stop   : the turn ended, incl. when Claude asks a question and
//                               waits for the answer (Stop = "Claude finished responding").
//   Notification     → pause  : Claude paused mid-turn to wait for the USER — a tool
//                               permission prompt, an MCP elicitation, or a background
//                               session awaiting input. The agent is idle, so billing must
//                               pause; otherwise a user could leave a permission prompt open
//                               and keep earning on an unanswered question (golden rule 3).
//   PostToolUse      → resume : a tool just ran, so the agent is working again. This is the
//                               reliable resume signal after a permission approval, and is
//                               independent of PreToolUse ordering (the wait always sits
//                               between Notification and the next PostToolUse).
//   PreToolUse       → pause  : some interactive tools BLOCK the turn on the user WITHOUT
//                    (scoped)   firing a Notification — plan-mode approval (ExitPlanMode) and
//                               AskUserQuestion. Scope this pause to just those tools (a bare
//                               matcher would wrongly pause on every Read/Bash); the tool
//                               completing when the user answers fires PostToolUse → resume.
// The Notification / PostToolUse events use an empty matcher (all notifications / all tools) —
// pausing on a non-permission notification mid-turn is safe (those are all "waiting for the
// user" too), and a spurious resume is idempotent. `-m 2` bounds each curl so a wedged host
// can never stall Claude Code's tool loop.
const HOOK_SPECS: ReadonlyArray<{ event: string; path: string; matcher?: string }> = [
  { event: 'UserPromptSubmit', path: '/thinking/start' },
  { event: 'Stop', path: '/thinking/stop' },
  { event: 'Notification', path: '/thinking/pause', matcher: '' },
  { event: 'PreToolUse', path: '/thinking/pause', matcher: 'ExitPlanMode|AskUserQuestion' },
  { event: 'PostToolUse', path: '/thinking/resume', matcher: '' },
];

// Distinct event names we manage (for clean removal).
const HOOK_EVENTS: readonly string[] = [...new Set(HOOK_SPECS.map((h) => h.event))];

function hookCommand(pathSuffix: string): string {
  const portExpr = `$(cat "$HOME/.awaitful/port" 2>/dev/null)`;
  // The callback names the agent that fired it. The host cannot tell one agent from another - every
  // agent's hook is an identical shell command arriving on the same port - so without this, a
  // machine running two agents would have every impression attributed to whichever one happened to
  // be registered. That is attribution invented rather than observed.
  //
  // Hooks already installed on developers' machines do NOT carry it, and they upgrade on their own
  // schedule. An absent agent therefore has to mean "we do not know" rather than "claude-code",
  // which is why the whole chain below treats it as optional.
  const agent: AgentId = 'claude-code';
  return `{ _p=${portExpr} && curl -fsSL -m 2 -X POST "http://localhost:$_p${pathSuffix}?agent=${agent}" >/dev/null 2>&1; } ${HOOK_MARKER}`;
}

/**
 * Publish the port the agent's thinking hooks should POST to.
 *
 * There is exactly one of these files and every window overwrites it, so the hooks always reach one
 * host - the last one to write. That host is not necessarily the window the developer is working
 * in, and a host that receives thinking events with no webview in view renders nothing while the
 * window they ARE looking at never hears that the agent is thinking. Re-claiming on focus makes the
 * file track the window the developer is actually using, which is the best available proxy for
 * where the agent is running. The shim's `serving` preference then converges on the same host.
 *
 * Not a complete fix: two windows driven at once still share one file. The liveness ledger is what
 * keeps that honest - a host with no shim reports `silent` and stops claiming to earn.
 */
export async function writePortFile(port: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(portFile()), { recursive: true });
  await fs.promises.writeFile(portFile(), String(port), 'utf8');
}

export async function registerClaudeHooks(): Promise<void> {
  const settings = await readClaudeSettings();
  const hooksBlock = (settings.hooks ?? {}) as HooksBlock;

  for (const spec of HOOK_SPECS) {
    hooksBlock[spec.event] = upsert(
      hooksBlock[spec.event] ?? [],
      hookCommand(spec.path),
      spec.matcher,
    );
  }

  settings.hooks = hooksBlock;
  await writeClaudeSettings(settings);
}

export async function removeClaudeHooks(): Promise<void> {
  // No settings file means no hooks of ours to remove — and writing one here would CREATE
  // ~/.claude on a machine that has no Claude Code (this runs on every deactivate).
  if (!claudeSettingsExists()) return;
  const settings = await readClaudeSettings();
  const hooksBlock = (settings.hooks ?? {}) as HooksBlock;
  for (const event of HOOK_EVENTS) {
    hooksBlock[event] = (hooksBlock[event] ?? []).filter(
      (group) => !group.hooks.some((h) => isOurHookCommand(h.command)),
    );
    if (hooksBlock[event]!.length === 0) delete hooksBlock[event];
  }

  if (Object.keys(hooksBlock).length === 0) delete settings.hooks;
  else settings.hooks = hooksBlock;

  await writeClaudeSettings(settings);
}

function upsert(existing: HookGroup[], command: string, matcher?: string): HookGroup[] {
  // Replace only OUR hook. A tail match (not `.includes`) is what leaves a peer platform's
  // `# awaitful:<platform>` hook in place — see ownsHookCommand.
  const without = existing.filter(
    (group) => !group.hooks.some((h) => ownsHookCommand(h.command, HOOK_MARKER)),
  );
  const group: HookGroup =
    matcher !== undefined
      ? { matcher, hooks: [{ type: 'command', command }] }
      : { hooks: [{ type: 'command', command }] };
  return [...without, group];
}
