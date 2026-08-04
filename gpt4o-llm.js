const OpenAI = require('openai');
const config = require('./config');

const client = new OpenAI({ apiKey: config.openai.apiKey });

// ── STREAMING LLM CLIENT (GPT-4o-mini) ──────────────────────
// Async generator yielding, in order as they arrive on the wire:
//   { type: 'content', text }                      — spoken/written text tokens
//   { type: 'tool_call', id, name, arguments }      — a COMPLETE tool call
//                                                      (fragments are buffered
//                                                      internally and only
//                                                      yielded once whole)
//
// `signal` is a standard AbortSignal — abort() on it immediately stops
// pulling further chunks, which is the mechanism session-manager.js uses
// to cancel LLM generation on barge-in (see VOICE_PIPELINE_ARCHITECTURE.md §9).
async function* streamLLM({ messages, tools, signal }) {
  const stream = await client.chat.completions.create(
    {
      model: config.openai.llmModel,
      messages,
      max_tokens: config.openai.llmMaxTokens,
      tools,
      tool_choice: tools ? 'auto' : undefined,
      stream: true,
    },
    { signal }
  );

  const toolCallBuffers = new Map(); // index -> { id, name, arguments }

  for await (const part of stream) {
    if (signal?.aborted) return;

    const choice = part.choices?.[0];
    const delta = choice?.delta;
    if (!delta) continue;

    if (delta.content) {
      yield { type: 'content', text: delta.content };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallBuffers.has(idx)) toolCallBuffers.set(idx, { id: tc.id, name: '', arguments: '' });
        const buf = toolCallBuffers.get(idx);
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name += tc.function.name;
        if (tc.function?.arguments) buf.arguments += tc.function.arguments;
      }
    }

    if (choice?.finish_reason === 'tool_calls') {
      for (const buf of toolCallBuffers.values()) {
        let args = {};
        try { args = JSON.parse(buf.arguments || '{}'); } catch (_) {}
        yield { type: 'tool_call', id: buf.id, name: buf.name, arguments: args };
      }
      toolCallBuffers.clear();
    }
  }
}

module.exports = { streamLLM };
