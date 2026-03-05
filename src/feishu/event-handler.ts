import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

export interface ImageInfo {
  imageKey: string;
  // Will be filled later with base64 data after download
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  userId: string;
  senderName?: string;  // Sender name from event (if available)
  text: string;
  messageType: string;
  parentId?: string;
  images?: ImageInfo[];  // Images attached to the message
  isMentioned: boolean;  // Whether the bot was @mentioned
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

// Module-level dedup — survives SDK WebSocket reconnections that may create new handler contexts
const recentMessageIds = new Set<string>();
const DEDUP_TTL_MS = 600_000; // 10 minutes

export function createEventHandler(
  botOpenId: string,
  logger: Logger,
  botStartTime: number = Date.now(),
): { dispatcher: lark.EventDispatcher; onMessage: (handler: MessageHandler) => void } {
  let messageHandler: MessageHandler | null = null;

  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        // Log raw event
        logger.info(
          { messageId: message.message_id, createTime: message.create_time },
          'Raw event received',
        );

        // Layer 2: Ignore messages created before bot startup (prevents stale redelivery)
        const createTimeMs = parseInt(message.create_time, 10);
        if (createTimeMs && createTimeMs < botStartTime) {
          logger.warn(
            { messageId: message.message_id, createTimeMs, botStartTime },
            'Ignoring message created before bot startup',
          );
          return;
        }

        // Deduplicate by message_id (with debug logging to diagnose Set failures)
        const msgId = String(message.message_id);
        const alreadySeen = recentMessageIds.has(msgId);
        logger.info({ messageId: msgId, alreadySeen, setSize: recentMessageIds.size }, 'Dedup check');
        if (alreadySeen) {
          logger.warn({ messageId: msgId }, 'Duplicate message event, ignoring');
          return;
        }
        recentMessageIds.add(msgId);
        setTimeout(() => recentMessageIds.delete(msgId), DEDUP_TTL_MS);

        // Handle text, post, and image messages
        const supportedTypes = ['text', 'post', 'image'];
        if (!supportedTypes.includes(message.message_type)) {
          logger.debug({ messageType: message.message_type }, 'Ignoring unsupported message type');
          return;
        }

        const chatType = message.chat_type as 'p2p' | 'group';
        const userId = sender.sender_id?.open_id || '';

        // Compute whether bot was @mentioned (used downstream for routing)
        let isMentioned = chatType === 'p2p'; // DMs are always "mentioned"
        if (chatType === 'group') {
          const mentions = message.mentions || [];
          isMentioned = botOpenId
            ? mentions.some((m: any) => m.id?.open_id === botOpenId)
            : mentions.length > 0;
        }

        // Parse message text and images
        let text = '';
        const images: ImageInfo[] = [];

        if (message.message_type === 'text') {
          const content = JSON.parse(message.content);
          text = content.text || '';
        } else if (message.message_type === 'post') {
          const parsed = parsePost(message.content);
          text = parsed.text;
          images.push(...parsed.images);
        } else if (message.message_type === 'image') {
          const content = JSON.parse(message.content);
          if (content.image_key) {
            images.push({ imageKey: content.image_key });
          }
          text = '[用户发送了一张图片]';
        }

        // Strip @mention tags from text
        text = text.replace(/@_user_\w+/g, '').trim();

        if (!text && images.length === 0) {
          logger.debug('Empty message after stripping mentions, ignoring');
          return;
        }

        // Extract sender name from event (no extra API call needed)
        const senderName = sender.sender_id?.name || undefined;

        const incoming: IncomingMessage = {
          messageId: message.message_id,
          chatId: message.chat_id,
          chatType,
          userId,
          senderName,
          text: text || '[用户发送了图片]',
          messageType: message.message_type,
          parentId: message.parent_id || undefined,
          images: images.length > 0 ? images : undefined,
          isMentioned,
        };

        logger.info(
          { chatId: incoming.chatId, chatType, userId, senderName, textLength: text.length, imageCount: images.length },
          'Received message',
        );

        // Layer 3: Fire-and-forget — don't await handler so SDK acks to Feishu server immediately.
        // This prevents Feishu from redelivering the event after ~20s timeout.
        if (messageHandler) {
          Promise.resolve(messageHandler(incoming)).catch((err: any) => {
            logger.error({ err }, 'Error in message handler');
          });
        }
      } catch (err) {
        logger.error({ err }, 'Error handling Feishu message event');
      }
    },
  });

  return {
    dispatcher,
    onMessage: (handler: MessageHandler) => {
      messageHandler = handler;
    },
  };
}

/**
 * Parse post (rich text) content, extracting both text and image keys.
 */
function parsePost(contentStr: string): { text: string; images: ImageInfo[] } {
  try {
    const content = JSON.parse(contentStr);
    const textParts: string[] = [];
    const images: ImageInfo[] = [];

    const body = content.zh_cn?.content || content.en_us?.content || content.content;
    if (!Array.isArray(body)) return { text: '', images: [] };

    for (const paragraph of body) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        if (element.tag === 'text') {
          textParts.push(element.text || '');
        } else if (element.tag === 'a') {
          textParts.push(element.text || element.href || '');
        } else if (element.tag === 'img' && element.image_key) {
          images.push({ imageKey: element.image_key });
        } else if (element.tag === 'at') {
          // Skip @mentions
        }
      }
    }

    return { text: textParts.join(''), images };
  } catch {
    return { text: '', images: [] };
  }
}
