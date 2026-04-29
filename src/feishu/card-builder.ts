/**
 * CardKit 2.0 card builder for streaming replies.
 * Builds Feishu interactive cards for thinking, streaming, and complete states.
 */

export const STREAMING_ELEMENT_ID = 'streaming_text';
export const TOOL_CALLS_ELEMENT_ID = 'tool_calls';

export interface ToolCallInfo {
  name: string;
  input?: string;
  status: 'running' | 'complete' | 'failed';
  startTime: number;
  endTime?: number;
  toolUseId?: string;
  children?: ToolCallInfo[];
}

/** Extended-thinking entry (no status — thinking is a plain text observation). */
export interface ThinkingEntry {
  text: string;
  at: number;
}

/**
 * Get tool-specific emoji based on tool name.
 */
function toolEmoji(name: string): string {
  if (name === 'Agent' || name.startsWith('Agent #')) return '🤖';
  if (name === 'Bash') return '💻';
  if (name === 'Read') return '📖';
  if (name === 'Edit') return '✏️';
  if (name === 'Write') return '📝';
  if (name === 'Grep') return '🔍';
  if (name === 'Glob') return '📁';
  if (name === 'WebSearch' || name === 'WebFetch') return '🌐';
  if (name === 'Skill') return '🧠';
  if (name === 'ToolSearch') return '🔧';
  if (name.startsWith('mcp__chrome-devtools__') || name.startsWith('mcp__remote-browser__')) return '🖥️';
  if (name.startsWith('mcp__feishu')) return '💬';
  if (name.startsWith('mcp__cron')) return '⏰';
  return '🔧';
}

/**
 * Build a "thinking" card — shown while Claude starts processing.
 */
export function buildThinkingCard(): object {
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '💭 思考中...' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: '正在处理你的消息...',
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  };
}

/**
 * Build a streaming card — updated periodically with new text and tool calls.
 * Thinking entries (if any) are interleaved into the panel body as markdown lines.
 */
export function buildStreamingCard(
  text: string,
  toolCalls?: ToolCallInfo[],
  startTime?: number,
  thinkingEntries?: ThinkingEntry[],
  usage?: UsageInfo,
): object {
  const elements: object[] = [];

  // Detect TITLE tag in streamed text via the shared tolerant parser.
  const { title: extracted, body, color: headerColor } = extractTitleFromText(text || '', 30);
  let displayText = body;
  let headerTitle = extracted;

  const toolCount = toolCalls?.length || 0;
  const thinkingCount = thinkingEntries?.length || 0;

  // Tool + thinking panel — collapsible, default collapsed
  if (toolCount > 0 || thinkingCount > 0) {
    let panelTitle = toolCount > 0 ? `🔄 ${toolCount} 次工具调用` : `🔄 ${thinkingCount} 次思考`;
    if (toolCount > 0 && thinkingCount > 0) panelTitle += ` · ${thinkingCount} 次思考`;
    if (startTime) panelTitle += ` · ${formatDuration(Date.now() - startTime)}`;
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: panelTitle,
        },
      },
      border: { color: 'grey' },
      vertical_spacing: '8px',
      padding: '4px 8px 4px 8px',
      elements: buildToolPanelElements(toolCalls || [], thinkingEntries || [], false),
    });
  }

  // Main text content
  if (displayText) {
    elements.push({
      tag: 'markdown',
      content: displayText,
      element_id: STREAMING_ELEMENT_ID,
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: '正在处理...',
      element_id: STREAMING_ELEMENT_ID,
    });
  }

  // Live footer — 🕙 elapsed · N 工具调用 · tokens · ctx% · cache hit%
  // Each part is only emitted once it has a meaningful non-zero value, so the
  // footer grows naturally as data arrives instead of flashing "0 tokens".
  const footerParts: string[] = [];
  if (startTime) {
    footerParts.push(`🕙 ${formatDuration(Date.now() - startTime)}`);
  } else {
    footerParts.push('🕙');
  }
  if (toolCount > 0) {
    footerParts.push(`${toolCount} 工具调用`);
  }
  if (usage) {
    const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (totalTokens > 0) {
      footerParts.push(`${formatTokenCount(totalTokens)} tokens (in: ${formatTokenCount(usage.inputTokens || 0)} / out: ${formatTokenCount(usage.outputTokens || 0)})`);
    }
    const peakPrompt = (usage.peakCallInputTokens || 0) + (usage.peakCallCacheReadTokens || 0) + (usage.peakCallCacheCreationTokens || 0);
    const aggregatePrompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheCreationTokens || 0);
    const promptForCtx = peakPrompt > 0 ? peakPrompt : aggregatePrompt;
    if (promptForCtx > 0) {
      const window = contextWindowOf(usage.model);
      const windowLabel = window >= 1_000_000 ? '1M' : `${window / 1000}K`;
      const ctxPct = Math.min(100, Math.round((promptForCtx / window) * 100));
      footerParts.push(`ctx ${ctxPct}% of ${windowLabel}${ctxHint(ctxPct)}`);
    }
    const cacheReadForHit = peakPrompt > 0 ? (usage.peakCallCacheReadTokens || 0) : (usage.cacheReadTokens || 0);
    if (cacheReadForHit > 0 && promptForCtx > 0) {
      const hitPct = Math.round((cacheReadForHit / promptForCtx) * 100);
      footerParts.push(`cache hit ${hitPct}%`);
    }
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: footerParts.join(' · '),
    text_size: 'notation',
  });

  const card: any = {
    schema: '2.0',
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
  // Only render header when bot has emitted a TITLE tag
  if (headerTitle) {
    card.header = {
      template: headerColor,
      title: { tag: 'plain_text', content: `✍️ ${headerTitle}` },
    };
  }
  return card;
}

