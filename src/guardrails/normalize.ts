/**
 * Unicode normalization for injection detection preprocessing.
 *
 * Strips invisible characters, normalizes homoglyphs, fullwidth, math
 * variants, and Unicode spaces so regex-based injection patterns can
 * match evasion attempts that use visually similar substitutions.
 *
 * @module
 */

const STRIP_CODES: number[] = [
  0x200B, 0x200C, 0x200D, 0xFEFF, 0x00AD,
  0x200E, 0x200F,
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
  0x034F, 0x061C, 0x180E,
  0x2066, 0x2067, 0x2068, 0x2069,
];

const STRIP_SET = new Set(STRIP_CODES);

const SPACE_CODES: number[] = [
  0x00A0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
  0x202F, 0x205F, 0x3000,
];

const SPACE_SET = new Set(SPACE_CODES);

const HOMOGLYPH_MAP = new Map<number, string>([
  [0x0430, 'a'], [0x0441, 'c'], [0x0435, 'e'], [0x0456, 'i'],
  [0x043E, 'o'], [0x0440, 'p'], [0x0455, 's'], [0x0443, 'y'],
  [0x0445, 'x'], [0x043A, 'k'], [0x043D, 'h'],
  [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041D, 'H'],
  [0x041E, 'O'], [0x041A, 'K'], [0x041C, 'M'], [0x0420, 'P'],
  [0x0421, 'C'], [0x0422, 'T'], [0x0425, 'X'],
  [0x03B1, 'a'], [0x03B5, 'e'], [0x03B9, 'i'], [0x03BF, 'o'],
  [0x03C1, 'p'],
  [0x2071, 'i'], [0x207F, 'n'],
  [0x1D43, 'a'], [0x1D47, 'b'], [0x1D48, 'd'], [0x1D49, 'e'],
  [0x1D4D, 'g'], [0x1D4F, 'k'], [0x1D50, 'm'], [0x1D52, 'o'],
  [0x1D56, 'p'], [0x1D57, 't'], [0x1D58, 'u'], [0x1D5B, 'v'],
]);

const FULLWIDTH_LO = 0xFF01;
const FULLWIDTH_HI = 0xFF5E;
const FULLWIDTH_OFFSET = 0xFEE0;

const COMBINING_LO = 0x0300;
const COMBINING_HI = 0x036F;

const MATH_ALPHA: [number, number][] = [
  [0x1D400, 0x1D41A], [0x1D434, 0x1D44E], [0x1D468, 0x1D482],
  [0x1D49C, 0x1D4B6], [0x1D4D0, 0x1D4EA], [0x1D504, 0x1D51E],
  [0x1D538, 0x1D552], [0x1D56C, 0x1D586], [0x1D5A0, 0x1D5BA],
  [0x1D5D4, 0x1D5EE], [0x1D608, 0x1D622], [0x1D63C, 0x1D656],
  [0x1D670, 0x1D68A],
];

const MATH_DIGIT: number[] = [
  0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6,
];

const ALPHA_SIZE = 26;
const DIGIT_SIZE = 10;
const UPPER_A = 0x41;
const LOWER_A = 0x61;
const DIGIT_0 = 0x30;

function mapMath(code: number): string | undefined {
  for (const [upper, lower] of MATH_ALPHA) {
    if (code >= upper && code < upper + ALPHA_SIZE) {
      return String.fromCodePoint(UPPER_A + code - upper);
    }
    if (code >= lower && code < lower + ALPHA_SIZE) {
      return String.fromCodePoint(LOWER_A + code - lower);
    }
  }
  for (const start of MATH_DIGIT) {
    if (code >= start && code < start + DIGIT_SIZE) {
      return String.fromCodePoint(DIGIT_0 + code - start);
    }
  }
  return undefined;
}

const EMOJI_BETWEEN =
  /(?<=[a-zA-Z])[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{231A}-\u{23FF}]+(?=[a-zA-Z])/gu;

const BACKSLASH_BEFORE_ALPHA = /\\(?=[a-zA-Z])/g;

function normalizeForDetection(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (STRIP_SET.has(code)) continue;
    if (code >= COMBINING_LO && code <= COMBINING_HI) continue;
    if (code >= FULLWIDTH_LO && code <= FULLWIDTH_HI) {
      out += String.fromCodePoint(code - FULLWIDTH_OFFSET);
      continue;
    }
    const math = mapMath(code);
    if (math !== undefined) { out += math; continue; }
    const homo = HOMOGLYPH_MAP.get(code);
    if (homo !== undefined) { out += homo; continue; }
    if (SPACE_SET.has(code)) { out += ' '; continue; }
    out += ch;
  }
  return out
    .replace(EMOJI_BETWEEN, '')
    .replace(BACKSLASH_BEFORE_ALPHA, '');
}

export { normalizeForDetection };
