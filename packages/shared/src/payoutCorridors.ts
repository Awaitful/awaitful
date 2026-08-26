/**
 * Payout corridors — what a developer in a given country must tell us for the money to land.
 *
 * ONE declarative entry per payout country, shared by the web (which renders the form) and the server
 * (which shapes the rail payload and the destination mask), so the two can never drift apart. Adding a
 * country is a data entry here, not a new branch in the onboarding component.
 *
 * These entries are a TYPED CACHE of the rail's own account-requirements response, never an independent
 * claim. Wise is the validator of record: it rejects a malformed payload with a 4xx that
 * `isDefinitiveRejection` already classifies as safe-to-reverse, and its requirements DRIFT (BRL began
 * requiring `email` after this corridor was first documented). So the field patterns here are deliberately
 * PERMISSIVE - they catch a typo early and keep the developer out of a pointless round-trip; they do not
 * try to out-validate the rail. Reconcile a corridor against
 * `GET /v1/quotes/{quoteId}/account-requirements` before opening it, and after any Wise changelog entry
 * that touches it.
 */

/** A field the developer fills in. `key` is the key the rail expects inside its `details` object. */
export interface PayoutCorridorField {
  key: string;
  label: string;
  placeholder?: string;
  /** A short hint under the field, when the label alone would leave the developer guessing. */
  note?: string;
  /** Serializable regex SOURCE (not a RegExp), so this module stays plain data. */
  pattern?: string;
  /**
   * A named structural check the field must also pass, for a format whose validity is arithmetic rather
   * than shape - a Brazilian CPF carries two mod-11 check digits, so "eleven digits" accepts a great many
   * numbers that are not CPFs. Named (not a function) to keep corridors serializable data; `checkFns` below
   * holds the implementations.
   */
  check?: 'cpf';
  /** Shown when the value is empty or fails `pattern`. Written in the user's own terms (docs/VOICE.md). */
  error: string;
  optional?: boolean;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
  /** Uppercase as the developer types (IFSC codes are conventionally upper). */
  uppercase?: boolean;
  /** Fixed choices. Two options render as chips, more as a select. */
  options?: readonly { value: string; label: string }[];
  /**
   * This field's choices are not fixed - they come from the RAIL, live (Brazil's 104-and-counting bank
   * codes). The client fetches them and renders a select; if that fetch fails the field degrades to a text
   * input governed by `pattern`, so a rail outage narrows the help we can give rather than blocking
   * onboarding outright. Freezing such a list here would make a newly-added bank unselectable.
   */
  optionsFrom?: 'rail';
  /** Only collect this field when another field holds a given value (e.g. CNPJ only for a business). */
  showWhen?: { field: string; equals: string };
  /** Kept off the review screen - for a field that is a mode switch rather than a destination detail. */
  reviewHidden?: boolean;
}

/** One way to be paid in a corridor: a bank account, a UPI ID, a Pix key. */
export interface PayoutCorridorMethod {
  /** Our stable id (the value behind the method switch). Independent of the rail's own naming. */
  id: string;
  /** The label on the method switch, and the "Paid to" row on review. */
  label: string;
  /**
   * How to name what we are about to send, mid-sentence, in the confirm dialog ("we send your name and
   * your UPI ID to Wise"). Spelled out per method rather than derived from `label`, because deriving it
   * mangles an initialism - lowercasing "UPI" gives "upi", and the one screen that states exactly what
   * leaves the developer's machine is the last place to be sloppy about it.
   */
  confirmNoun: string;
  /**
   * A hint under the "Name on the account" field, where the corridor imposes more than "as it appears on
   * your statement". Brazil matches the name against the one registered to the CPF, and a mismatch is
   * rejected by the rail at the final step - the developer needs to know that before they type, not after.
   */
  holderNote?: string;
  /** The rail's recipient type - Wise's `type` on POST /v1/accounts. */
  recipientType: string;
  fields: readonly PayoutCorridorField[];
  /**
   * Values the rail requires that the developer never picks. Merged into `details` at submit. Keeping a
   * fixed value here (rather than as a one-option field) means the form has no control that cannot change
   * anything, and the constraint is stated once, in writing, where the corridor is defined.
   */
  staticDetails?: Readonly<Record<string, string>>;
  /**
   * Which field becomes the stored `destinationMask` - the short, non-sensitive label a developer uses to
   * recognise their own account later. `last4` keeps only the final four characters (never a full account
   * number); `full` keeps the value as-is, for an identifier that IS the recognisable thing (a UPI ID).
   */
  mask: { field: string; style: 'last4' | 'full' };
}

