import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

export interface ImageInfo {
  imageKey: string;
  // Will be filled later with base64 data after download
}

export interface FileInfo {
  fileKey: string;
  fileName: string;
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
  rootId?: string;       // Thread root message ID (for thread/topic replies)
  images?: ImageInfo[];  // Images attached to the message
  files?: FileInfo[];    // Files attached to the message
  isMentioned: boolean;  // Whether the bot was @mentioned
  hasMentions: boolean;  // Whether the message contains any @mentions (including non-bot users)
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

// Module-level dedup — survives SDK WebSocket reconnections that may create new handler contexts
const recentMessageIds = new Set<string>();
const DEDUP_TTL_MS = 600_000; // 10 minutes

export type CardActionHandler = (action: { sessionKey: string; chatId: string; actionId: string; label: string; operatorId: string }) => void | Promise<void>;

export function createEventHandler(
  botOpenId: string,
  logger: Logger,
  botStartTime: number = Date.now(),
): { dispatcher: lark.EventDispatcher; onMessage: (handler: MessageHandler) => void; onCardAction: (handler: CardActionHandler) => void } {
  let messageHandler: MessageHandler | null = null;
  let cardActionHandler: CardActionHandler | null = null;

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

        // Handle text, post, image, file, and merge_forward messages
        const supportedTypes = ['text', 'post', 'image', 'file', 'merge_forward'];
        if (!supportedTypes.includes(message.message_type)) {
          logger.info({ messageType: message.message_type, content: message.content?.slice(0, 300) }, 'Ignoring unsupported message type');
          return;
        }

        const chatType = message.chat_type as 'p2p' | 'group';
        const userId = sender.sender_id?.open_id || '';

        // Compute whether bot was @mentioned (used downstream for routing)
        let isMentioned = chatType === 'p2p'; // DMs are always "mentioned"
        if (chatType === 'group') {
          const mentions = message.mentions || [];
          if (botOpenId) {
            isMentioned = mentions.some((m: any) => m.id?.open_id === botOpenId);
          } else {
            // botOpenId unknown — default to false (safe: won't reply to non-@bot messages)
            // Only DMs are auto-replied to when botOpenId is missing
            isMentioned = false;
          }
        }

        // Parse message text, images, and files
        let text = '';
        const images: ImageInfo[] = [];
        const files: FileInfo[] = [];

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
        } else if (message.message_type === 'file') {
          const content = JSON.parse(message.content);
          if (content.file_key) {
            files.push({ fileKey: content.file_key, fileName: content.file_name || 'unknown' });
          }
          text = `[文件] ${content.file_name || 'unknown'}`;
        } else if (message.message_type === 'merge_forward') {
          text = '[合并转发消息]';
        }

        // Strip @mention tags from text
        text = text.replace(/@_user_\w+/g, '').trim();

        if (!text && images.length === 0 && files.length === 0) {
          if (isMentioned) {
            // Pure @mention with no text — user wants attention, inject placeholder
            text = '[用户@了你，请查看上下文并回复]';
          } else {
            logger.info({ messageType: message.message_type, content: message.content?.slice(0, 300) }, 'Empty message after parsing, ignoring');
            return;
          }
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
          rootId: message.root_id || undefined,
          images: images.length > 0 ? images : undefined,
          files: files.length > 0 ? files : undefined,
          isMentioned,
          hasMentions: (message.mentions || []).length > 0,
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
    'card.action.trigger': async (data: any) => {
      try {
        const event = data;
        const value = event?.action?.value;
        if (!value?.sessionKey || !value?.chatId) {
          logger.debug({ event }, 'Card action missing sessionKey/chatId, ignoring');
          return;
        }

        const operatorId = event?.operator?.open_id || '';
        logger.info(
          { sessionKey: value.sessionKey, actionId: value.action, label: value.label, operatorId },
          'Card button clicked',
        );

        if (cardActionHandler) {
          Promise.resolve(cardActionHandler({
            sessionKey: value.sessionKey,
            chatId: value.chatId,
            actionId: value.action,
            label: value.label,
            operatorId,
          })).catch((err: any) => {
            logger.error({ err }, 'Error in card action handler');
          });
        }
      } catch (err) {
        logger.error({ err }, 'Error handling card action event');
      }
    },
  } as any);

  return {
    dispatcher,
    onMessage: (handler: MessageHandler) => {
      messageHandler = handler;
    },
    onCardAction: (handler: CardActionHandler) => {
      cardActionHandler = handler;
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

    // Post title (if any)
    const title = content.zh_cn?.title || content.en_us?.title || content.title;
    if (title) textParts.push(title + '\n');

    const body = content.zh_cn?.content || content.en_us?.content || content.content;
    if (!Array.isArray(body)) return { text: textParts.join(''), images };

    for (const paragraph of body) {
      // code_block is a single object, not an array of elements
      if (!Array.isArray(paragraph)) {
        if (paragraph?.tag === 'code_block') {
          const lang = paragraph.language || '';
          const code = paragraph.text || '';
          textParts.push(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
        }
        continue;
      }
      const lineParts: string[] = [];
      for (const element of paragraph) {
        if (element.tag === 'text') {
          lineParts.push(element.text || '');
        } else if (element.tag === 'a') {
          lineParts.push(element.text || element.href || '');
        } else if (element.tag === 'img' && element.image_key) {
          images.push({ imageKey: element.image_key });
        } else if (element.tag === 'code') {
          // Inline code
          lineParts.push('`' + (element.text || '') + '`');
        } else if (element.tag === 'at') {
          // Skip @mentions
        }
      }
      if (lineParts.length > 0) textParts.push(lineParts.join(''));
    }

    return { text: textParts.join('\n'), images };
  } catch {
    return { text: '', images: [] };
  }
}
