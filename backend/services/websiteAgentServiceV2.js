/**
 * FILE: backend/services/websiteAgentServiceV2.js
 * PURPOSE: AI agent that uses tools to modify website configurations
 * DESCRIPTION: Uses Claude's native tool use via Bedrock to make actual changes
 *              to site configurations through a tool-use loop.
 */

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const config = require('../config');
const telemetry = require('../telemetry');
const { WEBSITE_TOOLS, executeTool, getAgentSystemPrompt } = require('./websiteAgentTools');

// Bedrock client with cross-account support
let bedrockClient = null;
let credentialsExpiration = null;

/**
 * Assume an IAM role and get temporary credentials
 */
async function assumeRole(roleArn, sessionName = 'WebsiteAgentSession') {
  const stsClient = new STSClient({ region: config.aws.region });
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: 3600
  });

  const response = await stsClient.send(command);
  console.log('[AgentV2] AssumeRole successful, assumed ARN:', response.AssumedRoleUser.Arn);

  return {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
    expiration: response.Credentials.Expiration
  };
}

/**
 * Get or create Bedrock client with cross-account role assumption
 */
async function getBedrockClient() {
  const crossAccountRoleArn = config.aws.customerCrossAccountRoleArn;

  // Check if we need to refresh credentials (5 min before expiry)
  const needsRefresh = !bedrockClient ||
    (credentialsExpiration && new Date(credentialsExpiration) < new Date(Date.now() + 5 * 60 * 1000));

  if (needsRefresh) {
    if (crossAccountRoleArn && crossAccountRoleArn.trim() !== '') {
      console.log('[AgentV2] Assuming cross-account role:', crossAccountRoleArn);
      const credentials = await assumeRole(crossAccountRoleArn);
      credentialsExpiration = credentials.expiration;

      bedrockClient = new BedrockRuntimeClient({
        region: config.aws.region || 'us-east-1',
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken
        }
      });
      console.log('[AgentV2] Bedrock client created with cross-account credentials');
    } else {
      console.log('[AgentV2] Creating Bedrock client with default credentials');
      bedrockClient = new BedrockRuntimeClient({ region: config.aws.region || 'us-east-1' });
    }
  }

  return bedrockClient;
}

/**
 * Process a user message using the tool-use agent
 * @param {string} userMessage - The user's message
 * @param {Object} currentConfig - Current site configuration
 * @param {Array} conversationHistory - Previous messages
 * @returns {Promise<Object>} - { message, newConfig, toolsUsed }
 */