export interface PayoutCorridor {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** The rail's settlement currency for this country - the quote's target currency. */
  currency: string;
  /**
   * A corridor floor on the withdrawal minimum, in USD, when this corridor's fee would eat too much of a
   * small payout. Raises the platform's two-tier threshold; never lowers it. Absent = the platform tiers
   * stand alone.
   */
  minPayoutUsd?: number;
  methods: readonly PayoutCorridorMethod[];
}

// ── India (INR) ───────────────────────────────────────────────────────────────────────────────────────
// The launch Wise corridor, ported here field-for-field from the original hardcoded form so that behaviour
// for a LIVE rail carrying real money is unchanged: same patterns, same payload keys (note UPI reuses
// `accountNumber` for the handle - that is Wise's shape, not a copy/paste slip), same mask, same order.
// Deliberately NO `minPayoutUsd`: India ships today on the platform's $5/$10 tiers, and quietly raising an
// existing corridor's floor would strand developers who are already saving toward the current bar. Raising
// it is a product decision, taken on its own.
const INDIA: PayoutCorridor = {
  country: 'IN',
  currency: 'INR',
  methods: [
    {
      id: 'bank',
      label: 'Bank account',
      confirmNoun: 'bank details',
      recipientType: 'indian',
      mask: { field: 'accountNumber', style: 'last4' },
      fields: [
        {
          key: 'ifscCode',
          label: 'IFSC code',
          placeholder: 'HDFC0001234',
          pattern: '^[A-Za-z]{4}0[A-Za-z0-9]{6}$',
          error: 'That does not look like an IFSC code (e.g. HDFC0001234).',
          uppercase: true,
        },
        {
          key: 'accountNumber',
          label: 'Account number',
          placeholder: 'Your bank account number',
          pattern: '^[a-zA-Z0-9]{5,20}$',
          error: 'Enter your account number (5 to 20 digits/letters).',
          inputMode: 'numeric',
        },
        {
          key: 'legalType',
          label: 'Account type',
          options: [{ value: 'PRIVATE', label: 'Individual' }, { value: 'BUSINESS', label: 'Business' }],
          error: 'Choose whether this is an individual or business account.',
          reviewHidden: true,
        },
      ],
    },
    {
      id: 'upi',
      label: 'UPI',
      confirmNoun: 'UPI ID',
      recipientType: 'indian_upi',
      mask: { field: 'accountNumber', style: 'full' },
      fields: [
        {
          key: 'accountNumber',
          label: 'UPI ID',
          placeholder: 'name@bank',
          pattern: '^[\\w.-]+@[\\w.-]+$',
          error: 'Enter a UPI ID (e.g. name@bank).',
        },
        {
          key: 'legalType',
          label: 'Account type',
          options: [{ value: 'PRIVATE', label: 'Individual' }, { value: 'BUSINESS', label: 'Business' }],
          error: 'Choose whether this is an individual or business account.',
          reviewHidden: true,
        },
      ],
    },
  ],
};

