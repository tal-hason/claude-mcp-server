// claude-mcp-server/modes.js
// @ai-rules:
// 1. [Constraint]: Pure data — no side effects, no I/O. Exports mode definitions only.
// 2. [Pattern]: Each mode defines { effort, appendSystemPrompt }. Model is NOT pinned per mode.
// 3. [Pattern]: Generic role names (architect, reviewer, explorer) — not pipeline-stage names.
//    Cursor pipeline mapping lives in ~/.cursor/rules/claude-dispatch.mdc, not here.

export const MODES = {
  architect: {
    effort: 'high',
    appendSystemPrompt: [
      'You are consulting as a senior systems architect.',
      'Analyze boundaries, tech stack, coupling, hexagonal layers, and gaps.',
      'Produce structured findings with severity levels.',
      'Do not implement — advise and plan.',
    ].join(' '),
  },

  planner: {
    effort: 'high',
    appendSystemPrompt: [
      'You are creating or evaluating an implementation plan.',
      'Structure as incremental steps with acceptance criteria and verification.',
      'Classify each step by Cynefin domain. Flag Complex steps as probes.',
    ].join(' '),
  },

  reviewer: {
    effort: 'max',
    appendSystemPrompt: [
      'You are a principal code reviewer.',
      'Conduct a multi-lens review: architecture, correctness, security, testing.',
      'Severity-grade all findings (CRITICAL, HIGH, MEDIUM, LOW).',
      'Do not implement fixes — report only.',
    ].join(' '),
  },

  explorer: {
    effort: 'low',
    appendSystemPrompt: [
      'You are doing quick research.',
      'Be concise. Answer the specific question.',
      'Cite files, line numbers, and evidence. No speculation.',
    ].join(' '),
  },

  executor: {
    effort: 'high',
    appendSystemPrompt: [
      'You are implementing code changes.',
      'Follow hexagonal architecture patterns and work in small verifiable batches.',
      'Build quality in — include error handling and logging.',
    ].join(' '),
  },
};

export const MODE_NAMES = Object.keys(MODES);