/**
 * Build a complete card — final state with full text and optional reasoning panel.
 * @param title - Custom card header title. If not provided, uses "✅ Sigma".
 */
export interface ButtonInfo {
  label: string;
  actionId: string;
  type?: string; // default, primary, danger
  disabled?: boolean;
  url?: string; // if set, button opens URL instead of triggering callback
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // Single-call peak — use these (not the turn-aggregate) for ctx% so agent loops
  // don't inflate the indicator past 100%.
  peakCallInputTokens?: number;
  peakCallCacheReadTokens?: number;
  peakCallCacheCreationTokens?: number;
  costUsd?: number;
  model?: string; // resolved model, e.g. "sonnet[1m]" / "opus[1m]" / "haiku"
}

/**
 * Context window size (in tokens) for the given resolved model string.
 * Anything with a `[1m]` suffix gets 1M; otherwise default 200K.
 */
function contextWindowOf(model?: string): number {
  if (model && /\[1m\]/i.test(model)) return 1_000_000;
  return 200_000;
}

/**
 * Turn the context-fill percentage into an actionable hint for the user.
 * Thresholds picked so a hint only appears once the session is genuinely heavy.
 */
function ctxHint(pct: number): string {
  if (pct >= 95) return ' · 🚨 请立即 /compact 或 /new';
  if (pct >= 80) return ' · ⚠️ 建议 /compact';
  if (pct >= 60) return ' · 💡 建议 /compact';
  return '';
}

/**
 * Check if a response is the NO_REPLY sentinel (Claude's signal to skip replying).
 * Tolerant to case, whitespace, separator (_ / space / -), trailing punctuation, surrounding quotes.
 * Only matches when the ENTIRE text is a NO_REPLY variant — partial matches don't count.
 */
