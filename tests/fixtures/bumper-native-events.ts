import { EventEmitter } from 'node:events';
export function bumperNativeEvents() {
  const events = new EventEmitter();
  return {
    on: events.on.bind(events),
    off: events.off.bind(events),
    like(actorId: string, feedbackId: string, reactionId = '1635855486666999', rejected = false) {
      const request = {
        method: () => 'POST',
        url: () => 'https://www.facebook.com/api/graphql/',
        postData: () =>
          new URLSearchParams({
            fb_api_req_friendly_name: 'CometUFIFeedbackReactMutation',
            variables: JSON.stringify({
              input: {
                actor_id: actorId,
                feedback_id: feedbackId,
                feedback_reaction_id: reactionId,
              },
            }),
          }).toString(),
      };
      events.emit('request', request);
      events.emit('response', {
        request: () => request,
        status: () => 200,
        text: async () =>
          JSON.stringify({
            ...(rejected ? { errors: [{ message: 'native rejection' }] } : {}),
            data: {
              feedback_react: {
                feedback: {
                  id: feedbackId,
                  viewer_actor: { id: actorId },
                  viewer_feedback_reaction_info: { id: reactionId },
                },
              },
            },
          }),
      });
    },
    comment(actorId: string, feedbackId: string, text: string, rejected = false) {
      const request = {
        method: () => 'POST',
        url: () => 'https://www.facebook.com/api/graphql/',
        postData: () =>
          new URLSearchParams({
            fb_api_req_friendly_name: 'useCometUFICreateCommentMutation',
            variables: JSON.stringify({ input: { feedback_id: feedbackId, message: { text } } }),
          }).toString(),
      };
      events.emit('request', request);
      events.emit('response', {
        request: () => request,
        status: () => 200,
        text: async () =>
          JSON.stringify({
            ...(rejected ? { errors: [{ message: 'native rejection' }] } : {}),
            data: {
              comment_create: {
                feedback: { id: feedbackId },
                feedback_comment_edge: {
                  node: { id: 'server-comment-id', author: { id: actorId }, body: { text } },
                },
              },
            },
          }),
      });
    },
  };
}
