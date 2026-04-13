import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

const NAME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class MessageSender {
  private nameCache = new Map<string, { name: string; expireAt: number }>();

  constructor(
    private _client: lark.Client,
    private logger: Logger,
  ) {}

  /**
   * Get the underlying Lark client (for CardStreamer and other direct API access).
   */
  get larkClient(): lark.Client {
    return this._client;
  }

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
      const resp = await this._client.contact.user.get({
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
   * Fetch the full body of a forwarded email card via Mail API.
   * Parses cardId/ownerId from the card_link URL, then calls get_by_card → get.
   *
   * Requires env FEISHU_MAIL_USER_MAILBOX — any valid Feishu tenant email address.
   * Tenant access token cannot use 'me', and any tenant member's mailbox can fetch any forward card.
   */
  async fetchForwardedEmailBody(cardLinkUrl: string): Promise<string | null> {
    try {
      const userMailbox = process.env.FEISHU_MAIL_USER_MAILBOX;
      if (!userMailbox) {
        this.logger.warn('FEISHU_MAIL_USER_MAILBOX not set, cannot fetch email body');
        return null;
      }

      // Parse cardId and ownerId from URL like:
      // lark://applink.feishu.cn/client/mail/forward/card?cardId=xxx&ownerId=yyy&threadId=zzz
      const queryStr = cardLinkUrl.split('?')[1] || '';
      const params = new URLSearchParams(queryStr);
      const cardId = params.get('cardId');
      const ownerId = params.get('ownerId');
      if (!cardId || !ownerId) {
        this.logger.warn({ cardLinkUrl }, 'Cannot parse cardId/ownerId from card link');
        return null;
      }

      // Step 1: get_by_card → message_id
      const cardResp = await (this._client.mail as any).v1.userMailboxMessage.getByCard({
        path: { user_mailbox_id: userMailbox },
        params: { card_id: cardId, owner_id: ownerId },
      });
      const messageIds: string[] = cardResp?.data?.message_ids || [];
      if (messageIds.length === 0) {
        this.logger.warn({ cardId, ownerId }, 'No message_ids returned from get_by_card');
        return null;
      }

      // Step 2: fetch full email body
      const msgResp = await (this._client.mail as any).v1.userMailboxMessage.get({
        path: { user_mailbox_id: userMailbox, message_id: messageIds[0] },
        params: { format: 'full' } as any,
      });
      // Note: Feishu API wraps it as data.message, not data directly
      const mail = msgResp?.data?.message;
      if (!mail) {
        this.logger.warn({ resp: JSON.stringify(msgResp?.data) }, 'No message in mail get response');
        return null;
      }

      // Decode base64url body (prefer plain text)
      const decode = (b64url: string): string => {
        try {
          const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
          const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
          return Buffer.from(padded, 'base64').toString('utf-8');
        } catch { return ''; }
      };

      const subject = mail.subject || '';
      const from = mail.head_from?.mail_address || mail.head_from?.name || '';
      const bodyPlain = mail.body_plain_text ? decode(mail.body_plain_text) : '';
      const bodyHtml = mail.body_html ? decode(mail.body_html) : '';

      // Strip HTML tags as fallback if no plain text
      let body = bodyPlain;
      if (!body && bodyHtml) {
        body = bodyHtml.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      }

      const parts: string[] = [];
      if (subject) parts.push(`主题: ${subject}`);
      if (from) parts.push(`发件人: ${from}`);
      if (body) parts.push(`\n${body}`);

      this.logger.info({ subject, bodyLen: body.length }, 'Fetched forwarded email body');
      return parts.join('\n') || null;
    } catch (err) {
      this.logger.warn({ err: (err as any)?.message || err, cardLinkUrl }, 'Failed to fetch forwarded email body');
      return null;
    }
  }

  /**
   * Fetch the text content of a message by its ID (for quoted message support)
   */
  async fetchMessageText(messageId: string): Promise<string | null> {
    try {
      const resp = await this._client.im.message.get({
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
        // Card message - extract text content from various possible structures
        const parts: string[] = [];

        // Title (forwarded email cards have this)
        if (content.title) parts.push(content.title);

        // Detect forwarded email card by card_link.url
        const cardLinkUrl: string = content.card_link?.url || '';
        const isMailForward = cardLinkUrl.includes('mail/forward/card');
        if (isMailForward) {
          const fullBody = await this.fetchForwardedEmailBody(cardLinkUrl);
          if (fullBody) {
            parts.push(fullBody);
            return parts.join('\n');
          }
          // Fallback to elements parsing if API fails
        }

        // Format 1: body.elements (Sigma-generated cards with markdown)
        const bodyElements = content.body?.elements;
        if (Array.isArray(bodyElements)) {
          for (const el of bodyElements) {
            if (el.tag === 'markdown') parts.push(el.content || '');
            else if (el.tag === 'div' && el.text) parts.push(el.text.content || '');
          }
        }

        // Format 2: top-level elements as nested arrays (forwarded emails)
        const topElements = content.elements;
        if (Array.isArray(topElements)) {
          for (const line of topElements) {
            if (Array.isArray(line)) {
              for (const el of line) {
                if (el.tag === 'text' && el.text) parts.push(el.text);
                else if (el.tag === 'a' && (el.text || el.href)) parts.push(el.text || el.href);
              }
            } else if (line && typeof line === 'object') {
              // Single object (not array) — Sigma's card_link format
              if ((line as any).tag === 'markdown') parts.push((line as any).content || '');
            }
          }
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
   * Fetch child messages from a merge_forward (合并转发) message.
   * Returns formatted text of all sub-messages.
   */
  async fetchMergeForwardContent(messageId: string): Promise<string | null> {
    try {
      const resp = await this._client.im.message.get({
        path: { message_id: messageId },
      });

      const items = (resp as any)?.data?.items;
      if (!Array.isArray(items) || items.length === 0) {
        this.logger.warn({ messageId }, 'merge_forward: no child messages found');
        return null;
      }

      const lines: string[] = ['[合并转发内容]'];
      for (const item of items) {
        // Skip the parent merge_forward message itself
        if (item.msg_type === 'merge_forward') continue;

        const senderName = item.sender?.sender_id?.name || '未知';
        let content = '';

        try {
          if (item.msg_type === 'text') {
            const parsed = JSON.parse(item.body?.content || '{}');
            content = parsed.text || '';
          } else if (item.msg_type === 'post') {
            const parsed = JSON.parse(item.body?.content || '{}');
            const body = parsed.zh_cn?.content || parsed.en_us?.content || parsed.content;
            if (Array.isArray(body)) {
              const texts: string[] = [];
              for (const para of body) {
                if (!Array.isArray(para)) continue;
                for (const el of para) {
                  if (el.tag === 'text') texts.push(el.text || '');
                  else if (el.tag === 'a') texts.push(el.text || el.href || '');
                }
              }
              content = texts.join('');
            }
          } else if (item.msg_type === 'image') {
            content = '[图片]';
          } else if (item.msg_type === 'file') {
            const parsed = JSON.parse(item.body?.content || '{}');
            content = `[文件: ${parsed.file_name || 'unknown'}]`;
          } else {
            content = `[${item.msg_type}]`;
          }
        } catch {
          content = '[无法解析]';
        }

        if (content) {
          lines.push(`${senderName}: ${content}`);
        }
      }

      this.logger.info({ messageId, childCount: items.length }, 'Fetched merge_forward content');
      return lines.join('\n');
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to fetch merge_forward content');
      return null;
    }
  }

  /**
   * Download an image from a Feishu message as base64.
   * Uses the messageResource API which works for message attachments.
   */
  async downloadImage(messageId: string, imageKey: string): Promise<{ base64: string; mediaType: string } | null> {
    try {
      const resp = await this._client.im.messageResource.get({
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
   * Download a file attachment from a Feishu message, save to disk, return the path.
   */
  async downloadFile(messageId: string, fileKey: string, fileName: string, destDir: string): Promise<string | null> {
    try {
      const resp = await this._client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

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
        buffer = Buffer.from(await data.arrayBuffer());
      } else {
        this.logger.warn({ messageId, fileKey, type: typeof data }, 'Unknown file response format');
        return null;
      }

      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(destDir, { recursive: true });
      const filePath = path.join(destDir, fileName);
      fs.writeFileSync(filePath, buffer);

      this.logger.info({ messageId, fileKey, fileName, sizeKB: Math.round(buffer.length / 1024), filePath }, 'Downloaded file');
      return filePath;
    } catch (err) {
      this.logger.error({ err, messageId, fileKey, fileName }, 'Failed to download file');
      return null;
    }
  }

  /**
   * Send a text reply to a message (using post format with markdown)
   */
  async sendText(chatId: string, text: string, replyToMessageId?: string, rootId?: string): Promise<string | null> {
    try {
      const content = JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'md', text }]],
        },
      });

      if (replyToMessageId) {
        const resp = await this._client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            content,
            msg_type: 'post',
            ...(rootId ? { reply_in_thread: true } : {}),
          } as any,
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this._client.im.message.create({
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
  async sendCard(chatId: string, cardJson: object, replyToMessageId?: string, rootId?: string): Promise<string | null> {
    try {
      const content = JSON.stringify(cardJson);

      if (replyToMessageId) {
        const resp = await this._client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            content,
            msg_type: 'interactive',
            ...(rootId ? { reply_in_thread: true } : {}),
          } as any,
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this._client.im.message.create({
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
  async sendReply(chatId: string, text: string, replyToMessageId?: string, sessionDir?: string, rootId?: string): Promise<string | null> {
    // Resolve @mentions before sending
    if (sessionDir) {
      text = resolveAtMentions(text, sessionDir);
    }

    // Fix code fences for Feishu Markdown (``` must be on its own line)
    text = text.replace(/([^\n])```/g, '$1\n```');

    // Strip <<TITLE:...>> tag if present (only used for card headers)
    const cleanText = text.replace(/^<<TITLE:.+?>>\s*\n?/, '');
    const mode = detectRenderMode(text);

    this.logger.info({ mode, textLength: text.length, hasTitle: /<<TITLE:/.test(text), rootId }, 'sendReply render mode');

    if (mode === 'card') {
      const card = buildMarkdownCard(text); // pass original text so title can be extracted
      return this.sendCard(chatId, card, replyToMessageId, rootId);
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
          rootId,
        );
        if (i === 0) firstMsgId = msgId;
      }
      return firstMsgId;
    }

    return this.sendText(chatId, cleanText, replyToMessageId, rootId);
  }

  /**
   * Upload a file to Feishu and send it as a file message.
   * @param filePath Absolute path to the file on disk
   */
  async sendFile(chatId: string, filePath: string, replyToMessageId?: string, rootId?: string): Promise<string | null> {
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
      const uploadResp = await (this._client as any).im.file.create({
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

      // Step 2: Send message — mp4 uses 'media' msg_type, others use 'file'
      const isVideo = ext === '.mp4';
      const msgType = isVideo ? 'media' : 'file';
      const content = isVideo
        ? JSON.stringify({ file_key: fileKey, image_key: '' })
        : JSON.stringify({ file_key: fileKey });

      if (replyToMessageId) {
        const resp = await this._client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            content,
            msg_type: msgType,
            ...(rootId ? { reply_in_thread: true } : {}),
          } as any,
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this._client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: msgType,
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
  async sendImage(chatId: string, imagePath: string, replyToMessageId?: string, rootId?: string): Promise<string | null> {
    try {
      if (!fs.existsSync(imagePath)) {
        this.logger.warn({ imagePath }, 'Image not found for sending');
        return null;
      }

      // Step 1: Upload image
      const imageStream = fs.createReadStream(imagePath);
      const uploadResp = await (this._client as any).im.image.create({
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
        const resp = await this._client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            content,
            msg_type: 'image',
            ...(rootId ? { reply_in_thread: true } : {}),
          } as any,
        });
        return (resp as any).data?.message_id || null;
      }

      const resp = await this._client.im.message.create({
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
 * Replace @名字 and @所有人 with Feishu <at> tags using member profiles.
 */
function resolveAtMentions(text: string, sessionDir: string): string {
  // Replace @所有人 first
  text = text.replace(/@所有人/g, '<at id=all></at>');

  // Load name→openId mapping from members/ directory (symlinked into session)
  const membersDir = path.join(sessionDir, 'members');
  try {
    if (!fs.existsSync(membersDir)) return text;

    const nameMap: Array<[string, string]> = [];
    for (const entry of fs.readdirSync(membersDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('ou_')) continue;
      try {
        const profilePath = path.join(membersDir, entry.name, 'profile.json');
        if (!fs.existsSync(profilePath)) continue;
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
        if (profile.name && profile.name !== entry.name) {
          nameMap.push([profile.name, entry.name]);
        }
      } catch { /* skip */ }
    }
    // Sort by name length (longer first to avoid partial matches)
    nameMap.sort((a, b) => b[0].length - a[0].length);

    for (const [name, openId] of nameMap) {
      const pattern = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'g');
      text = text.replace(pattern, `<at id=${openId}></at>`);
    }

    // Fix invalid <at> tags Claude may have generated (e.g. <at id=0></at>)
    // Keep only valid ones: ou_ prefixed IDs and "all"
    text = text.replace(/<at id=([^>]+)><\/at>/g, (match, id) => {
      if (id === 'all' || id.startsWith('ou_')) return match;
      // Try to find author by name in the surrounding text — but can't reliably.
      // Just strip the broken tag and leave a plain @ with whatever text follows.
      return '';
    });
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
    /<{1,2}TITLE:.+?>{1,2}/.test(text) ||// Has explicit title (robust to single brackets)
    /<at\s+id=/.test(text) ||            // @mentions (only work in card markdown)
    text.length > 300;                    // Moderate length text

  return needsCard ? 'card' : 'text';
}

/**
 * Extract <<TITLE:...>> tag from text. Robust to single/double brackets and stray spaces.
 * Returns { title, body } where body has the tag removed. title is empty when not present.
 */
function extractTitle(text: string): { title: string; body: string } {
  // Match TITLE tag anywhere in text — accept 1-2 angle brackets on each side
  const match = text.match(/<{1,2}\s*TITLE\s*:\s*(.+?)\s*>{1,2}\s*\n?/);
  if (match) {
    const body = text.slice(0, match.index).concat(text.slice((match.index || 0) + match[0].length))
      .replace(/^\n+/, '');
    return {
      title: match[1].trim().slice(0, 40),
      body,
    };
  }
  return { title: '', body: text };
}

/**
 * Build a schema 2.0 interactive card with markdown content
 */
function buildMarkdownCard(text: string): object {
  const { title, body } = extractTitle(text);

  // Truncate if too long for card (Feishu limit ~28000 chars)
  const truncated = body.length > 28000 ? body.slice(0, 28000) + '\n\n...(内容已截断)' : body;

  const card: any = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'markdown', content: truncated }],
    },
  };
  // Only render header when bot emitted a TITLE tag
  if (title) {
    card.header = {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    };
  }
  return card;
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