export function isNoReply(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^\s*["'`]?\s*NO[\s_-]?REPLY\s*["'`]?\s*[.。!！]*\s*$/i.test(text);
}

/**
 * Custom tag regex patterns — always inline new literals at call sites (global flag carries state).
 * Canonical forms (documented in system-prompt/common.md, accepted by all parsers):
 *   TITLE:   <{1,2}\s*TITLE\s*[:：]\s*([^<>\n]+?)[<\/\s]*>{1,2}       canonical extract
 *            <{1,2}\s*TITLE\s*[:：]?[^<>\n]*?[<\/\s]*>{1,2}\s*\n?     strip (tolerant)
 *            <\/\s*TITLE\s*>{0,2}\s*\n?                               strip orphan closing
 *   BUTTON:  <{1,2}\s*BUTTON\s*:\s*([^|>]+?)\s*\|...>{1,2}            canonical extract
 *            <{1,2}\s*BUTTON\s*:[^>]+>{1,2}\s*                        strip (tolerant)
 *   REACT:   <{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*               extract + strip
 *   THREAD:  <{1,2}\s*THREAD\s*>{1,2}\s*                              strip
 * All tolerant to 1-2 angle brackets, case-insensitive (add /i flag), optional spaces, fullwidth colon.
 * TITLE also tolerates trailing `[<\/\s]*` garbage before `>>` (e.g. `<<TITLE:xxx</>>` — Claude sometimes
 * inserts `</` right before the closing double-bracket).
 */

/**
 * Extract <<REACT:emoji>> tags and return the list of emojis and the cleaned text.
 */
export function extractReactions(text: string): { cleanText: string; emojis: string[] } {
  const emojis: string[] = [];
  const cleanText = text.replace(/<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi, (_, emoji) => { emojis.push(emoji); return ''; });
  return { cleanText, emojis };
}

/**
 * Extract a TITLE tag from text. Tolerant to many malformed variants Claude emits:
 *   <<TITLE:xxx>>, <TITLE:xxx>, <<TITLE：xxx>> (fullwidth colon),
 *   <TITLE:xxx</TITLE>, <<TITLE:xxx></TITLE>> (HTML-mixed, missing middle >),
 *   <TITLE>xxx</TITLE> (pure HTML),
 *   <<TITLE>xxx</<TITLE>> (garbled close with stray </< prefix).
 * Returns { title, body } — title is empty string when no TITLE tag found.
 *
 * Closing-tag pattern accepts any combination of `/`, `<`, whitespace as garbage between `<` and `TITLE`,
 * which tolerates common Claude mistakes like `</<TITLE>`, `< / TITLE>`, `</TITLE`.
 */
/**
 * Valid Feishu card header `template` values. Anything else falls back to 'blue'.
 */
const VALID_HEADER_COLORS = new Set([
  'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange',
  'red', 'carmine', 'violet', 'purple', 'indigo', 'grey',
]);

function normalizeColor(c: string | undefined | null): string {
  if (!c) return 'blue';
  const lower = c.trim().toLowerCase();
  return VALID_HEADER_COLORS.has(lower) ? lower : 'blue';
}

export function extractTitleFromText(text: string, maxLen = 40): { title: string; body: string; color: string } {
  // Priority 0: extended <<TITLE:xxx|color>> — color suffix to drive header.template.
  // Title body must not contain < > | or newline. `[<\/\s]*` before the closing `>>`
  // tolerates trailing garbage like `<<TITLE:xxx|green</>>`.
  let match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<>\n|]+?)\s*\|\s*([a-zA-Z]+)\s*[<\/\s]*>{1,2}\s*\n?/i);
  let color = 'blue';
  if (match) {
    color = normalizeColor(match[2]);
  } else {
    // Priority 1: canonical <<TITLE:xxx>> — title body must not contain < > or newline.
    match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<>\n]+?)[<\/\s]*>{1,2}\s*\n?/i);
  }
  // Priority 2: HTML-mixed <TITLE:xxx</TITLE> — colon form with (possibly garbled) close.
  if (!match) {
    match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<\n]+?)\s*<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/i);
  }
  // Priority 3: pure HTML <TITLE>xxx</TITLE> — no-colon form with (possibly garbled) close
  if (!match) {
    match = text.match(/<{1,2}\s*TITLE\s*>\s*([^<\n]+?)\s*<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/i);
  }
  if (!match) return { title: '', body: text, color: 'blue' };
  let body = text.slice(0, match.index).concat(text.slice((match.index || 0) + match[0].length));
  // Strip any stray TITLE fragments left behind (duplicates, orphan closes — including garbled `</<TITLE>`).
  // The opening-tag strip pattern also catches `<<TITLE:xxx|color>>` variants since `[^<>\n]` permits `|`.
  body = body
    .replace(/<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/gi, '')
    .replace(/<{1,2}\s*TITLE\s*[:：]?[^<>\n]*?[<\/\s]*>{1,2}\s*\n?/gi, '')
    .replace(/^\n+/, '');
  return { title: match[1].trim().slice(0, maxLen), body, color };
}