// ── Brazil (BRL) ──────────────────────────────────────────────────────────────────────────────────────
// Wise recipient type `brazil`. RECONCILED against the live sandbox account-requirements for USD->BRL on
// 2026-08-25, which is the authority here - and which disagreed with Wise's published reference example in
// four ways worth recording, because each would have cost a developer a failed attempt:
//   - `phoneNumber` is NOT requested at all (the old reference example includes it). Dropped: collecting a
//     phone number we never send would be exactly the sort of quiet over-collection we promise not to do.
//   - `email` is OPTIONAL for a private recipient (it is required only on `brazil_business`).
//   - `branchCode` is `^[\d\-]{3,5}[\dxX]$` - it accepts a dash and a trailing check digit, so the obvious
//     "four or five digits" rule would have rejected valid agência numbers.
//   - `accountNumber` has NO pattern, only length 2..21. Anything stricter invents a rule Wise does not have.
//
// INDIVIDUAL RECIPIENTS ONLY, and now confirmed rather than assumed: the live requirements list exactly one
// allowed `legalType` for this type - PRIVATE. Business recipients are a SEPARATE type (`brazil_business`,
// keyed on CNPJ), so the old "business customers are not supported yet" warning is stale, not a blocker.
// Our developer is an individual, so `brazil` is the right type and pinning PRIVATE is what Wise itself does.
//
// Pix is NOT offered, also now confirmed: the requirements response returns only `brazil`,
// `brazil_business` and `email` - there is no Pix recipient type to target.
const BRAZIL: PayoutCorridor = {
  country: 'BR',
  currency: 'BRL',
  // Sized from MEASURED sandbox quotes (see WISE_FEE_SCHEDULE): ~$0.41 fixed + ~0.86% means $20 lands at
  // ~2.9% all-in, just inside the ~3% rule, while $10 would be ~4.9%.
  //
  // This is the corridor's OPENING position, not its final one: `PayoutCountryPolicy` in the database
  // overrides it per country, so raising Brazil's floor once live fees are measured is an admin change
  // rather than a deploy. Resolution is DB override -> this default -> none, then a `max` against the
  // platform tiers.
  minPayoutUsd: 20,
  methods: [
    {
      id: 'bank',
      label: 'Bank account',
      confirmNoun: 'bank account details',
      holderNote: 'Your full name as registered to your CPF. Wise checks the two match, and a mismatch is refused.',
      recipientType: 'brazil',
      mask: { field: 'accountNumber', style: 'last4' },
      staticDetails: { legalType: 'PRIVATE' },
      fields: [
        {
          key: 'bankCode',
          label: 'Your bank',
          // Wise accepts only its own list of Brazilian institution codes (104 of them as of 2026-08-25,
          // and it moves), so the options are fetched live from the rail rather than frozen here - a stale
          // copy would make a newly-added bank unselectable, which blocks a developer outright. The
          // pattern is the fallback rule for when that fetch fails and the field degrades to free text.
          optionsFrom: 'rail',
          placeholder: '237',
          note: 'The three-digit code for your bank, on your statement or in your banking app.',
          pattern: '^\\d{3}$',
          error: 'Choose your bank.',
          inputMode: 'numeric',
        },
        {
          key: 'branchCode',
          label: 'Branch number',
          placeholder: '1234',
          note: 'Your agência, including its check digit if it has one.',
          pattern: '^[\\d\\-]{3,5}[\\dxX]$',
          error: 'Enter your branch number, as it appears in your banking app.',
        },
        {
          key: 'accountNumber',
          label: 'Account number',
          placeholder: '12345678-9',
          note: 'Your conta, including the check digit after the dash.',
          // Wise sets no pattern here, only a 2..21 length. Match that rather than invent a stricter rule.
          pattern: '^.{2,21}$',
          error: 'Enter your account number, including the digit after the dash.',
        },
        {
          key: 'accountType',
          label: 'Account type',
          options: [{ value: 'CHECKING', label: 'Checking' }, { value: 'SAVINGS', label: 'Savings' }],
          error: 'Choose whether this is a checking or savings account.',
        },
        {
          key: 'cpf',
          label: 'CPF',
          placeholder: '000.000.000-00',
          // Wise checks the CPF twice: its check digits, and whether it is registered to the name given
          // above. We can verify the first here; only Wise can do the second, so the note warns about it
          // rather than letting the developer discover it after confirming.
          note: 'Your Brazilian taxpayer number, registered to the same name as above.',
          check: 'cpf',
          error: 'That CPF does not look right. Check the digits and try again.',
        },
        {
          key: 'email',
          label: 'Email',
          optional: true,
          placeholder: 'you@example.com',
          note: 'Optional. Your bank may use it to contact you about the transfer.',
          pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
          error: 'Enter an email address, or leave this blank.',
          inputMode: 'email',
        },
      ],
    },
  ],
};

/** Every corridor we can pay, keyed by ISO-2. */
export const PAYOUT_CORRIDORS: Readonly<Record<string, PayoutCorridor>> = {
  IN: INDIA,
  BR: BRAZIL,
};

/** The corridor for a country, or undefined when none is defined. Case-insensitive. */
export function getPayoutCorridor(country: string): PayoutCorridor | undefined {
  return PAYOUT_CORRIDORS[country.toUpperCase()];
}

/** The settlement currency for a country - the target currency of the rail's quote. */
export function payoutCorridorCurrency(country: string): string | undefined {
  return getPayoutCorridor(country)?.currency;
}

/** One method within a corridor, by our stable method id. */
export function getPayoutCorridorMethod(country: string, methodId: string): PayoutCorridorMethod | undefined {
  return getPayoutCorridor(country)?.methods.find(m => m.id === methodId);
}

/** Every country a corridor is defined for. NOT the same as "offerable" - the rail decides that. */
export const PAYOUT_CORRIDOR_COUNTRIES: readonly string[] = Object.keys(PAYOUT_CORRIDORS);

/**
 * Is this a real CPF? A Brazilian CPF is nine digits plus two mod-11 check digits, so an eleven-digit
 * length test accepts a huge number of values that Wise will reject at the very last step of onboarding -
 * after the developer has already confirmed. Checking the arithmetic here turns that into an inline field
 * error while they are still typing.
 *
 * Wise's own published example CPF (123.456.789-12) fails this, which is how the gap was found.
 * Repdigits (111.111.111-11 and friends) satisfy the arithmetic but are not issuable, and every Brazilian
 * validator rejects them, so they are excluded explicitly.
 */
