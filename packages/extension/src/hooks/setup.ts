import * as fs from 'node:fs';
import * as path from 'node:path';
import { awaitfulDir, readClaudeSettings, writeClaudeSettings } from './claudeSettings.js';

function portFile(): string {
  return path.join(awaitfulDir(), 'port');
}

// Marker appended to hook commands so we can identify and update them without
// touching any other hooks the user may have configured.
const HOOK_MARKER = '# awaitful';
// Transitional (one release): also recognize the pre-rename marker so an upgrade replaces/cleans
// hooks the old "CodeCue" build left in the user's settings.json. Drop after the first release cycle.
const LEGACY_HOOK_MARKER = '# codecue';
const isOurHookCommand = (command: string): boolean =>
  command.includes(HOOK_MARKER) || command.includes(LEGACY_HOOK_MARKER);

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
  return `{ _p=${portExpr} && curl -fsSL -m 2 -X POST "http://localhost:$_p${pathSuffix}" >/dev/null 2>&1; } ${HOOK_MARKER}`;
}

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
  const without = existing.filter(
    (group) => !group.hooks.some((h) => h.command.includes(HOOK_MARKER)),
  );
  const group: HookGroup =
    matcher !== undefined
      ? { matcher, hooks: [{ type: 'command', command }] }
      : { hooks: [{ type: 'command', command }] };
  return [...without, group];
}
