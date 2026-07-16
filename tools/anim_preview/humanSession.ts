export const HUMAN_SESSION_READ_ONLY_MESSAGE = '只读模式：人工操作必须通过 ./dev.sh anim-preview 启动的浏览器页面进行';

const HUMAN_FRAGMENT_KEY = 'human';
const HUMAN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function consumeHumanTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  if (!rawHash) return '';

  const fragment = new URLSearchParams(rawHash);
  const candidate = fragment.get(HUMAN_FRAGMENT_KEY) || '';
  if (!fragment.has(HUMAN_FRAGMENT_KEY)) return '';

  // The capability exists only in module memory. Remove it before any later
  // navigation, copy/paste, screenshot, or browser-history inspection can
  // accidentally retain the secret-bearing URL.
  fragment.delete(HUMAN_FRAGMENT_KEY);
  const remainingHash = fragment.toString();
  const sanitizedUrl = `${window.location.pathname}${window.location.search}${remainingHash ? `#${remainingHash}` : ''}`;
  window.history.replaceState(window.history.state, document.title, sanitizedUrl);

  return HUMAN_TOKEN_PATTERN.test(candidate) ? candidate : '';
}

const humanSessionToken = consumeHumanTokenFromFragment();

export function getHumanSessionToken(): string {
  return humanSessionToken;
}

export function hasHumanSession(): boolean {
  return Boolean(humanSessionToken);
}