async function processWithToolsInner(userMessage, currentConfig, conversationHistory, span) {
  const client = await getBedrockClient();
  let workingConfig = currentConfig ? JSON.parse(JSON.stringify(currentConfig)) : null;
  const toolsUsed = [];
  const usage = { input: 0, output: 0 };
  let lastStopReason = null;

  // Build messages for Converse API
  const messages = [];

  // Add conversation history (last 10 messages)
  for (const msg of conversationHistory.slice(-10)) {
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: [{ text: msg.content }]
    });
  }

  // Add current user message
  messages.push({
    role: 'user',
    content: [{ text: userMessage }]
  });

  // Convert our tool definitions to Bedrock Converse format
  const toolConfig = {
    tools: WEBSITE_TOOLS.map(tool => ({
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          json: tool.input_schema
        }
      }
    }))
  };

  // System prompt
  const systemPrompt = [{ text: getAgentSystemPrompt(workingConfig) }];

  let maxIterations = 5; // Prevent infinite loops
  let iteration = 0;
  let finalResponse = '';

  while (iteration < maxIterations) {
    iteration++;
    console.log(`[AgentV2] Iteration ${iteration}, messages: ${messages.length}`);

    try {
      const response = await client.send(new ConverseCommand({
        modelId: config.bedrock.modelId,
        messages,
        system: systemPrompt,
        toolConfig,
        inferenceConfig: {
          maxTokens: config.bedrock.maxTokens || 4096,
          temperature: 0.7
        }
      }));

      if (response.usage) {
        usage.input += response.usage.inputTokens || 0;
        usage.output += response.usage.outputTokens || 0;
      }
      const output = response.output;
      const stopReason = response.stopReason;
      lastStopReason = stopReason;

      console.log(`[AgentV2] Stop reason: ${stopReason}`);

      // Check if Claude wants to use tools
      if (stopReason === 'tool_use') {
        // Find tool use blocks in the response
        const assistantContent = output.message?.content || [];
        const toolUseBlocks = assistantContent.filter(block => block.toolUse);
        const textBlocks = assistantContent.filter(block => block.text);

        // Add assistant's response to messages
        messages.push({
          role: 'assistant',
          content: assistantContent
        });

        // Execute each tool and collect results
        const toolResults = [];

        for (const block of toolUseBlocks) {
          const { toolUseId, name, input } = block.toolUse;
          console.log(`[AgentV2] Executing tool: ${name}`, JSON.stringify(input).substring(0, 200));

          // Execute the tool: one child span per call. The tool input is site
          // content, so it stays off the span; only the name, call id and
          // outcome are recorded.
          const toolSpan = telemetry.startSpan(`execute_tool ${name}`, {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': name,
            'gen_ai.tool.call.id': toolUseId,
          });
          const result = toolSpan.run(() => executeTool(name, input, workingConfig));
          toolSpan.end({ 'slo_demo.tool.success': !!result.success });
          toolsUsed.push({ name, input, result: result.message });

          // Update working config if tool succeeded
          if (result.success && result.config) {
            workingConfig = result.config;
          }

          // Add tool result
          toolResults.push({
            toolResultId: toolUseId,
            status: result.success ? 'success' : 'error',
            content: [{ text: result.message }]
          });
        }

        // Add tool results to messages
        messages.push({
          role: 'user',
          content: toolResults.map(r => ({
            toolResult: {
              toolUseId: r.toolResultId,
              status: r.status,
              content: r.content
            }
          }))
        });

        // Continue the loop to get Claude's follow-up
        continue;

      } else if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
        // Claude is done - extract the final text response
        const assistantContent = output.message?.content || [];
        for (const block of assistantContent) {
          if (block.text) {
            finalResponse += block.text;
          }
        }
        break;

      } else {
        // Unexpected stop reason
        console.warn(`[AgentV2] Unexpected stop reason: ${stopReason}`);
        break;
      }

    } catch (error) {
      console.error('[AgentV2] Error calling Bedrock:', error);
      throw error;
    }
  }

  // If no response generated, provide a default
  if (!finalResponse && toolsUsed.length > 0) {
    finalResponse = `Done! I made ${toolsUsed.length} change(s) to your website.`;
  } else if (!finalResponse) {
    finalResponse = "I'm not sure how to help with that. Try describing what kind of website you want, or ask me to make specific changes.";
  }

  span.setAttributes({
    'gen_ai.usage.input_tokens': usage.input,
    'gen_ai.usage.output_tokens': usage.output,
    'gen_ai.response.finish_reasons': [lastStopReason || 'none'],
    'slo_demo.site_agent.iterations': iteration,
    'slo_demo.site_agent.tool_calls': toolsUsed.length,
    'slo_demo.site_agent.produced_config': !!(workingConfig && workingConfig.sections && workingConfig.sections.length),
  });
  telemetry.recordLlmUsage({
    provider: 'aws.bedrock', model: config.bedrock.modelId,
    input_tokens: usage.input, output_tokens: usage.output,
  });

  return {
    message: finalResponse,
    newConfig: workingConfig,
    toolsUsed
  };
}

/**
 * One site-agent turn (the landing-page preview and the builder both come
 * through here): the business-level span around the Converse tool loop.
 * This service talks to Bedrock directly rather than through services/llm,
 * so it carries its own gen_ai.* attributes. The description and the
 * generated site content never go on the span.
 */
async function processWithTools(userMessage, currentConfig = null, conversationHistory = []) {
  return telemetry.withSpan('slo_demo.site_agent.turn', {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': 'website-agent',
    'gen_ai.provider.name': 'aws.bedrock',
    'gen_ai.request.model': config.bedrock.modelId,
    'slo_demo.site_agent.has_config': !!currentConfig,
    'slo_demo.site_agent.history_messages': conversationHistory.length,
  }, (span) => processWithToolsInner(userMessage, currentConfig, conversationHistory, span));
}

/**
 * Generate a site from a description (convenience wrapper)
 * @param {string} description - Site description
 * @returns {Promise<Object>} - { message, newConfig, toolsUsed }
 */
async function generateSiteFromDescription(description) {
  return processWithTools(description, null, []);
}

/**
 * Update site based on feedback
 * @param {Object} currentConfig - Current config
 * @param {string} feedback - User feedback
 * @param {Array} history - Conversation history
 * @returns {Promise<Object>} - { message, newConfig, toolsUsed }
 */
async function updateSiteFromFeedback(currentConfig, feedback, history = []) {
  return processWithTools(feedback, currentConfig, history);
}

module.exports = {
  processWithTools,
  generateSiteFromDescription,
  updateSiteFromFeedback
};
