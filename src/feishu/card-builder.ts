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
export function buildCompleteCard(text: string, toolCalls?: ToolCallInfo[], elapsed?: number, title?: string): object {
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
  const hidden = toolCalls.length - MAX_VISIBLE;
  const visible = hidden > 0 ? toolCalls.slice(-MAX_VISIBLE) : toolCalls;

  const lines: string[] = [];
  if (hidden > 0) {
    const elapsed = Date.now() - toolCalls[0].startTime;
    const totalSecs = Math.round(elapsed / 1000);
    const timeStr = totalSecs < 60 ? `${totalSecs}s` : `${Math.floor(totalSecs / 60)}:${(totalSecs % 60).toString().padStart(2, '0')}`;
    lines.push(`... ${hidden} 条已折叠，总用时 ${timeStr}`);
  }
  for (const tc of visible) {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    const duration = tc.endTime ? `${((tc.endTime - tc.startTime) / 1000).toFixed(1)}s` : '';
    const statusText = tc.status === 'running' ? '执行中...' : duration;

    let inputSummary = '';
    if (tc.input) {
      const truncated = tc.input.length > 80 ? tc.input.slice(0, 80) + '...' : tc.input;
      inputSummary = `\n   ${truncated}`;
    }

    lines.push(`${icon} **${tc.name}** ${statusText ? `(${statusText})` : ''}${inputSummary}`);
  }
  return lines.join('\n');
}

/**
 * Format tool calls summary for the completed card's collapsed panel.
 */
function formatToolCallsSummary(toolCalls: ToolCallInfo[]): string {
  return toolCalls.map(tc => {
    const icon = tc.status === 'complete' ? '✅' : '❌';
    const duration = tc.endTime ? `${((tc.endTime - tc.startTime) / 1000).toFixed(1)}s` : '?';

    let inputSummary = '';
    if (tc.input) {
      const truncated = tc.input.length > 100 ? tc.input.slice(0, 100) + '...' : tc.input;
      inputSummary = `\n   ${truncated}`;
    }

    return `${icon} **${tc.name}** (${duration})${inputSummary}`;
  }).join('\n');
}
