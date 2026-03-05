import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

/**
 * Typing indicator using Feishu message reactions.
 * Adds a "TYPING" emoji reaction when processing starts,
 * removes it when done. Only 2 API calls total.
 */
export class TypingIndicator {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /**
   * Add a typing indicator (emoji reaction) to a message.
   * Returns the reaction ID for later removal, or null on failure.
   * @param emoji - 'MeMeMe' (举手, for @mentions) or 'THINKING' (思考, for triage)
   */
  async start(messageId: string, emoji: string = 'MeMeMe'): Promise<string | null> {
    try {
      const resp = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emoji },
        },
      });
      const reactionId = (resp as any).data?.reaction_id;
      return reactionId || null;
    } catch (err) {
      // Non-critical — silently fail
      this.logger.debug({ err, messageId }, 'Failed to add typing indicator');
      return null;
    }
  }

  /**
   * Remove the typing indicator.
   */
  async stop(messageId: string, reactionId: string | null): Promise<void> {
    if (!reactionId) return;

    try {
      await this.client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
    } catch (err) {
      // Non-critical — silently fail
      this.logger.debug({ err, messageId }, 'Failed to remove typing indicator');
    }
  }
}
