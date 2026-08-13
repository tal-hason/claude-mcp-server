// claude-mcp-server/stream-parser.js
// @ai-rules:
// 1. [Constraint]: Pure JSON parsing — no side effects, no state, no I/O.
// 2. [Pattern]: Ported from gemini-sidecar/stream-parser.js to ESM. Handles Claude --output-format stream-json.
// 3. [Gotcha]: Non-JSON input returns { text: line } (raw line as text); JSON parse errors caught, not thrown.

/**
 * Parse a single line from Claude CLI's --output-format stream-json.
 *
 * Claude stream-json schema:
 *   {"type":"system","subtype":"init","session_id":"...","tools":[...],"model":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","id":"...","input":{...}}]}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"result","subtype":"success","result":"...","duration_ms":...}
 *
 * Returns { text, sessionId, done } or null if not user-facing.
 */
export function parseStreamLine(line) {
  try {
    const obj = JSON.parse(line);

    if (obj.type === 'system' && obj.subtype === 'init') {
      return { text: null, sessionId: obj.session_id || null, done: false };
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      const parts = [];
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          const hint = block.input?.file_path || block.input?.command || block.input?.query || '';
          const suffix = hint ? `: ${String(hint).slice(0, 200)}` : '';
          parts.push(`[tool] ${block.name}${suffix}`);
        }
      }
      return { text: parts.join('\n') || null, sessionId: null, done: false };
    }

    if (obj.type === 'result') {
      const text = obj.result
        ? (typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result))
        : null;
      return { text, sessionId: null, done: true };
    }

    if (obj.type === 'error') {
      return { text: `[error] ${obj.message || JSON.stringify(obj)}`, sessionId: null, done: false };
    }
  } catch {
    return { text: line, sessionId: null, done: false };
  }
  return null;
}
