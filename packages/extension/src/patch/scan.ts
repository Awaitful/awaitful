import * as fs from 'node:fs';
import * as path from 'node:path';
import { MARKER_PREFIX, SHIM_VERSION } from './recipe.js';
import { foreignMarkerToken } from './foreign.js';
import type { ClaudeTarget } from './targets.js';

/**
 * The files we patch, independent of any build. Recipes name the same two, but a recipe is exactly
 * what we do NOT have when a build is new or a competitor has moved in - and those are precisely
 * the moments we most need to know who is holding the file.
 */
export const TARGET_FILES = ['webview/index.js', 'extension.js'] as const;

/** Whose patch is in a file, and which version of ours. */
export type OursState = 'absent' | 'current' | 'older' | 'newer';

export interface TargetScan {
  /** Relative path, one of TARGET_FILES. */
  file: string;
  abs: string;
  readable: boolean;
  /** Why it could not be read - drives honest copy ("mid-update" vs "check permissions"). */
  errno?: 'ENOENT' | 'EACCES' | 'OTHER';
  bytes?: string;
  ours: OursState;
  oursVersion?: number;
  /** Another tool's marker in the LIVE bytes. Proof the file is modified right now. */
  foreignToken?: string;
  /**
   * A sibling backup another tool left behind. A RECOVERY SOURCE ONLY - never evidence that the
   * live file is modified. A competitor can uninstall and leave its backup; the file may be
   * perfectly pristine. Conflating the two is how a clean machine gets accused.
   */
  siblingBackup?: string;
}

// Our own marker carries its shim version: `/* AWAITFUL-START v25 */`.
const OUR_VERSION_RE = /\/\*\s*AWAITFUL-START\s+v(\d+)\s*\*\//;

function readErrno(err: unknown): 'ENOENT' | 'EACCES' | 'OTHER' {
  const code = (err as { code?: string } | undefined)?.code;
  return code === 'ENOENT' || code === 'EACCES' ? code : 'OTHER';
}

/**
 * Look at both targets without a recipe, without hashing, and without writing.
 *
 * This exists because foreign detection used to be a CHILD of recipe resolution: `assess()` bailed
 * to `unknown-build` before it ever looked for another tool's marker, so a competitor - the very
 * thing that breaks recipe resolution - was invisible, and the panel blamed the Claude Code version
 * for someone else's edit. Scanning first inverts that. Never throws.
 */
export function scanTargets(target: ClaudeTarget): TargetScan[] {
  return TARGET_FILES.map((file) => {
    const abs = path.join(target.dir, file);
    let bytes: string | undefined;
    let errno: 'ENOENT' | 'EACCES' | 'OTHER' | undefined;
    try {
      bytes = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      errno = readErrno(err);
    }

    const scan: TargetScan = { file, abs, readable: bytes !== undefined, ours: 'absent' };
    if (errno) scan.errno = errno;
    if (bytes === undefined) return scan;

    scan.bytes = bytes;
    if (bytes.includes(MARKER_PREFIX)) {
      const v = OUR_VERSION_RE.exec(bytes);
      const n = v ? Number(v[1]) : NaN;
      if (Number.isFinite(n)) {
        scan.oursVersion = n;
        scan.ours = n === SHIM_VERSION ? 'current' : n > SHIM_VERSION ? 'newer' : 'older';
      } else {
        // Our marker with an unparseable version: present, and certainly not current.
        scan.ours = 'older';
      }
    }

    const token = foreignMarkerToken(bytes);
    if (token) scan.foreignToken = token;

    const sibling = findSiblingBackup(abs);
    if (sibling) scan.siblingBackup = sibling;
    return scan;
  });
}

/** Any `<target>.<something>-backup`-shaped sibling, whoever left it. Never throws. */
function findSiblingBackup(abs: string): string | undefined {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (name === base || !name.startsWith(base + '.')) continue;
    if (name.endsWith('.awaitful-tmp')) continue;
    if (/[.\-_](backup|bak|orig|original|save|old)$/i.test(name)) return path.join(dir, name);
  }
  return undefined;
}

/** Is any target carrying another tool's marker in its live bytes? */
export function anyForeignInFile(scans: readonly TargetScan[]): TargetScan | undefined {
  return scans.find((s) => s.foreignToken !== undefined);
}

/** Is our marker on any target? */
export function anyOurs(scans: readonly TargetScan[]): boolean {
  return scans.some((s) => s.ours !== 'absent');
}

/**
 * True when a target carries a NEWER shim than this extension build. A window running an older
 * Awaitful must stand down rather than rewrite the file back - otherwise two windows on different
 * versions rewrite a multi-megabyte bundle at each other indefinitely, which no reclaim budget
 * bounds because neither side ever sees the state as `modified`.
 */
export function anyNewerThanOurs(scans: readonly TargetScan[]): boolean {
  return scans.some((s) => s.ours === 'newer');
}