/**
 * Extract <<BUTTON:label|actionId|type?>> tags from text.
 */
export function extractButtons(text: string): { cleanText: string; buttons: ButtonInfo[] } {
  const buttons: ButtonInfo[] = [];
  const cleanText = text.replace(/<{1,2}\s*BUTTON\s*:\s*([^|>]+?)\s*\|\s*([^|>]+?)\s*(?:\|\s*([^>]+?)\s*)?>{1,2}[\s]*/gi, (_, label, actionId, type) => {
    const trimmedAction = actionId.trim();
    const isLink = /^https?:\/\//.test(trimmedAction);
    buttons.push({
      label: isLink ? `🔗 ${label.trim()}` : label.trim(),
      actionId: trimmedAction,
      type: type?.trim(),
      url: isLink ? trimmedAction : undefined,
    });
    return '';
  }).trim();
  return { cleanText, buttons };
}

export interface ButtonContext {
  sessionKey?: string;
  chatId?: string;
  cardId?: string;
  messageId?: string;
}

/**
 * Build Feishu card elements for a list of buttons (2 per row, 50% width each).
 * Link buttons (url set) always render. Callback buttons render only when sessionKey is provided.
 */
export function buildButtonElements(buttons: ButtonInfo[], ctx: ButtonContext = {}): object[] {
  const renderable = buttons.filter(btn => btn.url || ctx.sessionKey);
  if (renderable.length === 0) return [];
  const buildColumn = (btn: ButtonInfo) => {
    const behaviors = btn.url
      ? [{ type: 'open_url', default_url: btn.url }]
      : [{
          type: 'callback',
          value: {
            action: btn.actionId,
            label: btn.label,
            sessionKey: ctx.sessionKey || '',
            chatId: ctx.chatId || '',
            cardId: ctx.cardId || '',
            messageId: ctx.messageId || '',
          },
        }];
    return {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        type: btn.type || 'default',
        width: 'fill',
        text: { tag: 'plain_text', content: btn.label },
        disabled: btn.disabled || false,
        behaviors,
      }],
    };
  };
  const out: object[] = [];
  for (let i = 0; i < renderable.length; i += 2) {
    const row = renderable.slice(i, i + 2);
    const columns = row.map(buildColumn);
    if (columns.length === 1) {
      columns.push({ tag: 'column', width: 'weighted', weight: 1, elements: [] } as any);
    }
    out.push({
      tag: 'column_set',
      columns,
      flex_mode: 'none',
      horizontal_spacing: '8px',
      margin: i > 0 ? '8px 0 0 0' : undefined,
    });
  }
  return out;
}

