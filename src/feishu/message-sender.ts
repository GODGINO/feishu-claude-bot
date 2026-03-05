import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

const NAME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class MessageSender {
  private nameCache = new Map<string, { name: string; expireAt: number }>();

  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /**
   * Resolve a user's open_id to their display name, with caching.
   */
  async resolveUserName(openId: string): Promise<string | null> {
    // Check cache
    const cached = this.nameCache.get(openId);
    if (cached && cached.expireAt > Date.now()) {
      return cached.name;
    }

    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const user = (resp as any)?.data?.user;
      const name = user?.name || user?.display_name || user?.nickname || user?.en_name || null;
      if (name) {
        this.nameCache.set(openId, { name, expireAt: Date.now() + NAME_CACHE_TTL_MS });
        this.logger.debug({ openId, name }, 'Resolved user name');
      }
      return name;
    } catch (err) {
      this.logger.warn({ err, openId }, 'Failed to resolve user name');
      return null;
    }
  }

  /**
   * Fetch the text content of a message by its ID (for quoted message support)
   */
  async fetchMessageText(messageId: string): Promise<string | null> {
    try {
      const resp = await this.client.im.message.get({
        path: { message_id: messageId },
      });
      const msg = (resp as any).data?.items?.[0];
      if (!msg) return null;

      const msgType = msg.msg_type;
      const content = JSON.parse(msg.body?.content || '{}');

      if (msgType === 'text') {
        return content.text || null;
      }
      if (msgType === 'post') {
        // Extract text from post content
        const body = content.zh_cn?.content || content.en_us?.content || content.content;
        if (!Array.isArray(body)) return null;
        const parts: string[] = [];
        for (const para of body) {
          if (!Array.isArray(para)) continue;
          for (const el of para) {
            if (el.tag === 'text') parts.push(el.text || '');
            else if (el.tag === 'a') parts.push(el.text || el.href || '');
          }
        }
        return parts.join('') || null;
      }
      if (msgType === 'interactive') {
        // Card message - try to extract markdown content
        const elements = content.body?.elements || content.elements || [];
        const parts: string[] = [];
        for (const el of elements) {
          if (el.tag === 'markdown') parts.push(el.content || '');
          else if (el.tag === 'div' && el.text) parts.push(el.text.content || '');
        }
        return parts.join('\n') || null;
      }

      return `[${msgType} message]`;
    } catch (err) {
      this.logger.warn({ err, messageId }, 'Failed to fetch quoted message');
      return null;
    }
  }

  /**
   * Download an image from a Feishu message as base64.
   * Uses the messageResource API which works for message attachments.
   */
  async downloadImage(messageId: string, imageKey: string): Promise<{ base64: string; mediaType: string } | null> {
    try {
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      // The SDK returns various formats - handle Buffer, ArrayBuffer, ReadableStream
      const data = (resp as any);
      let buffer: Buffer;

      if (Buffer.isBuffer(data)) {
        buffer = data;
      } else if (data instanceof ArrayBuffer) {
        buffer = Buffer.from(data);
      } else if (data?.data && Buffer.isBuffer(data.data)) {
        buffer = data.data;
      } else if (data?.data instanceof ArrayBuffer) {
        buffer = Buffer.from(data.data);
      } else if (typeof data?.getReadableStream === 'function') {
        const stream = await data.getReadableStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        buffer = Buffer.concat(chunks);
      } else if (typeof data?.arrayBuffer === 'function') {
        // Response/Blob-like
        buffer = Buffer.from(await data.arrayBuffer());
      } else {
        this.logger.warn({ messageId, imageKey, type: typeof data }, 'Unknown image response format');
        return null;
      }

      // Detect media type from magic bytes
      const mediaType = detectImageType(buffer);
      const base64 = buffer.toString('base64');

      this.logger.info({ messageId, imageKey, mediaType, sizeKB: Math.round(buffer.length / 1024) }, 'Downloaded image');
      return { base64, mediaType };
    } catch (err) {
      this.logger.error({ err, messageId, imageKey }, 'Failed to download image');
      return null;
    }
  }

  /**
   * Send a text reply to a message (using post format with markdown)
   */
  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<string | null> {
    try {
      const content = JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'md', text }]],
        },
      });

      if (replyToMessageId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'post' },
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'post',
        },
      });
      return (resp as any).data?.message_id || null;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send text message');
      return null;
    }
  }

  /**
   * Send an interactive card message
   */
  async sendCard(chatId: string, cardJson: object, replyToMessageId?: string): Promise<string | null> {
    try {
      const content = JSON.stringify(cardJson);

      if (replyToMessageId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'interactive' },
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'interactive',
        },
      });
      return (resp as any).data?.message_id || null;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send card message');
      return null;
    }
  }

  /**
   * Detect render mode and send reply accordingly.
   * If sessionDir is provided, @名字 mentions are resolved to Feishu <at> tags.
   */
  async sendReply(chatId: string, text: string, replyToMessageId?: string, sessionDir?: string): Promise<string | null> {
    // Resolve @mentions before sending
    if (sessionDir) {
      text = resolveAtMentions(text, sessionDir);
    }

    // Strip <<TITLE:...>> tag if present (only used for card headers)
    const cleanText = text.replace(/^<<TITLE:.+?>>\s*\n?/, '');
    const mode = detectRenderMode(text);

    this.logger.info({ mode, textLength: text.length, hasTitle: /<<TITLE:/.test(text) }, 'sendReply render mode');

    if (mode === 'card') {
      const card = buildMarkdownCard(text); // pass original text so title can be extracted
      return this.sendCard(chatId, card, replyToMessageId);
    }

    // For long text, split into chunks
    if (cleanText.length > 4000) {
      const chunks = splitMarkdown(cleanText, 4000);
      let firstMsgId: string | null = null;
      for (let i = 0; i < chunks.length; i++) {
        const msgId = await this.sendText(
          chatId,
          chunks[i],
          i === 0 ? replyToMessageId : undefined,
        );
        if (i === 0) firstMsgId = msgId;
      }
      return firstMsgId;
    }

    return this.sendText(chatId, cleanText, replyToMessageId);
  }

  /**
   * Upload a file to Feishu and send it as a file message.
   * @param filePath Absolute path to the file on disk
   */
  async sendFile(chatId: string, filePath: string, replyToMessageId?: string): Promise<string | null> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logger.warn({ filePath }, 'File not found for sending');
        return null;
      }

      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const fileType = detectFileUploadType(ext);

      // Step 1: Upload file
      const fileStream = fs.createReadStream(filePath);
      const uploadResp = await (this.client as any).im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fileStream,
        },
      });

      const fileKey = (uploadResp as any)?.file_key || (uploadResp as any)?.data?.file_key;
      if (!fileKey) {
        this.logger.error({ uploadResp, filePath }, 'Failed to get file_key from upload');
        return null;
      }

      this.logger.info({ fileName, fileKey, fileType }, 'Uploaded file to Feishu');

      // Step 2: Send file message
      const content = JSON.stringify({ file_key: fileKey });

      if (replyToMessageId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'file' },
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'file',
        },
      });
      return (resp as any).data?.message_id || null;
    } catch (err) {
      this.logger.error({ err, filePath, chatId }, 'Failed to send file');
      return null;
    }
  }

  /**
   * Upload an image file and send it as an image message.
   */
  async sendImage(chatId: string, imagePath: string, replyToMessageId?: string): Promise<string | null> {
    try {
      if (!fs.existsSync(imagePath)) {
        this.logger.warn({ imagePath }, 'Image not found for sending');
        return null;
      }

      // Step 1: Upload image
      const imageStream = fs.createReadStream(imagePath);
      const uploadResp = await (this.client as any).im.image.create({
        data: {
          image_type: 'message',
          image: imageStream,
        },
      });

      const imageKey = (uploadResp as any)?.image_key || (uploadResp as any)?.data?.image_key;
      if (!imageKey) {
        this.logger.error({ uploadResp, imagePath }, 'Failed to get image_key from upload');
        return null;
      }

      this.logger.info({ imagePath, imageKey }, 'Uploaded image to Feishu');

      // Step 2: Send image message
      const content = JSON.stringify({ image_key: imageKey });

      if (replyToMessageId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'image' },
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'image',
        },
      });
      return (resp as any).data?.message_id || null;
    } catch (err) {
      this.logger.error({ err, imagePath, chatId }, 'Failed to send image');
      return null;
    }
  }
}

