/**
 * Bedrock provider — wraps the existing bedrockService so the LLM facade can
 * hand back a normalized async iterable of text deltas regardless of which
 * underlying SDK is in use.
 *
 * This reuses the singleton BedrockClient (which handles STS / cross-account
 * role / credential refresh) so there's no duplicated AWS auth logic.
 */
const { bedrockClientInstance, generateResponse } = require('../bedrockService');

function create() {
  return {
    async generateResponse(messages) {
      return generateResponse(messages);
    },

    async *streamResponse(messages, options = {}) {
      const response = await bedrockClientInstance.createChatCompletion(messages, true);
      // Token usage arrives on the message_start (input) and message_delta
      // (output) events, and Bedrock repeats both on the final chunk's
      // amazon-bedrock-invocationMetrics. Reported once the stream ends.
      const usage = { input_tokens: 0, output_tokens: 0 };
      for await (const event of response.body) {
        if (!event.chunk || !event.chunk.bytes) continue;
        let data;
        try {
          data = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf-8'));
        } catch (err) {
          console.error('[bedrock] failed to parse stream chunk:', err.message);
          continue;
        }

        if (data.type === 'message_start' && data.message && data.message.usage) {
          usage.input_tokens = data.message.usage.input_tokens || usage.input_tokens;
        } else if (data.type === 'message_delta' && data.usage) {
          usage.output_tokens = data.usage.output_tokens || usage.output_tokens;
        }
        const metrics = data['amazon-bedrock-invocationMetrics'];
        if (metrics) {
          usage.input_tokens = metrics.inputTokenCount || usage.input_tokens;
          usage.output_tokens = metrics.outputTokenCount || usage.output_tokens;
        }

        if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
          yield data.delta.text;
        } else if (
          data.type === 'content_block_start' &&
          data.content_block &&
          data.content_block.type === 'text' &&
          data.content_block.text
        ) {
          yield data.content_block.text;
        }
      }
      if (typeof options.onUsage === 'function' && (usage.input_tokens || usage.output_tokens)) {
        try { options.onUsage(usage); } catch (_) { /* telemetry must never break the stream */ }
      }
    },
  };
}

module.exports = { create };
