import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Detect whether Claude Code has been modified by another extension, and NAME the responsible
 * extension when — and only when — it is actually installed here. A vague "another extension"
 * reads as a false positive; a named one is actionable ("Acme is modifying Claude Code"). But a
 * name we cannot verify is worse than either, because it sends the user looking for something
 * that may not exist.
 *
 * We hardcode no tool names. Attribution is generic, from two fingerprints another
 * extension leaves behind:
 *   1. an in-file patch marker it wrapped its injection in (a `NAME-START` … `NAME-END`
 *      comment), read straight out of the file we refuse to touch — the strongest, most
 *      direct signal, and present even when the tool kept its backup elsewhere; and
 *   2. a sibling backup of the original it saved next to the target
 *      ("index.js.NAME-backup"), which also doubles as a verified-pristine source.
 *
 * Those two say different things and must not be conflated: only the in-file marker proves the
 * live file is modified NOW. A leftover backup proves only that a tool once ran here — the file
 * beside it may be perfectly pristine.
 *
 * The safety decision (patch or not) is still made purely by hash elsewhere; this
 * module only supplies presence + an optional verified name + an optional pristine source.
 */

/**
 * Whether the named tool is actually installed here. Drives copy and actions: offering
 * "Turn off Acme" for something the user uninstalled months ago sends them hunting for a thing
 * that does not exist, and naming a vendor we cannot find asserts more than we know.
 *
 *  - `yes`      an ACTIVE extension matches the token; `vendor` is its real display name.
 *  - `disabled` it is installed but switched off. A distinct state, not a variant of `no`: turning
 *               a tool off does not undo the change it already made, so the file is still contested
 *               and the developer still has something to act on. VS Code's extension API lists only
 *               ENABLED extensions, so without a disk check this looked identical to `no` - and the
 *               panel fell back to quoting a raw marker token at someone whose tool was right there.
 *  - `removing`  uninstalled HERE, but still loaded and still running until the window reloads. An
 *               editor drops the registry entry at once and keeps the code alive until it restarts,
 *               so this is the gap between clicking Remove and that click taking effect. It has to
 *               be its own state: reading it as `yes` made the Remove button look like it had done
 *               nothing, and reading it as `no` would claim a reload that has not happened.
 *  - `elsewhere` installed for a DIFFERENT editor on this machine. Not a variant of `no` and not a
 *               variant of `yes`: it is genuinely absent from this window's list, so every button we
 *               have here is useless against it, yet it is running and re-applying its change. The
 *               only fix is in the other application, so the copy has to say which one.
 *  - `no`       nothing on disk matched. Say "another tool", and quote the raw marker token as a
 *               fact ("The change is marked VIBE-ADS."). Also means the remove step is already done.
 *  - `unknown`  we could not look (no lookup injected). Never suppress remedies on this.
 */
export type VendorInstalled = 'yes' | 'disabled' | 'removing' | 'no' | 'elsewhere' | 'unknown';

/**
 * Resolve a marker/backup token to an installed extension. Injected so this module needs no `vscode`.
 * `active` separates "running" from "installed but switched off" - see VendorInstalled.
 * `host` marks a hit that belongs to another editor entirely, which no button here can act on.
 */
export interface VendorHost {
  /** The editor's familiar name, e.g. "VSCodium" - never the dot directory it lives in. */
  label: string;
  /** Its extensions directory. */
  dir: string;
  /** That extension's own folder: what to reveal, and what to delete by hand. */
  extensionDir?: string;
  /** Uninstalled there but not yet swept, so that editor has not restarted and still runs it. */
  pendingRemoval?: boolean;
}

export type InstalledLookup = (token: string) =>
  | { id: string; label: string; active: boolean; host?: VendorHost; pendingRemoval?: boolean }
  | undefined;

export interface ForeignDetection {
  /** Another extension's fingerprint was found (in-file marker or sibling backup). */
  present: boolean;
  /**
   * Another tool's marker is in the LIVE bytes. This - not `present` - is proof the file is
   * modified right now. `present` is also true for a bare leftover sibling backup, which proves
   * only that a tool once ran here.
   */
  inFile?: boolean;
  /** The raw marker/backup token as found on disk, e.g. "VIBE-ADS". Never a claim about a vendor. */
  token?: string;
  /** Display name of the responsible extension, only when it is actually installed. */
  vendor?: string;
  /** Its extension id (publisher.name), so the panel can open THAT extension's page rather than
   *  leaving the developer to find it in a search result. Set only alongside `vendor`. */
  vendorId?: string;
  vendorInstalled?: VendorInstalled;
  /** Which other editor holds it, and where. Set only alongside `vendorInstalled: 'elsewhere'`. */
  vendorHost?: VendorHost;
  /** Path to the sibling backup, if any (a verified-pristine source for take-over). */
  backupPath?: string;
}

// Our own transient/owned filenames must never be treated as another extension's backup.
const OURS = ['.awaitful-tmp'];
// Trailing words commonly appended to a backup filename; stripping them leaves a
// name token (e.g. "index.js.acme-backup" → "acme").
const BACKUP_WORDS = /[.\-_](backup|bak|orig|original|save|old)$/i;

