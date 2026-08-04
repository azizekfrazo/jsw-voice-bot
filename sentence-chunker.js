// ── SENTENCE-BOUNDARY CHUNKER ────────────────────────────────
// Consumes a stream of raw text tokens (from gpt4o-llm.js's 'content'
// events) and yields complete sentence(s) as soon as they're ready, so
// TTS can start on sentence 1 while the LLM is still generating sentence 2.
// The bot's system prompt already caps replies at ~2 short sentences for
// voice, so batching is intentionally light (emit as soon as ONE sentence
// completes) — see VOICE_PIPELINE_ARCHITECTURE.md §6.
async function* chunkForTTS(textStream, { maxBufferChars = 220 } = {}) {
  let buffer = '';
  // Include the Hindi danda (।) alongside standard Latin sentence enders
  // since replies may be in Hindi/Hinglish.
  const BOUNDARY = /([.!?।](?:\s|$))/;

  for await (const token of textStream) {
    buffer += token;

    let match;
    while ((match = buffer.match(BOUNDARY))) {
      const splitAt = match.index + match[0].length;
      yield buffer.slice(0, splitAt).trim();
      buffer = buffer.slice(splitAt);
    }

    // Safety valve: don't let one run-on clause (no punctuation) block TTS
    // indefinitely — cut at the last word boundary once buffer gets long.
    if (buffer.length > maxBufferChars) {
      const lastSpace = buffer.lastIndexOf(' ', maxBufferChars);
      const cut = lastSpace > 0 ? lastSpace : buffer.length;
      const piece = buffer.slice(0, cut).trim();
      if (piece) yield piece;
      buffer = buffer.slice(cut);
    }
  }

  if (buffer.trim()) yield buffer.trim();
}

module.exports = { chunkForTTS };
