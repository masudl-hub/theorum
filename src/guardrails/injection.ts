/**
 * Prompt-injection span detection.
 *
 * These utilities return spans that can be redacted from untrusted user text
 * before provider submission.
 *
 * @module
 */

import { blobAt, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';

const IGNORE_PREVIOUS =
  /ignore\s+(all\s+)?(previous|prior)\s+((?:safety|security|system|operational|internal|core|original|initial|existing|given|stated|provided|defined|specified|established)\s+)?(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const DISREGARD_INSTRUCTIONS =
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const FORGET_INSTRUCTIONS =
  /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const NEW_INSTRUCTIONS = /new\s+instructions?:/gi;
const DO_NOT_FOLLOW = /do\s+not\s+follow\s+(the\s+)?(system|developer|previous|original)/gi;
const SUPERSEDE_INSTRUCTIONS =
  /supersedes?\s+(all\s+)?(prior|previous)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const VOID_INSTRUCTIONS =
  /(all\s+)?(previous|prior)\s+instructions?\s+(are|is)\s+(void|invalid|null|obsolete|cancelled|revoked)/gi;
const DEVELOPER_MODE = /you\s+are\s+now\s+(in\s+)?developer\s+mode/gi;
const ENTER_SPECIAL_MODE = /enter\s+(developer|admin|debug|maintenance)\s+mode/gi;
const ACTIVATE_SPECIAL_MODE = /activate\s+(developer|admin|debug|jailbreak)\s+mode/gi;
const SYSTEM_OVERRIDE = /\bsystem\s+override\b/gi;
const OVERRIDE_INSTRUCTIONS =
  /override\s+(your\s+)?(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const REVEAL_PROMPT =
  /reveal\s+((?:your?|yoru|yuor|the|my|its|his|her|our|their)\s+)?((?:(?:full|hidden|complete|internal|secret|original|entire|exact|actual|real)\s+){0,2})((?:system|systme|sysetm|systemp?)\s+)?prompt\b/gi;
const SHOW_PROMPT =
  /show\s+(me\s+)?((?:your?|yoru|yuor|the|my|its|his|her|our|their)\s+)((?:system|systme|sysetm|systemp?)\s+)?prompt\b/gi;
const WHAT_INSTRUCTIONS = /what\s+(are|were)\s+(your\s+)?(exact\s+)?instructions/gi;
const REPEAT_INSTRUCTIONS = /repeat\s+(the\s+)?(text|instructions?)\s+(above|before)/gi;
const OUTPUT_PROMPT = /output\s+(your\s+)?(initial|original|system)\s+(prompt|instructions?)/gi;
const REMOVE_RESTRICTIONS = /you\s+are\s+no\s+longer\s+(bound|restricted|limited)/gi;
const ACT_UNBOUND = /act\s+as\s+if\s+(you('re|\s+are)\s+)?not\s+bound/gi;
const PRETEND_DIFFERENT =
  /pretend\s+(you('re|\s+are)\s+)?(a\s+)?different\s+(ai|assistant|model)/gi;
const IDENTITY_HIJACK =
  /you\s+are\s+now\s+(?:(?:a|an)\s+)?\w+.{0,40}(without\s+(any\s+)?restrict|ignor\w*\s+(all|any|every|prev)|bypass|unrestrict|unlimit|obey\s+only|no\s+(rules|limits|restrict|boundari))/gi;
const DAN_JAILBREAK = /\bDAN\b[\s\S]{0,120}\bdo\s+anything\s+now\b/g;
const JAILBREAK_MODE = /jailbreak(ed)?\s+(mode|prompt)/gi;
const DO_ANYTHING_NOW = /\bdo\s+anything\s+now\b/gi;
const BYPASS_SAFETY =
  /bypass\s+(your\s+)?(safety|security|content|ethical)\s+(filters?|measures?|guidelines?|restrictions?)/gi;
const DISABLE_SAFETY = /disable\s+(your\s+)?(safety|security|content)\s+(filters?|measures?)/gi;
const IGNORE_SAFETY =
  /(ignore|disregard)\s+(all\s+)?(your\s+)?(safety|security|ethical|content)\s+(guidelines?|rules?|restrictions?|measures?|filters?|polic(?:y|ies)|protocols?)/gi;
const SYSTEM_TAG = /<\s*\/?\s*system\s*\/?>/gi;
const ROLE_TAG = /<\s*\/?\s*(assistant|developer|tool|function)\s*\/?>/gi;
const ROLE_DELIMITER = /\]\s*\n\s*\[?(system|assistant|user)\]?:/gi;
const BRACKETED_ROLE = /\[\s*(System\s*Message|System|Assistant|Internal)\s*\]/gi;
const SYSTEM_YOU_ARE = /^\s*System:\s+(you\s+are|ignore|override)/gim;
const CONTROL_TOKEN = /<\|(?:im_start|im_end|eot_id|start_header_id|end_header_id|endoftext)\|>/g;
const DEEPSEEK_CONTROL = /<\uFF5C(?:end\u2581of\u2581sentence|begin\u2581of\u2581sentence)\uFF5C>/g;
const LLAMA_INST = /\[\/?INST\]/gi;
const IGNORE_YOUR_INSTRUCTIONS = /ignore\s+(all\s+)?(your\s+)?(instructions?|rules?)\b/gi;
const UNRESTRICTED_MODE = /\bunrestricted\s+(ai|mode|model)\b/gi;

const INJECTION_PATTERNS = [
  IGNORE_PREVIOUS,
  DISREGARD_INSTRUCTIONS,
  FORGET_INSTRUCTIONS,
  NEW_INSTRUCTIONS,
  DO_NOT_FOLLOW,
  SUPERSEDE_INSTRUCTIONS,
  VOID_INSTRUCTIONS,
  DEVELOPER_MODE,
  ENTER_SPECIAL_MODE,
  ACTIVATE_SPECIAL_MODE,
  SYSTEM_OVERRIDE,
  OVERRIDE_INSTRUCTIONS,
  REVEAL_PROMPT,
  SHOW_PROMPT,
  WHAT_INSTRUCTIONS,
  REPEAT_INSTRUCTIONS,
  OUTPUT_PROMPT,
  REMOVE_RESTRICTIONS,
  ACT_UNBOUND,
  PRETEND_DIFFERENT,
  IDENTITY_HIJACK,
  DAN_JAILBREAK,
  JAILBREAK_MODE,
  DO_ANYTHING_NOW,
  BYPASS_SAFETY,
  DISABLE_SAFETY,
  IGNORE_SAFETY,
  SYSTEM_TAG,
  ROLE_TAG,
  ROLE_DELIMITER,
  BRACKETED_ROLE,
  SYSTEM_YOU_ARE,
  CONTROL_TOKEN,
  DEEPSEEK_CONTROL,
  LLAMA_INST,
  IGNORE_YOUR_INSTRUCTIONS,
  UNRESTRICTED_MODE,
];

const TYPO_TARGETS = [
  'ignore',
  'bypass',
  'override',
  'reveal',
  'delete',
  'system',
  'prompt',
  'instructions',
];

const BASE64_BLOB = /[A-Za-z0-9+/]{16,}={0,2}/g;
const HEX_BLOB = /(?:[0-9a-f]{2}[\s]?){8,}/gi;
const SPACED_LETTERS = /\b(?:[A-Za-z] ){3,}[A-Za-z]\b/g;
const WORD = /\b[A-Za-z]{4,}\b/g;
const PRINTABLE_MIN = 0.85;
const CODE_TAB = 9;
const CODE_LF = 10;
const CODE_CR = 13;
const CODE_SPACE = 32;
const CODE_DEL = 127;
const HEX_RADIX = 16;
const HEX_STEP = 2;

function injectionSpansOn(text: string): RedactSpan[] {
  return spansFromPatterns(text, INJECTION_PATTERNS, 'injection');
}

function sortedLetters(value: string): string {
  return [...value].sort().join('');
}

function firstLast(word: string): { first: string | undefined; last: string | undefined } {
  return { first: word.at(0), last: word.at(-1) };
}

function isTypoglycemia(word: string, target: string): boolean {
  if (word.length !== target.length) {
    return false;
  }
  const lower = word.toLowerCase();
  if (lower === target) {
    return false;
  }
  const wordEnds = firstLast(lower);
  const targetEnds = firstLast(target);
  if (wordEnds.first !== targetEnds.first || wordEnds.last !== targetEnds.last) {
    return false;
  }
  return sortedLetters(lower.slice(1, -1)) === sortedLetters(target.slice(1, -1));
}

function typoNormalize(text: string): string {
  return text.replace(WORD, (word) => {
    for (const target of TYPO_TARGETS) {
      if (isTypoglycemia(word, target)) {
        return target;
      }
    }
    return word;
  });
}

function isMostlyPrintable(value: string): boolean {
  if (!value) {
    return false;
  }
  let ok = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code === CODE_TAB || code === CODE_LF || code === CODE_CR;
    const visible = code >= CODE_SPACE && code < CODE_DEL;
    if (control || visible) {
      ok += 1;
    }
  }
  return ok / value.length >= PRINTABLE_MIN;
}

function decodedHits(decoded: string): boolean {
  if (!isMostlyPrintable(decoded)) {
    return false;
  }
  return injectionSpansOn(decoded).length > 0;
}

function tryBase64(blob: string): string | undefined {
  try {
    return atob(blob);
  } catch {
    return undefined;
  }
}

function tryHex(blob: string): string | undefined {
  const hex = blob.replaceAll(/\s/g, '');
  if (hex.length % HEX_STEP !== 0) {
    return undefined;
  }
  let out = '';
  for (let i = 0; i < hex.length; i += HEX_STEP) {
    out += String.fromCodePoint(Number.parseInt(hex.slice(i, i + HEX_STEP), HEX_RADIX));
  }
  return out;
}

function encodedFrom(
  text: string,
  pattern: RegExp,
  decode: (blob: string) => string | undefined,
): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    const found = blobAt(match);
    if (found) {
      const decoded = decode(found.blob);
      if (decoded && decodedHits(decoded)) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'injection' });
      }
    }
  }
  return spans;
}

function encodedSpans(text: string): RedactSpan[] {
  return [...encodedFrom(text, BASE64_BLOB, tryBase64), ...encodedFrom(text, HEX_BLOB, tryHex)];
}

function spacedSpans(text: string): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(SPACED_LETTERS)) {
    const found = blobAt(match);
    if (found) {
      const collapsed = found.blob.replaceAll(' ', '');
      if (injectionSpansOn(`${collapsed} previous instructions`).length > 0) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'injection' });
      }
    }
  }
  return spans;
}

/** Detect prompt-injection spans in a string. */
function injectionSpans(text: string): RedactSpan[] {
  const shadow = typoNormalize(text);
  let typo: RedactSpan[] = [];
  if (shadow !== text) {
    typo = injectionSpansOn(shadow);
  }
  return [...injectionSpansOn(text), ...typo, ...encodedSpans(text), ...spacedSpans(text)];
}

export { injectionSpans };