export function buildCompleteCard(
  text: string,
  toolCalls?: ToolCallInfo[],
  elapsed?: number,
  title?: string,
  buttons?: ButtonInfo[],
  sessionKey?: string,
  chatId?: string,
  cardId?: string,
  messageId?: string,
  usage?: UsageInfo,
  thinkingEntries?: ThinkingEntry[],
): object {
  // Extract TITLE tag via shared tolerant parser (handles <<TITLE:xxx>>, <<TITLE:xxx|color>>, HTML-mixed, etc.)
  const { title: extracted, body, color: headerColor } = extractTitleFromText(text || '(空回复)', 30);
  let displayText = body;
  let headerTitle = title || (extracted ? `✅ ${extracted}` : '');

  const elements: object[] = [];

  const toolCount = toolCalls?.length || 0;
  const thinkingCount = thinkingEntries?.length || 0;

  // Tool + thinking panel — collapsible panel at the top, default collapsed
  if (toolCount > 0 || thinkingCount > 0) {
    let toolPanelTitle = toolCount > 0 ? `✅ ${toolCount} 次工具调用` : `✅ ${thinkingCount} 次思考`;
    if (toolCount > 0 && thinkingCount > 0) toolPanelTitle += ` · ${thinkingCount} 次思考`;
    if (elapsed) toolPanelTitle += ` · ${formatDuration(elapsed)}`;
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: toolPanelTitle,
        },
      },
      border: { color: 'grey' },
      vertical_spacing: '8px',
      padding: '4px 8px 4px 8px',
      elements: buildToolPanelElements(toolCalls || [], thinkingEntries || [], false),
    });
  }

  // Main text content
  elements.push({
    tag: 'markdown',
    content: displayText,
    element_id: STREAMING_ELEMENT_ID,
  });

  // Buttons (if any) — 2 per row, each column 50% via weighted width
  if (buttons && buttons.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(...buildButtonElements(buttons, { sessionKey, chatId, cardId, messageId }));
  }

  // Footer — status + metrics
  elements.push({ tag: 'hr' });
  const footerParts: string[] = [];
  footerParts.push(elapsed ? `✅ ${formatDuration(elapsed)}` : '✅');
  if (toolCalls && toolCalls.length > 0) {
    footerParts.push(`${toolCalls.length} 工具调用`);
  }
  if (usage) {
    const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (totalTokens > 0) {
      footerParts.push(`${formatTokenCount(totalTokens)} tokens (in: ${formatTokenCount(usage.inputTokens || 0)} / out: ${formatTokenCount(usage.outputTokens || 0)})`);
    }
    // Use peak single-call prompt for ctx% — falls back to turn-aggregate only if
    // peak isn't available (e.g. older log entries). Peak never exceeds the window.
    const peakPrompt = (usage.peakCallInputTokens || 0) + (usage.peakCallCacheReadTokens || 0) + (usage.peakCallCacheCreationTokens || 0);
    const aggregatePrompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheCreationTokens || 0);
    const promptForCtx = peakPrompt > 0 ? peakPrompt : aggregatePrompt;
    if (promptForCtx > 0) {
      const window = contextWindowOf(usage.model);
      const windowLabel = window >= 1_000_000 ? '1M' : `${window / 1000}K`;
      const ctxPct = Math.min(100, Math.round((promptForCtx / window) * 100));
      footerParts.push(`ctx ${ctxPct}% of ${windowLabel}${ctxHint(ctxPct)}`);
    }
    // Cache hit% uses the same call's numbers as ctx% for consistency.
    const cacheReadForHit = peakPrompt > 0 ? (usage.peakCallCacheReadTokens || 0) : (usage.cacheReadTokens || 0);
    if (cacheReadForHit > 0 && promptForCtx > 0) {
      const hitPct = Math.round((cacheReadForHit / promptForCtx) * 100);
      footerParts.push(`cache hit ${hitPct}%`);
    }
  }
  elements.push({
    tag: 'markdown',
    content: footerParts.join(' · '),
    text_size: 'notation',
  });

  const card: any = {
    schema: '2.0',
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
  if (headerTitle) {
    card.header = {
      template: headerColor,
      title: { tag: 'plain_text', content: headerTitle },
    };
  }
  return card;
}

/**
 * Extract a short title from response text for the card header.
 * Takes the first meaningful line, strips markdown, and truncates.
 * (Currently unused — kept for backward compatibility.)
 */
