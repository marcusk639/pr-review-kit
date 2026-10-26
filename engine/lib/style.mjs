// Posted-text style rules (config.style), applied by publish to the summary
// and inline comments: noEmoji (votes become +1/-1), noEmDash.
import { activeProject } from './config.mjs';

export function applyStyle(text) {
  const style = activeProject().config.style ?? {};
  let t = String(text ?? '');
  if (style.noEmDash) t = t.replace(/\s*—\s*/g, ' - ');
  if (style.noEmoji) {
    t = t.replace(/👍/g, '+1').replace(/👎/g, '-1').replace(/⚠️?/g, '!');
    t = t.replace(/\p{Extended_Pictographic}️?/gu, '').replace(/ {2,}/g, ' ').replace(/ +$/gm, '');
  }
  return t;
}
