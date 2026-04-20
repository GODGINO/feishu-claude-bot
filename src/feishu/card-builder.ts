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
 */
export function buildStreamingCard(text: string, toolCalls?: ToolCallInfo[], startTime?: number): object {
  const elements: object[] = [];

  // Detect TITLE tag in streamed text via the shared tolerant parser.
  const { title: extracted, body } = extractTitleFromText(text || '', 30);
  let displayText = body;
  let headerTitle = extracted;

  // Tool calls section — collapsible panel at the top, default collapsed
  if (toolCalls && toolCalls.length > 0) {
    let panelTitle = `🔄 ${toolCalls.length} 次工具调用`;
    if (startTime) {
      panelTitle += ` · ${formatDuration(Date.now() - startTime)}`;
    }
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
      elements: buildToolPanelElements(toolCalls, false),
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
      template: 'blue',
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
  costUsd?: number;
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
 * Canonical forms (documented in system-prompt.txt, accepted by all parsers):
 *   TITLE:   <{1,2}\s*TITLE\s*[:：]\s*([^<>\n]+?)\s*>{1,2}           canonical extract
 *            <{1,2}\s*TITLE\s*[:：]?[^<>\n]*?>{1,2}\s*\n?            strip (tolerant)
 *            <\/\s*TITLE\s*>{0,2}\s*\n?                               strip orphan closing
 *   BUTTON:  <{1,2}\s*BUTTON\s*:\s*([^|>]+?)\s*\|...>{1,2}            canonical extract
 *            <{1,2}\s*BUTTON\s*:[^>]+>{1,2}\s*                        strip (tolerant)
 *   REACT:   <{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*               extract + strip
 *   THREAD:  <{1,2}\s*THREAD\s*>{1,2}\s*                              strip
 * All tolerant to 1-2 angle brackets, case-insensitive (add /i flag), optional spaces, fullwidth colon.
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
export function extractTitleFromText(text: string, maxLen = 40): { title: string; body: string } {
  // Priority 1: canonical <<TITLE:xxx>> — title body must not contain < > or newline
  let match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<>\n]+?)\s*>{1,2}\s*\n?/i);
  // Priority 2: HTML-mixed <TITLE:xxx</TITLE> — colon form with (possibly garbled) close.
  // Closing regex requires `/` so it can't accidentally match a nested opening `<TITLE>`.
  if (!match) {
    match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<\n]+?)\s*<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/i);
  }
  // Priority 3: pure HTML <TITLE>xxx</TITLE> — no-colon form with (possibly garbled) close
  if (!match) {
    match = text.match(/<{1,2}\s*TITLE\s*>\s*([^<\n]+?)\s*<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/i);
  }
  if (!match) return { title: '', body: text };
  let body = text.slice(0, match.index).concat(text.slice((match.index || 0) + match[0].length));
  // Strip any stray TITLE fragments left behind (duplicates, orphan closes — including garbled `</<TITLE>`).
  // Order matters: closing-shaped tags first so the opening-tag strip doesn't eat the inner `<TITLE>`
  // from a garbled close (e.g. `</<TITLE>`), leaving a trailing `</` artifact.
  // The closing regex REQUIRES `/` (via `\/`) so it doesn't accidentally match bare opening tags like `<<TITLE`.
  body = body
    .replace(/<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/gi, '')
    .replace(/<{1,2}\s*TITLE\s*[:：]?[^<>\n]*?>{1,2}\s*\n?/gi, '')
    .replace(/^\n+/, '');
  return { title: match[1].trim().slice(0, maxLen), body };
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

export function buildCompleteCard(text: string, toolCalls?: ToolCallInfo[], elapsed?: number, title?: string, buttons?: ButtonInfo[], sessionKey?: string, chatId?: string, cardId?: string, messageId?: string, usage?: UsageInfo): object {
  // Extract TITLE tag via shared tolerant parser (handles <<TITLE:xxx>>, HTML-mixed, etc.)
  const { title: extracted, body } = extractTitleFromText(text || '(空回复)', 30);
  let displayText = body;
  let headerTitle = title || (extracted ? `✅ ${extracted}` : '');

  const elements: object[] = [];

  // Tool calls — collapsible panel at the top, default collapsed
  if (toolCalls && toolCalls.length > 0) {
    let toolPanelTitle = `✅ ${toolCalls.length} 次工具调用`;
    if (elapsed) {
      toolPanelTitle += ` · ${formatDuration(elapsed)}`;
    }
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
      elements: buildToolPanelElements(toolCalls, false),
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
  const footerParts = ['✅ 完成'];
  if (elapsed) {
    footerParts.push(`耗时 ${formatDuration(elapsed)}`);
  }
  if (toolCalls && toolCalls.length > 0) {
    footerParts.push(`${toolCalls.length} 次工具调用`);
  }
  if (usage) {
    const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (totalTokens > 0) {
      footerParts.push(`${formatTokenCount(totalTokens)} tokens (in: ${formatTokenCount(usage.inputTokens || 0)} / out: ${formatTokenCount(usage.outputTokens || 0)})`);
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
      template: 'blue',
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
function buildToolPanelElements(toolCalls: ToolCallInfo[], expanded: boolean): object[] {
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

  // Flat tools: separate completed from running
  if (flatTools.length > 0) {
    const completed = flatTools.filter(tc => tc.status !== 'running');
    const running = flatTools.filter(tc => tc.status === 'running');

    // Completed tools → nested collapsible panel (collapsed)
    if (completed.length > 0) {
      const completedLines = completed.map(tc => formatSingleTool(tc));
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'plain_text',
            content: `✅ ${completed.length} 次工具调用已完成`,
          },
        },
        border: { color: 'grey' },
        vertical_spacing: '4px',
        padding: '4px 8px 4px 8px',
        elements: [
          { tag: 'markdown', content: completedLines.join('\n') },
        ],
      });
    }

    // Running tools → show expanded
    if (running.length > 0) {
      const runningLines = running.map(tc => formatSingleTool(tc));
      elements.push({ tag: 'markdown', content: runningLines.join('\n') });
    }
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