/**
 * Replace @名字 and @所有人 with Feishu <at> tags using authors.json mapping.
 */
function resolveAtMentions(text: string, sessionDir: string): string {
  // Replace @所有人 first
  text = text.replace(/@所有人/g, '<at id=all></at>');

  // Load authors.json for name→openId mapping
  const authorsFile = path.join(sessionDir, 'authors.json');
  try {
    if (!fs.existsSync(authorsFile)) return text;
    const data = JSON.parse(fs.readFileSync(authorsFile, 'utf-8'));
    const authors = data.authors as Record<string, { name: string }> | undefined;
    if (!authors) return text;

    // Build name→openId map (longer names first to avoid partial matches)
    const nameMap: Array<[string, string]> = [];
    for (const [openId, author] of Object.entries(authors)) {
      if (author.name) {
        nameMap.push([author.name, openId]);
      }
    }
    nameMap.sort((a, b) => b[0].length - a[0].length);

    for (const [name, openId] of nameMap) {
      // Replace @名字 but not already-resolved <at> tags
      const pattern = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'g');
      text = text.replace(pattern, `<at id=${openId}></at>`);
    }
  } catch { /* ignore parse errors */ }

  return text;
}

/**
 * Auto-detect whether to use card or text rendering
 */
function detectRenderMode(text: string): 'card' | 'text' {
  const needsCard =
    /```[\s\S]*?```/.test(text) ||       // Code blocks
    /\|.+\|.+\|/.test(text) ||           // Tables
    /^#{1,3}\s/m.test(text) ||           // Headings
    /!\[.*\]\(.*\)/.test(text) ||        // Image links
    /^[-*]\s/m.test(text) ||             // Unordered lists
    /^\d+\.\s/m.test(text) ||            // Ordered lists
    /\*\*.+?\*\*/.test(text) ||          // Bold text
    /<<TITLE:.+?>>/.test(text) ||        // Has explicit title
    /<at\s+id=/.test(text) ||            // @mentions (only work in card markdown)
    text.length > 300;                    // Moderate length text

  return needsCard ? 'card' : 'text';
}

