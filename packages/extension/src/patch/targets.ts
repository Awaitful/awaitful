import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// os.homedir() ignores $HOME on macOS; prefer $HOME so tests can override the
// install root. Mirrors the idiom in src/hooks/setup.ts.
export function homedir(): string {
  return process.env['HOME'] ?? os.homedir();
}

/** Where VS Code keeps installed extensions. Overridable for tests. */
export function extensionsRoot(): string {
  return process.env['AWAITFUL_VSCODE_EXT_DIR'] ?? path.join(homedir(), '.vscode', 'extensions');
}

/**
 * Directory names VS Code has already uninstalled but not yet deleted.
 *
 * Removing an extension does not remove its folder: VS Code records the name in `.obsolete` and
 * clears the bytes later, once no window is holding them. So the folder being there proves nothing,
 * and a scan that only reads directory names reports a tool the developer has already removed as
 * still installed - which is exactly what stopped the conflict checklist from ever ticking, and made
 * a working uninstall look like a broken button.
 *
 * Never throws: no file, or unreadable, means nothing is known to be obsolete.
 */
export function obsoleteExtensionDirs(): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(extensionsRoot(), '.obsolete'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Set(Object.keys(parsed).filter((k) => parsed[k] === true));
  } catch {
    return new Set();
  }
}

/**
 * Every extension present on disk, from the directory names alone.
 *
 * VS Code's own `extensions.all` lists only ENABLED ones, so a tool the developer merely switched
 * off vanishes from it entirely - and a disabled tool's change is still sitting in Claude Code's
 * file. Without this, the panel could not tell "switched off, still installed" from "gone", and told
 * someone to hunt for a marker token when their extension was right there in the list.
 *
 * Directory names are `publisher.name-version`, which is enough for identity; the display name is
 * read lazily, only for a directory that actually matched. Never throws.
 */
/**
 * Read one editor's `extensions.json`, the registry VS Code itself trusts.
 *
 * A folder is NOT that answer: uninstalling leaves it behind until the next full restart, and it is
 * not always recorded in `.obsolete` either - measured on a real machine, an uninstalled extension
 * had its folder intact, an empty `.obsolete`, and no registry entry. Trusting the folder reported
 * it as merely switched off, so the repair checklist told the developer to turn off something they
 * had already removed and never ticked the step.
 *
 * Returns undefined when there is no registry to read, which is how callers tell "this is not an
 * editor's extension directory" from "an editor with nothing installed". Never throws.
 */
function readRegistry(root: string): { id: string; dir: string }[] | undefined {
  let parsed: { identifier?: { id?: string }; relativeLocation?: string; location?: { path?: string } }[];
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, 'extensions.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const out: { id: string; dir: string }[] = [];
  for (const e of parsed) {
    const id = e.identifier?.id;
    if (!id) continue;
    const rel = e.relativeLocation ?? e.location?.path?.split('/').pop();
    out.push({ id, dir: rel ? path.join(root, rel) : root });
  }
  return out;
}

/** Friendly names for the editors that keep extensions in a dot directory under $HOME. */
const EDITOR_NAMES: Record<string, string> = {
  '.vscode': 'VS Code',
  '.vscode-insiders': 'VS Code Insiders',
  '.vscode-oss': 'VSCodium',
  '.vscode-server': 'VS Code Server',
  '.vscode-server-insiders': 'VS Code Server Insiders',
  '.cursor': 'Cursor',
  '.cursor-server': 'Cursor Server',
  '.windsurf': 'Windsurf',
  '.windsurf-server': 'Windsurf Server',
  '.trae': 'Trae',
  '.positron': 'Positron',
  '.devin': 'Devin',
};

/**
 * The name a developer calls this editor, from its dot directory.
 *
 * A fork we have never heard of still gets a recognisable name rather than a path fragment: nobody
 * has an application called ".devin", so telling someone to go and quit one is telling them to
 * decode a directory listing. The mapped names come first because several cannot be derived -
 * ".vscode-oss" is VSCodium to everyone who runs it.
 */