function extractAutoTitle(text: string): string {
  // Strip markdown formatting and find first meaningful line
  const lines = text.split('\n');
  for (const line of lines) {
    // Strip markdown: headers, bold, links, code, @mentions, bullets
    let clean = line
      .replace(/^#{1,6}\s+/, '')       // headers
      .replace(/\*\*(.+?)\*\*/g, '$1') // bold
      .replace(/\*(.+?)\*/g, '$1')     // italic
      .replace(/`(.+?)`/g, '$1')       // inline code
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // links
      .replace(/^[-*•]\s+/, '')        // bullets
      .replace(/^\d+\.\s+/, '')        // numbered lists
      .trim();
    if (clean.length >= 2) {
      // Truncate to 20 chars at word boundary
      if (clean.length > 20) {
        const cut = clean.slice(0, 20);
        const lastSpace = cut.lastIndexOf(' ');
        clean = lastSpace > 10 ? cut.slice(0, lastSpace) : cut;
      }
      return clean;
    }
  }
  return 'Sigma';
}

/**
 * Format elapsed milliseconds as M:SS (e.g. 2:05) or Xs for under 60s.
 * Capped at 30m to avoid runaway display values from orphaned cards.
 */
function formatDuration(ms: number): string {
  if (ms > 30 * 60 * 1000) return '> 30m';
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format token count as human-readable string (e.g. 1.2k, 45.3k).
 */
function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/**
 * Format tool calls for display in a streaming card.
 * Only shows the last 10 entries to keep the card compact.
 */
function formatToolCalls(toolCalls: ToolCallInfo[]): string {
  const MAX_VISIBLE = 5;

  // Prioritize running items — never fold them
  let visible: ToolCallInfo[];
  if (toolCalls.length <= MAX_VISIBLE) {
    visible = toolCalls;
  } else {
    const running = toolCalls.filter(t => t.status === 'running');
    const done = toolCalls.filter(t => t.status !== 'running');
    const doneSlots = Math.max(0, MAX_VISIBLE - running.length);
    visible = [...(doneSlots > 0 ? done.slice(-doneSlots) : []), ...running];
  }
  const hidden = toolCalls.length - visible.length;

  const lines: string[] = [];
  if (hidden > 0) {
    lines.push(`... ${hidden} 条已折叠`);
  }
  for (const tc of visible) {
    lines.push(`- ${formatSingleTool(tc)}`);
    // Render subagent children tree with markdown nested list
    if (tc.children && tc.children.length > 0) {
      const completed = tc.children.filter(c => c.status !== 'running');
      const running = tc.children.filter(c => c.status === 'running');
      // 1. Collapsed completed count
      if (completed.length > 1) {
        const elapsed = Date.now() - completed[0].startTime;
        const totalSecs = Math.round(elapsed / 1000);
        const timeStr = totalSecs < 60 ? `${totalSecs}s` : `${Math.floor(totalSecs / 60)}:${(totalSecs % 60).toString().padStart(2, '0')}`;
        lines.push(`   - ... ${completed.length - 1} 条已折叠 · 总用时 ${timeStr}`);
      }
      // 2. Last completed step
      if (completed.length > 0) {
        lines.push(`   - ${formatSingleTool(completed[completed.length - 1])}`);
      }
      // 3. Currently running step
      if (running.length > 0) {
        lines.push(`   - ${formatSingleTool(running[running.length - 1])}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Compute the parts of a tool call display: status icon, name, time string, input summary.
 * Used by both markdown and plain-text formatters.
 */
function toolCallParts(tc: ToolCallInfo): { statusIcon: string; emoji: string; name: string; statusText: string; inputSummary: string } {
  const statusIcon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
  const emoji = toolEmoji(tc.name);
  const isAgent = tc.name === 'Agent' || tc.name.startsWith('Agent #');

  // For Agent with children: compute duration from children's time span
  let durationSecs: number | undefined;
  if (tc.endTime) {
    if (isAgent && tc.children && tc.children.length > 0) {
      const firstStart = tc.children[0].startTime;
      const lastEnd = tc.children[tc.children.length - 1].endTime || Date.now();
      durationSecs = (lastEnd - firstStart) / 1000;
    } else {
      durationSecs = (tc.endTime - tc.startTime) / 1000;
    }
  } else if (tc.status === 'running' && isAgent && tc.children && tc.children.length > 0) {
    // Running Agent: show elapsed since first child started
    durationSecs = (Date.now() - tc.children[0].startTime) / 1000;
  } else if (tc.status === 'running') {
    // Generic running tool: elapsed since startTime
    durationSecs = (Date.now() - tc.startTime) / 1000;
  }

  let timeStr = '';
  if (durationSecs != null) {
    timeStr = durationSecs < 60 ? `${durationSecs.toFixed(1)}s` : `${Math.floor(durationSecs / 60)}:${Math.round(durationSecs % 60).toString().padStart(2, '0')}`;
  }
  // Show elapsed time for running tools (instead of generic "执行中...")
  const statusText = tc.status === 'running' && !timeStr ? '执行中...' : timeStr;

  let inputSummary = '';
  if (tc.input) {
    const truncated = tc.input.length > 80 ? tc.input.slice(0, 80) + '...' : tc.input;
    inputSummary = ` ${truncated}`;
  }

  return { statusIcon, emoji, name: tc.name, statusText, inputSummary };
}

function formatSingleTool(tc: ToolCallInfo): string {
  const { statusIcon, emoji, name, statusText, inputSummary } = toolCallParts(tc);
  return `${statusIcon} ${emoji} **${name}** ${statusText ? `(${statusText})` : ''}${inputSummary}`;
}

/**
 * Format a single thinking entry as a markdown line for the "X 次工具调用已完成" panel.
 * No status prefix — thinking is a plain observation, not a tool call.
 * Truncates long thinking text to keep the panel compact.
 */
function formatThinkingLine(text: string, maxLen = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const truncated = oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
  return `💭 ${truncated}`;
}

/**
 * Plain-text version (no markdown formatting) for use in collapsible_panel headers,
 * which use plain_text and won't render markdown.
 */
function formatSingleToolPlain(tc: ToolCallInfo): string {
  const { statusIcon, emoji, name, statusText, inputSummary } = toolCallParts(tc);
  return `${statusIcon} ${emoji} ${name} ${statusText ? `(${statusText})` : ''}${inputSummary}`;
}

/**
 * Format tool calls summary for the completed card's collapsed panel.
 */
function formatToolCallsSummary(toolCalls: ToolCallInfo[]): string {
  const lines: string[] = [];
  for (const tc of toolCalls) {
    // Skip agents with children — they get their own nested panel
    if ((tc.name === 'Agent' || tc.name.startsWith('Agent #')) && tc.children && tc.children.length > 0) continue;
    lines.push(`- ${formatSingleTool(tc)}`);
  }
  return lines.join('\n');
}

/**
 * Build card elements for tool calls panel content.
 * Agent tools with children get nested collapsible_panel; others are markdown lines.
 * @param expanded Whether agent sub-panels should be expanded (true for streaming, false for complete).
 */
function buildToolPanelElements(toolCalls: ToolCallInfo[], thinkingEntries: ThinkingEntry[], expanded: boolean): object[] {
  const elements: object[] = [];

  // Separate agents-with-children from flat tools
  const flatTools: ToolCallInfo[] = [];
  const agents: ToolCallInfo[] = [];
  for (const tc of toolCalls) {
    if ((tc.name === 'Agent' || tc.name.startsWith('Agent #')) && tc.children && tc.children.length > 0) {
      agents.push(tc);
    } else {
      flatTools.push(tc);
    }
  }

  const completed = flatTools.filter(tc => tc.status !== 'running');
  const running = flatTools.filter(tc => tc.status === 'running');

  // Nested "已完成" panel: completed tools + thinking entries, interleaved by timestamp.
  // All rows are markdown lines (thinking has no status — just 💭 + text).
  if (completed.length > 0 || thinkingEntries.length > 0) {
    type TimelineItem =
      | { kind: 'tool'; at: number; tool: ToolCallInfo }
      | { kind: 'thinking'; at: number; text: string };
    const timeline: TimelineItem[] = [
      ...completed.map(tc => ({ kind: 'tool' as const, at: tc.startTime, tool: tc })),
      ...thinkingEntries.map(t => ({ kind: 'thinking' as const, at: t.at, text: t.text })),
    ];
    timeline.sort((a, b) => a.at - b.at);

    const lines = timeline.map(item =>
      item.kind === 'tool' ? formatSingleTool(item.tool) : formatThinkingLine(item.text),
    );

    const headerText = completed.length > 0
      ? `✅ ${completed.length} 次工具调用已完成`
      : `💭 ${thinkingEntries.length} 次思考`;

    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: headerText },
      },
      border: { color: 'grey' },
      vertical_spacing: '4px',
      padding: '4px 8px 4px 8px',
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    });
  }

  // Running tools → show as markdown (outside the "已完成" panel)
  if (running.length > 0) {
    const runningLines = running.map(tc => formatSingleTool(tc));
    elements.push({ tag: 'markdown', content: runningLines.join('\n') });
  }

  // Each agent with children gets its own nested collapsible_panel
  for (const agent of agents) {
    const childLines = (agent.children || []).map(c => formatSingleTool(c));
    elements.push({
      tag: 'collapsible_panel',
      expanded,
      header: {
        title: {
          tag: 'plain_text',
          content: formatSingleToolPlain(agent),
        },
      },
      border: { color: 'grey' },
      vertical_spacing: '4px',
      padding: '4px 8px 4px 8px',
      elements: [
        { tag: 'markdown', content: childLines.join('\n') },
      ],
    });
  }

  return elements;
}
