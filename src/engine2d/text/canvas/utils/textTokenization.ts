/**
 * 分词与空白规则。移植自 PixiJS v8.17(MIT)`scene/text/canvas/utils/textTokenization.mjs`。
 */

export const NEWLINES = [
  10, // line feed
  13, // carriage return
];
export const NEWLINES_SET = new Set(NEWLINES);

export const BREAKING_SPACES = [
  9, // character tabulation
  32, // space
  8192, // en quad
  8193, // em quad
  8194, // en space
  8195, // em space
  8196, // three-per-em space
  8197, // four-per-em space
  8198, // six-per-em space
  8200, // punctuation space
  8201, // thin space
  8202, // hair space
  8287, // medium mathematical space
  12288, // ideographic space
];
export const BREAKING_SPACES_SET = new Set(BREAKING_SPACES);

export const COLLAPSIBLE_SPACES = [
  9, // character tabulation (tab)
  32, // space
];
export const COLLAPSIBLE_SPACES_SET = new Set(COLLAPSIBLE_SPACES);

export const BREAK_AFTER_CHARS = [
  45, // hyphen-minus
  8208, // unicode hyphen
  8211, // en-dash
  8212, // em-dash
  173, // soft hyphen
];
export const BREAK_AFTER_CHARS_SET = new Set(BREAK_AFTER_CHARS);

export const NEWLINE_SPLIT_REGEX = /(\r\n|\r|\n)/;
export const NEWLINE_MATCH_REGEX = /(?:\r\n|\r|\n)/;

export function isNewline(char: string | undefined): boolean {
  if (typeof char !== 'string') return false;
  return NEWLINES_SET.has(char.charCodeAt(0));
}

export function isBreakingSpace(char: string | undefined, _nextChar?: string): boolean {
  if (typeof char !== 'string') return false;
  return BREAKING_SPACES_SET.has(char.charCodeAt(0));
}

export function isCollapsibleSpace(char: string | undefined): boolean {
  if (typeof char !== 'string') return false;
  return COLLAPSIBLE_SPACES_SET.has(char.charCodeAt(0));
}

export function isBreakAfterChar(char: string | undefined): boolean {
  if (typeof char !== 'string') return false;
  return BREAK_AFTER_CHARS_SET.has(char.charCodeAt(0));
}

export function collapseSpaces(whiteSpace: string): boolean {
  return whiteSpace === 'normal' || whiteSpace === 'pre-line';
}

export function collapseNewlines(whiteSpace: string): boolean {
  return whiteSpace === 'normal';
}

export function trimRight(text: string): string {
  if (typeof text !== 'string') return '';
  let i = text.length - 1;
  while (i >= 0 && isBreakingSpace(text[i])) i--;
  return i < text.length - 1 ? text.slice(0, i + 1) : text;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const tokenChars: string[] = [];
  if (typeof text !== 'string') return tokens;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (isBreakingSpace(char, nextChar) || isNewline(char)) {
      if (tokenChars.length > 0) {
        tokens.push(tokenChars.join(''));
        tokenChars.length = 0;
      }
      if (char === '\r' && nextChar === '\n') {
        tokens.push('\r\n');
        i++;
      } else {
        tokens.push(char);
      }
      continue;
    }
    tokenChars.push(char);
    if (isBreakAfterChar(char) && nextChar && !isBreakingSpace(nextChar) && !isNewline(nextChar)) {
      tokens.push(tokenChars.join(''));
      tokenChars.length = 0;
    }
  }
  if (tokenChars.length > 0) tokens.push(tokenChars.join(''));
  return tokens;
}

export function getCharacterGroups(
  token: string,
  breakWords: boolean,
  splitFn: (s: string) => string[],
  canBreakCharsFn: (char: string, nextChar: string, token: string, index: number, breakWords: boolean) => boolean,
): string[] {
  const characters = splitFn(token);
  const groups: string[] = [];
  for (let j = 0; j < characters.length; j++) {
    let char = characters[j];
    let lastChar = char;
    let k = 1;
    while (characters[j + k]) {
      const nextChar = characters[j + k];
      if (!canBreakCharsFn(lastChar, nextChar, token, j, breakWords)) {
        char += nextChar;
        lastChar = nextChar;
        k++;
      } else {
        break;
      }
    }
    j += k - 1;
    groups.push(char);
  }
  return groups;
}
