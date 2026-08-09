import * as vscode from 'vscode';
import {
  formatSettings, formatElements, settingKey, adFormat, ELEMENTS,
  type AdFormatId, type ElementId, type ElementValue, type ResolvedElement,
} from '@awaitful/shared';

/** One object holding every per-format choice, rather than a settings entry per pair. */
const STORE_KEY = 'awaitful.customize';

/** Pre-per-format storage, read once to seed and never written again. */
const LEGACY_BANNER_STYLE_KEY = 'awaitful.chatBannerStyle';
const LEGACY_BANNER_FRAME_KEY = 'awaitful.chatBannerFrame';

/**
 * What each ad format looks like on THIS machine.
 *
 * Every choice is stored per format, keyed `${format}.${element}` - the same shape the account uses,
 * so the account's values drop straight in with no translation. One object in globalState rather
 * than a VS Code settings entry per pair: four formats times their elements is already eight, and
 * the settings UI would be unusable long before we finish adding formats.
 *
 * Nothing else in the client reads a customization setting. Render paths ask this, so there is one
 * place that knows where the values live and one place to change when that moves.
 */
export class Customization {
  constructor(private readonly state: vscode.Memento) {}

  /** Choices this machine has stored, in the account's key shape. */
  private stored(): Record<string, unknown> {
    return this.state.get<Record<string, unknown>>(STORE_KEY) ?? {};
  }

  /**
   * Where a value came from before customization was per-format: two VS Code settings and two
   * globalState keys. Handed to the shared resolver under the OLD key names, which knows how to
   * seed each format from them - so an existing machine keeps its look with no migration step and
   * no second copy of that logic here.
   */
  private legacy(): Record<string, unknown> {
    const cfg = vscode.workspace.getConfiguration('awaitful');
    const out: Record<string, unknown> = {};
    const spinner = cfg.get<string>('adSpinner');
    const brandLogo = cfg.get<boolean>('adBrandLogo');
    const style = this.state.get<string>(LEGACY_BANNER_STYLE_KEY);
    const frame = this.state.get<string>(LEGACY_BANNER_FRAME_KEY);
    if (spinner !== undefined) out['spinner'] = spinner;
    if (brandLogo !== undefined) out['brandLogo'] = brandLogo;
    if (style !== undefined) out['chatBannerStyle'] = style;
    if (frame !== undefined) out['chatBannerFrame'] = frame;
    return out;
  }

  /** Every choice in force here: per-format keys sit ON TOP of the legacy seed, so an explicit
   *  choice always wins. */
  private all(): Record<string, unknown> {
    return { ...this.legacy(), ...this.stored() };
  }

  /** Resolved values for one format: what this machine has chosen, else the element's default. */
  for(format: AdFormatId): Record<ElementId, ElementValue> {
    return formatSettings(this.all(), format);
  }

  /** What the panel draws for one format: each element, its options, and the value in force here. */
  elements(format: AdFormatId): ResolvedElement[] {
    return formatElements(this.all(), format);
  }

  /**
   * Set one element of one format. Used by the panel and by the account reconcile alike.
   *
   * Returns false rather than throwing when the pair is not one this build can draw - an unknown
   * format or element, or a value that has left an option list. The panel's messages arrive from a
   * webview, so this is the boundary that keeps an unrenderable value out of storage entirely.
   */
  async set(format: AdFormatId, element: ElementId, value: ElementValue): Promise<boolean> {
    if (!adFormat(format)?.elements.includes(element)) return false;
    if (!ELEMENTS[element]?.isValid(value)) return false;
    await this.state.update(STORE_KEY, { ...this.stored(), [settingKey(format, element)]: value });
    return true;
  }

  /**
   * Apply the account's choices in one write, so a partial failure cannot leave half a version
   * applied. Returns false if nothing could be written, which keeps the caller from recording the
   * version as applied and makes the next check-in retry.
   */
  async applyAll(pairs: { format: AdFormatId; element: ElementId; value: ElementValue }[]): Promise<boolean> {
    const next = { ...this.stored() };
    for (const p of pairs) {
      if (ELEMENTS[p.element]?.isValid(p.value)) next[settingKey(p.format, p.element)] = p.value;
    }
    try {
      await this.state.update(STORE_KEY, next);
      return true;
    } catch {
      return false;
    }
  }
}
