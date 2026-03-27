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
      template: 'green',
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
export function buildStreamingCard(text: string, toolCalls?: ToolCallInfo[]): object {
  const elements: object[] = [];

  // Main text content
  if (text) {
    elements.push({
      tag: 'markdown',
      content: text,
      element_id: STREAMING_ELEMENT_ID,
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: '正在处理...',
      element_id: STREAMING_ELEMENT_ID,
    });
  }

  // Tool calls section
  if (toolCalls && toolCalls.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: formatToolCalls(toolCalls),
      element_id: TOOL_CALLS_ELEMENT_ID,
    });
  }

  return {
    schema: '2.0',
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '✍️ 生成中...' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
}

/**
 * Build a complete card — final state with full text and optional reasoning panel.
 * @param title - Custom card header title. If not provided, uses "✅ Sigma".
 */
export interface ButtonInfo {
  label: string;
  actionId: string;
  type?: string; // default, primary, danger
}

/**
 * Extract <<BUTTON:label|actionId|type?>> tags from text.
 */
export function extractButtons(text: string): { cleanText: string; buttons: ButtonInfo[] } {
  const buttons: ButtonInfo[] = [];
  const cleanText = text.replace(/<<BUTTON:([^|>]+)\|([^|>]+)(?:\|([^>]+))?>>[\s]*/g, (_, label, actionId, type) => {
    buttons.push({ label: label.trim(), actionId: actionId.trim(), type: type?.trim() });
    return '';
  }).trim();
  return { cleanText, buttons };
}

export function buildCompleteCard(text: string, toolCalls?: ToolCallInfo[], elapsed?: number, title?: string, buttons?: ButtonInfo[], sessionKey?: string, chatId?: string): object {
  // Extract <<TITLE:...>> from text if present and no explicit title
  let displayText = text || '(空回复)';
  let headerTitle = title || '';
  // Match <<TITLE:...>> with flexible syntax: 1-2 angle brackets, anywhere in text
  const titleMatch = displayText.match(/<?<<TITLE:(.+?)>>>?\s*\n?/);
  if (titleMatch) {
    if (!title) {
      headerTitle = `✅ ${titleMatch[1].trim().slice(0, 30)}`;
    }
    displayText = displayText.replace(titleMatch[0], '').replace(/^\n/, '');
  }
  // Also strip any remaining TITLE tag variants from display text
  displayText = displayText.replace(/<?<<TITLE:.+?>>>?\s*\n?/g, '').replace(/^<TITLE:.+?>\s*\n?/gm, '');
  // Auto-generate title from content if no <<TITLE:...>> and no explicit title
  if (!headerTitle) {
    headerTitle = `✅ ${extractAutoTitle(displayText)}`;
  }

  const elements: object[] = [];

  // Main text content
  elements.push({
    tag: 'markdown',
    content: displayText,
    element_id: STREAMING_ELEMENT_ID,
  });

  // Footer as markdown (note tag not supported in schema 2.0)
  const footerParts = ['✅ 完成'];
  if (elapsed) {
    footerParts.push(`耗时 ${formatDuration(elapsed)}`);
  }
  if (toolCalls && toolCalls.length > 0) {
    footerParts.push(`${toolCalls.length} 次工具调用`);
  }

  // Buttons (if any)
  if (buttons && buttons.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: buttons.map(btn => ({
        tag: 'button',
        type: btn.type || 'default',
        text: { tag: 'plain_text', content: btn.label },
        behaviors: [{
          type: 'callback',
          value: {
            action: btn.actionId,
            label: btn.label,
            sessionKey: sessionKey || '',
            chatId: chatId || '',
          },
        }],
      })),
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: footerParts.join(' · '),
  });

  return {
    schema: '2.0',
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: headerTitle },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
}

/**
 * Extract a short title from response text for the card header.
 * Takes the first meaningful line, strips markdown, and truncates.
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
 */
function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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
    visible = [...done.slice(-doneSlots), ...running];
  }
  const hidden = toolCalls.length - visible.length;

  const lines: string[] = [];
  if (hidden > 0) {
    const elapsed = Date.now() - toolCalls[0].startTime;
    const totalSecs = Math.round(elapsed / 1000);
    const timeStr = totalSecs < 60 ? `${totalSecs}s` : `${Math.floor(totalSecs / 60)}:${(totalSecs % 60).toString().padStart(2, '0')}`;
    lines.push(`... ${hidden} 条已折叠，总用时 ${timeStr}`);
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

function formatSingleTool(tc: ToolCallInfo): string {
  const statusIcon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
  const emoji = toolEmoji(tc.name);

  // For Agent with children: compute duration from children's time span
  let durationSecs: number | undefined;
  if (tc.endTime) {
    if ((tc.name === 'Agent' || tc.name.startsWith('Agent #')) && tc.children && tc.children.length > 0) {
      const firstStart = tc.children[0].startTime;
      const lastEnd = tc.children[tc.children.length - 1].endTime || Date.now();
      durationSecs = (lastEnd - firstStart) / 1000;
    } else {
      durationSecs = (tc.endTime - tc.startTime) / 1000;
    }
  } else if (tc.status === 'running' && (tc.name === 'Agent' || tc.name.startsWith('Agent #')) && tc.children && tc.children.length > 0) {
    // Running Agent: show elapsed since first child started
    durationSecs = (Date.now() - tc.children[0].startTime) / 1000;
  }

  let timeStr = '';
  if (durationSecs != null) {
    timeStr = durationSecs < 60 ? `${durationSecs.toFixed(1)}s` : `${Math.floor(durationSecs / 60)}:${Math.round(durationSecs % 60).toString().padStart(2, '0')}`;
  }
  const statusText = tc.status === 'running' ? '执行中...' : timeStr;

  let inputSummary = '';
  if (tc.input) {
    const truncated = tc.input.length > 80 ? tc.input.slice(0, 80) + '...' : tc.input;
    inputSummary = ` ${truncated}`;
  }

  return `${statusIcon} ${emoji} **${tc.name}** ${statusText ? `(${statusText})` : ''}${inputSummary}`;
}

/**
 * Format tool calls summary for the completed card's collapsed panel.
 */
function formatToolCallsSummary(toolCalls: ToolCallInfo[]): string {
  const lines: string[] = [];
  for (const tc of toolCalls) {
    lines.push(`- ${formatSingleTool(tc)}`);
    if (tc.children && tc.children.length > 0) {
      if (tc.children.length > 1) {
        const elapsed = (tc.children[tc.children.length - 1].endTime || Date.now()) - tc.children[0].startTime;
        const totalSecs = Math.round(elapsed / 1000);
        const timeStr = totalSecs < 60 ? `${totalSecs}s` : `${Math.floor(totalSecs / 60)}:${(totalSecs % 60).toString().padStart(2, '0')}`;
        lines.push(`   - ... ${tc.children.length - 1} 条已折叠 · 总用时 ${timeStr}`);
      }
      const last = tc.children[tc.children.length - 1];
      lines.push(`   - ${formatSingleTool(last)}`);
    }
  }
  return lines.join('\n');
}