export function isValidCpf(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const digitAt = (i: number): number => Number(digits[i]);
  for (const [length, start] of [[9, 10], [10, 11]] as const) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += digitAt(i) * (start - i);
    const remainder = sum % 11;
    const expected = remainder < 2 ? 0 : 11 - remainder;
    if (digitAt(length) !== expected) return false;
  }
  return true;
}

/** The structural checks a corridor field can name, by id. */
const checkFns: Record<NonNullable<PayoutCorridorField['check']>, (value: string) => boolean> = {
  cpf: isValidCpf,
};

/** Whether a field applies, given what the developer has filled in so far (`showWhen`). */
export function isPayoutFieldActive(
  field: PayoutCorridorField,
  values: Readonly<Record<string, string>>,
): boolean {
  return !field.showWhen || values[field.showWhen.field] === field.showWhen.equals;
}

/** The fields actually being collected for a method, given the current values. */
export function activePayoutFields(
  method: PayoutCorridorMethod,
  values: Readonly<Record<string, string>>,
): PayoutCorridorField[] {
  return method.fields.filter(f => isPayoutFieldActive(f, values));
}

/**
 * Validate a method's collected values. Returns `{ fieldKey: message }`, empty when valid. Shared so the
 * web shows the same message the server would, and neither has to restate the rules.
 */
export function validatePayoutFields(
  method: PayoutCorridorMethod,
  values: Readonly<Record<string, string>>,
  /**
   * The rail's own choices for `optionsFrom: 'rail'` fields, when they loaded. A rail-backed field is
   * validated by MEMBERSHIP of this list, never by `pattern` - the rail owns the valid set, and a shape
   * rule we invented would reject a perfectly good value the moment the rail's format differs from what we
   * assumed. `pattern` stays the rule for the degraded case only: options did not load, so the field fell
   * back to a text input and a rough shape check is better than nothing.
   */
  railOptions?: Readonly<Record<string, readonly { value: string; label: string }[]>>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of activePayoutFields(method, values)) {
    const raw = (values[field.key] ?? '').trim();
    if (!raw) {
      if (!field.optional) errors[field.key] = field.error;
      continue;
    }
    if (field.options && !field.options.some(o => o.value === raw)) {
      errors[field.key] = field.error;
      continue;
    }
    if (field.optionsFrom === 'rail') {
      const choices = railOptions?.[field.key];
      // Only judge it when we actually know the set. Without the list, anything non-empty passes here and
      // the rail has the final say - refusing a value we cannot check would strand the developer.
      if (choices?.length && !choices.some(o => o.value === raw)) errors[field.key] = field.error;
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(raw)) {
      errors[field.key] = field.error;
      continue;
    }
    if (field.check && !checkFns[field.check](raw)) {
      errors[field.key] = field.error;
    }
  }
  return errors;
}

/**
 * The rail `details` payload for a method: every active field's trimmed value, uppercased where the field
 * asks, plus the method's fixed values. Optional fields that are blank are omitted rather than sent empty.
 */
export function payoutDetailsPayload(
  method: PayoutCorridorMethod,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const details: Record<string, string> = { ...method.staticDetails };
  for (const field of activePayoutFields(method, values)) {
    const raw = (values[field.key] ?? '').trim();
    if (!raw) continue;
    details[field.key] = field.uppercase ? raw.toUpperCase() : raw;
  }
  return details;
}

/**
 * The short, non-sensitive destination label stored alongside the account, derived the SAME way on the
 * server (which persists it) and the web (which previews it on the review screen), so what a developer
 * confirms is exactly what they will see later.
 */
export function payoutDestinationMask(
  method: PayoutCorridorMethod,
  details: Readonly<Record<string, string>>,
): string {
  const value = (details[method.mask.field] ?? '').trim();
  if (!value) return '';
  if (method.mask.style === 'full') return value;
  // Strip formatting before taking the last four, so a Brazilian "12345678-9" masks to the recognisable
  // ····6789 rather than ····78-9 (which would spend two of the four characters on punctuation). India's
  // account numbers carry no punctuation, so this is a no-op there and its masks are unchanged.
  const digits = value.replace(/[^A-Za-z0-9]/g, '');
  return digits.length > 4 ? `····${digits.slice(-4)}` : digits;
}

/** The default (empty) value map for a method - selects start on their first option. */
export function initialPayoutValues(method: PayoutCorridorMethod): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of method.fields) {
    values[field.key] = field.options?.[0]?.value ?? '';
  }
  return values;
}
