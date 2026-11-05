/**
 * LLM provider facade.
 *
 * Selects an implementation at startup based on LLM_PROVIDER and exposes a
 * normalized interface that the rest of the app can depend on regardless of
 * which backing model is in use:
 *
 *   generateResponse(messages)      -> Promise<string>
 *   streamResponse(messages)        -> AsyncIterable<string>   // yields text deltas
 *
 * Supported values for LLM_PROVIDER (case-insensitive):
 *   bedrock    (default) - AWS Bedrock (Claude via Amazon)
 *   openai               - OpenAI Chat Completions API
 *   anthropic            - Anthropic Claude API (direct, no AWS)
 *
 * To add another provider, create a new module that exports `create()`
 * returning { generateResponse, streamResponse } and wire it into the switch.
 */
const providerName = (process.env.LLM_PROVIDER || 'bedrock').toLowerCase();

let impl;
switch (providerName) {
  case 'openai':
    impl = require('./openaiProvider').create();
    break;
  case 'anthropic':
    impl = require('./anthropicProvider').create();
    break;
  case 'bedrock':
    impl = require('./bedrockProvider').create();
    break;
  default:
    console.warn(`[llm] Unknown LLM_PROVIDER="${providerName}", falling back to bedrock`);
    impl = require('./bedrockProvider').create();
}

console.log(`[llm] Active provider: ${providerName}`);

// Values for the gen_ai.* span attributes and the token metric, resolved
// once here so every call site reports the same provider and model names.
const GEN_AI_PROVIDER = { bedrock: 'aws.bedrock', openai: 'openai', anthropic: 'anthropic' };
function activeModel() {
  switch (providerName) {
    case 'openai': return process.env.OPENAI_MODEL || 'gpt-4o-mini';
    case 'anthropic': return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
    default: return require('../../config').bedrock.modelId;
  }
}

module.exports = {
  provider: providerName,
  genAiProvider: GEN_AI_PROVIDER[providerName] || 'aws.bedrock',
  model: activeModel(),
  generateResponse: (messages, options) => impl.generateResponse(messages, options),
  // options.onUsage({ input_tokens, output_tokens }) is called once the
  // stream ends, by providers that expose usage (Bedrock does).
  streamResponse: (messages, options) => impl.streamResponse(messages, options),
};