export function editorName(dot: string): string {
  const mapped = EDITOR_NAMES[dot];
  if (mapped) return mapped;
  return dot.replace(/^\./, '').split(/[-_.]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || dot;
}

/** Extensions inferred from directory NAMES alone, for a root whose registry we are not trusting. */
function folderExtensions(root: string): { id: string; dir: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: { id: string; dir: string }[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    // Strip the trailing `-1.2.3` (and any `-darwin-x64` platform suffix after it).
    const m = /^(.+?)-\d+\.\d+\.\d+(?:-.*)?$/.exec(name);
    const id = m?.[1];
    if (!id || !id.includes('.')) continue;
    out.push({ id, dir: path.join(root, name) });
  }
  return out;
}

/**
 * Every OTHER editor's extension directory on this machine.
 *
 * An extension is installed into one editor, but it is not confined to one: a patch tool reads
 * `$HOME` and edits the agent's files wherever it finds them, so a copy living in a different editor
 * changes the very bytes THIS window loads. Measured on a real machine - a competitor installed only
 * in VSCodium re-patched a Claude Code that had just been installed into VS Code, within a minute,
 * from a list of host directories hardcoded in its own bundle.
 *
 * Without this, the panel saw a marker in the file, found nothing matching in its own registry, and
 * concluded the tool was "gone" - so it told the developer to reinstall Claude Code, which the other
 * editor then patched again. The loop had no exit because the exit was in another application.
 *
 * Discovered rather than enumerated: any VS Code fork that stores extensions this way is found
 * without us keeping a list of forks. Never throws.
 */
export function hostExtensionRoots(): { root: string; editor: string }[] {
  const ours = extensionsRoot();
  const home = homedir();
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  const out: { root: string; editor: string }[] = [];
  for (const name of names) {
    if (!name.startsWith('.')) continue;
    const root = path.join(home, name, 'extensions');
    if (root === ours) continue;
    if (!fs.existsSync(path.join(root, 'extensions.json'))) continue;
    out.push({ root, editor: editorName(name) });
  }
  return out;
}

/** One extension belonging to another editor on this machine. */
export interface ElsewhereExtension {
  id: string;
  /** That extension's own folder - the thing to reveal, and the thing to delete. */
  dir: string;
  /** The editor's extensions directory. */
  root: string;
  editor: string;
  /**
   * Uninstalled in that editor, but its folder is still there - so that editor has not restarted
   * since, and is still running it.
   *
   * The state that makes the guidance work. A VS Code editor drops the registry entry the instant
   * you uninstall, and sweeps the folder only at its next start; until then the extension is loaded
   * and doing its job. Registry-only detection therefore reported the tool as gone the moment the
   * developer uninstalled it over there, the flow fell back to the ordinary repair, and the file
   * kept changing back from an application we had just stopped mentioning.
   */
  pendingRemoval: boolean;
}

/**
 * Extensions installed for a DIFFERENT editor on this machine.
 *
 * The folder scan is second and is never mistaken for an install: a folder the registry no longer
 * lists is reported as `pendingRemoval`, which is a different sentence and a different remedy from
 * "it is installed there". It earns its place because this list is only ever consulted to attribute
 * a foreign change we have ALREADY found in the file - so a leftover folder is corroboration, not an
 * alarm raised on a quiet machine.
 */
export function extensionsElsewhere(): ElsewhereExtension[] {
  const out: ElsewhereExtension[] = [];
  for (const { root, editor } of hostExtensionRoots()) {
    const listed = new Set<string>();
    for (const e of readRegistry(root) ?? []) {
      listed.add(e.id.toLowerCase());
      out.push({ ...e, root, editor, pendingRemoval: false });
    }
    for (const f of folderExtensions(root)) {
      if (listed.has(f.id.toLowerCase())) continue;
      out.push({ ...f, root, editor, pendingRemoval: true });
    }
  }
  return out;
}

export function extensionsOnDisk(): { id: string; dir: string }[] {
  const root = extensionsRoot();
  const registry = readRegistry(root);
  if (registry?.length) return registry;

  const obsolete = obsoleteExtensionDirs();
  return folderExtensions(root).filter((e) => !obsolete.has(path.basename(e.dir)));
}

/** An extension's display name from its own package.json, or undefined. Never throws. */
export function extensionDisplayName(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as
      { displayName?: string; name?: string };
    return pkg.displayName ?? pkg.name;
  } catch {
    return undefined;
  }
}

export interface ClaudeTarget {
  /** Absolute path to the extension directory. */
  dir: string;
  /** Version string parsed from the directory name, e.g. "2.1.199". */
  version: string;
  /** Stable identity for recipe/backup keying (the directory basename). */
  buildId: string;
  /** Absolute path to the patch target (Claude Code webview bundle). */
  webviewFile: string;
}

const DIR_RE = /^anthropic\.claude-code-(\d+\.\d+\.\d+)(?:-.*)?$/;

/** Compare two dotted version strings numerically; positive if a > b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Build a ClaudeTarget from a specific extension directory, or undefined. */
function targetFromDir(dir: string): ClaudeTarget | undefined {
  const name = path.basename(dir);
  const m = DIR_RE.exec(name);
  if (!m) return undefined;
  const webviewFile = path.join(dir, 'webview', 'index.js');
  if (!fs.existsSync(webviewFile)) return undefined;
  return { dir, version: m[1]!, buildId: name, webviewFile };
}

/**
 * Resolve the Claude Code build to patch. Prefers `activeDir` — the path VS Code
 * reports for the *running* Claude Code extension — so with several builds
 * installed we never patch one that isn't the active one. Falls back to the
 * highest installed version. Returns undefined if none qualifies. Never throws.
 */
export function findClaudeTarget(activeDir?: string): ClaudeTarget | undefined {
  // 1. The build VS Code is actually running, when we know it.
  if (activeDir) {
    const t = targetFromDir(activeDir);
    if (t) return t;
  }

  // 2. Fallback: the highest-versioned installed build.
  const root = extensionsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  // An uninstalled build is not a candidate, however high its version: after an update the previous
  // directory sits there until VS Code sweeps it, and patching it would write into bytes nothing
  // loads and report health for a build that is not running.
  const obsolete = obsoleteExtensionDirs();
  const candidates: ClaudeTarget[] = [];
  for (const name of entries) {
    if (obsolete.has(name)) continue;
    const t = targetFromDir(path.join(root, name));
    if (t) candidates.push(t);
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => cmpVersion(b.version, a.version));
  return candidates[0];
}