// A foreign patch tool's block marker, e.g. "/* ACME-START v3 */" or "/* OTHERTOOL-START".
// We capture the NAME token generically and never enumerate specific tools; our own marker
// (AWAITFUL) is skipped so we never attribute our own patch to a "competitor".
const FOREIGN_MARKER = /\/\*\s*([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)[-_](?:START|BEGIN)\b/g;
const OUR_MARKER_TOKEN = 'awaitful';

/**
 * Detect a foreign modification of `targetFile`. Pass the file's `content` (callers have
 * usually already read it) to enable the strongest signal — the in-file patch marker;
 * without it, only the sibling-backup scan runs. Never throws.
 */
export function detectForeign(
  targetFile: string,
  content?: string,
  lookup?: InstalledLookup,
): ForeignDetection {
  const markerToken = content ? foreignMarkerToken(content) : undefined;
  const sibling = siblingBackup(targetFile);

  if (!sibling.present && !markerToken) return { present: false };

  // The in-file marker is the stronger signal (it describes the bytes we are looking at), so it
  // names the token; the backup token is the fallback and may be an older product name.
  const token = markerToken ?? sibling.token;
  const out: ForeignDetection = { present: true };
  if (markerToken !== undefined) out.inFile = true;
  if (token) out.token = token;
  if (sibling.backupPath) out.backupPath = sibling.backupPath;

  if (!token) {
    out.vendorInstalled = 'unknown';
    return out;
  }
  if (!lookup) {
    // No way to check the installed set: name nothing, and never suppress a remedy on this.
    out.vendorInstalled = 'unknown';
    return out;
  }
  // Try the in-file token and the backup token independently - a tool may mark files with one
  // name and save backups under another.
  const hit = lookup(token) ?? (sibling.token && sibling.token !== token ? lookup(sibling.token) : undefined);
  if (hit) {
    out.vendor = hit.label;
    out.vendorId = hit.id;
    // A hit in another editor is never 'disabled': it is not switched off, it is running somewhere
    // this window has no reach into, which is a different problem with a different remedy.
    out.vendorInstalled = hit.host
      ? 'elsewhere'
      : hit.pendingRemoval
        // Uninstalled here and still running: neither gone nor installed, and the difference is the
        // reload the developer has not done yet.
        ? 'removing'
        : hit.active ? 'yes' : 'disabled';
    if (hit.host) out.vendorHost = hit.host;
  } else {
    out.vendorInstalled = 'no';
  }
  return out;
}

/**
 * Build an InstalledLookup over a snapshot of installed extensions. The orchestrator passes
 * `vscode.extensions.all`; tests pass a literal. Matches on extension id and display name, so a
 * marker token like "vibe-ads" finds "publisher.vibe-ads" or a "Vibe Ads" display name.
 */
export function installedLookup(
  installed: readonly {
    id: string; label: string; active: boolean; host?: VendorHost; pendingRemoval?: boolean;
  }[],
): InstalledLookup {
  return (token: string) => {
    if (token.length < 3) return undefined; // too short/generic to attribute
    const needle = token.toLowerCase().replace(/[-_]/g, '');
    const norm = (s: string) => s.toLowerCase().replace(/[-_\s.]/g, '');
    for (const ext of installed) {
      const id = ext.id.toLowerCase();
      if (id.startsWith('anthropic.claude-code') || id.startsWith('awaitful')) continue;
      if (norm(ext.id).includes(needle) || norm(ext.label).includes(needle)) return ext;
    }
    return undefined;
  };
}

/**
 * First foreign patch marker's NAME token found in the file, excluding our own.
 *
 * Exported because it is also the contamination check: any content we are about to treat as
 * PRISTINE must contain none of these. Deriving a "pristine" that still carries another tool's
 * block is how a competitor's code gets hashed as the original and written back as ours - the
 * defect that poisoned 49 stored backups in the field.
 */
export function foreignMarkerToken(content: string): string | undefined {
  FOREIGN_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOREIGN_MARKER.exec(content)) !== null) {
    const token = m[1];
    if (token && token.toLowerCase() !== OUR_MARKER_TOKEN) return token;
  }
  return undefined;
}

/** Look for a sibling backup of the target and derive which extension made it. Never throws. */
function siblingBackup(targetFile: string): ForeignDetection {
  const dir = path.dirname(targetFile);
  const base = path.basename(targetFile);

  let siblings: string[];
  try {
    siblings = fs.readdirSync(dir);
  } catch {
    return { present: false };
  }

  for (const name of siblings) {
    if (name === base) continue;
    if (!name.startsWith(base + '.')) continue;         // must be `<target>.<suffix>`
    if (OURS.some((o) => name.endsWith(o))) continue;    // skip our own files
    const suffix = name.slice(base.length);              // e.g. ".acme-backup"
    if (!BACKUP_WORDS.test(suffix)) continue;            // must look like a backup

    const token = suffix.replace(/^[.\-_]/, '').replace(BACKUP_WORDS, '').trim();
    const backupPath = path.join(dir, name);
    return token ? { present: true, token, backupPath } : { present: true, backupPath };
  }

  return { present: false };
}
