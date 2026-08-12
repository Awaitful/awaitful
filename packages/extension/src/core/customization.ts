// Type-only: with the legacy VS Code settings gone this file touches no VS Code API at all, just a
// Memento it is handed. That is the shape it should have had - storage logic, nothing environmental.
import type * as vscode from 'vscode';
import {
  formatSettings, formatElements, settingKey, adFormat, ELEMENTS,
  type AdFormatId, type ElementId, type ElementValue, type ResolvedElement,
} from '@awaitful/shared';

/** One object holding every per-format choice, rather than a settings entry per pair. */
const STORE_KEY = 'awaitful.customize';

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

  /** Resolved values for one format: what this machine has chosen, else the element's default. */
  for(format: AdFormatId): Record<ElementId, ElementValue> {
    return formatSettings(this.stored(), format);
  }

  /** What the panel draws for one format: each element, its options, and the value in force here. */
  elements(format: AdFormatId): ResolvedElement[] {
    return formatElements(this.stored(), format);
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
