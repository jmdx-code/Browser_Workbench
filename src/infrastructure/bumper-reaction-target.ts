import type { BumperReactionType } from '../shared/group-bumper.js';
import { serializeDomEval, type createDomEvalRuntime } from './shared-dom-eval-runtime.js';
// Native IDs sampled from Facebook's reaction strategies and mutation responses.
// These identify reactions, not translated labels or positions in a menu.
export const BUMPER_REACTION_IDS: Record<BumperReactionType, string> = {
  like: '1635855486666999',
  love: '1678524932434102',
  care: '613557422527858',
  haha: '115940658764963',
  wow: '478547315650144',
  sad: '908563459236466',
  angry: '444813342392137',
};
function projectBumperReactionTargetEntry(
  createRt: typeof createDomEvalRuntime,
  scope: { feedbackId: string; reactionId: string; postId: string },
): string | null {
  const { obj, visible, enabled, chain, clearDataAttrs } = createRt();
  const marker = 'data-wb-bumper-reaction-target';
  clearDataAttrs([marker]);
  if (!scope.feedbackId || !/^[1-9]\d*$/.test(scope.reactionId) || !/^\d+$/.test(scope.postId))
    return null;
  const matches: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="button"],button'))) {
    if (!visible(el, { opacity: true }) || !enabled(el)) continue;
    let reaction = false;
    let feedback = false;
    let dock = false;
    let excluded = false;
    for (const f of chain(el, 100, { fastScan: false })) {
      if (/CometUFIComment|CometUFITopReactions|CometUFIClassicTopReactions/.test(f.name)) {
        excluded = true;
        break;
      }
      if (String(f.props.reactionID ?? '') === scope.reactionId) reaction = true;
      const nativeFeedback = obj(f.props.feedback);
      const fid =
        nativeFeedback.__id ?? nativeFeedback.id ?? f.props.feedbackID ?? f.props.feedbackId;
      if (typeof fid === 'string') {
        if (fid !== scope.feedbackId) {
          excluded = true;
          break;
        }
        feedback = true;
      }
      if (/CometUFIReactionsMenuDock/.test(f.name)) {
        dock = true;
        break;
      }
    }
    if (!excluded && reaction && feedback && dock) matches.push(el);
  }
  const candidates = matches.filter(
    (el) => !matches.some((other) => other !== el && el.contains(other)),
  );
  const chosen = candidates[0];
  if (!chosen || candidates.length !== 1) return null;
  chosen.setAttribute(marker, scope.postId);
  return '[' + marker + '="' + scope.postId + '"]';
}
// Self-contained browser projection. Mark only the desired reaction in this
// post's native reaction dock; summary counts and comment reactions cannot match.
export const projectBumperReactionTarget = serializeDomEval<
  (scope: { feedbackId: string; reactionId: string; postId: string }) => string | null
>('projectBumperReactionTarget', projectBumperReactionTargetEntry);