/**
 * Extract <<TITLE:...>> tag from text. Returns { title, body } where body has the tag removed.
 */
function extractTitle(text: string): { title: string; body: string } {
  const match = text.match(/^<<TITLE:(.+?)>>\s*\n?/);
  if (match) {
    return {
      title: match[1].trim().slice(0, 40),
      body: text.slice(match[0].length).replace(/^\n/, ''),
    };
  }
  return { title: 'Σ Sigma', body: text };
}

/**
 * Build a schema 2.0 interactive card with markdown content
 */
function buildMarkdownCard(text: string): object {
  const { title, body } = extractTitle(text);

  // Truncate if too long for card (Feishu limit ~28000 chars)
  const truncated = body.length > 28000 ? body.slice(0, 28000) + '\n\n...(内容已截断)' : body;

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'green',
    },
    body: {
      elements: [{ tag: 'markdown', content: truncated }],
    },
  };
}

/**
 * Map file extension to Feishu upload file_type
 */
function detectFileUploadType(ext: string): string {
  const map: Record<string, string> = {
    '.pdf': 'pdf',
    '.doc': 'doc', '.docx': 'doc',
    '.xls': 'xls', '.xlsx': 'xls',
    '.ppt': 'ppt', '.pptx': 'ppt',
    '.mp4': 'mp4',
    '.opus': 'opus', '.ogg': 'opus',
  };
  return map[ext] || 'stream';
}

/**
 * Detect image MIME type from magic bytes
 */
function detectImageType(buffer: Buffer): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';  // RIFF
  return 'image/png'; // default fallback
}

/**
 * Split text at markdown-safe boundaries
 */
function splitMarkdown(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit / 2) {
      // Fallback to line boundary
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit / 2) {
      // Last resort: hard split
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
