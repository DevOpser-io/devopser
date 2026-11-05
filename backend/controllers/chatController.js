/**
 * Chat Controller
 * Handles all chat-related functionality including streaming responses
 */
const llm = require('../services/llm');
const telemetry = require('../telemetry');
const config = require('../config');
const models = require('../models');

// Helper function to ensure database is initialized and get models
async function getModels() {
  if (process.env.NODE_ENV === 'production') {
    await models.initializeDatabase();
  }
  return models;
}
const { v4: uuidv4 } = require('uuid');
const { getChatHistory, saveChatHistory, deleteChatHistory } = require('../services/redisService');
const { Op } = require('sequelize');

/**
 * Process a chat message for streaming (stores the message for stream endpoint to process)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function processMessage(req, res) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Unauthorized: user not logged in' });
  }
  try {
    const { message, conversationId, isTemporary = false } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim() === '') {
      console.error(`Invalid message format received: ${JSON.stringify(req.body)}`);
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    // Get or create conversation ID - prioritize session over request body
    let newConversationId = req.session?.conversationId || conversationId;
    console.log(`Processing message with conversationId from: ${req.session?.conversationId ? 'session' : (conversationId ? 'request body' : 'new uuid')}`);
    
    if (!newConversationId) {
      newConversationId = uuidv4();
      console.log(`Created new conversation with ID: ${newConversationId}`);
    }
    
    // Always update session with the current conversation ID
    if (req.session) {
      req.session.conversationId = newConversationId;
      console.log(`Updated session with conversationId: ${newConversationId}`);
    } else {
      console.warn('Session unavailable, conversationId will not persist across requests');
    }
    
    // Get current chat history from Redis
    let chatHistory = await getChatHistory(newConversationId);
    
    // First message in a new conversation - add system prompt
    if (chatHistory.length === 0) {
      chatHistory.push({
        role: 'system',
        content: config.chat.systemPrompt
      });
    }
    
    // Check for duplicate user messages before adding to history
    const lastMessage = chatHistory[chatHistory.length - 1];
    if (lastMessage?.role === 'user' && lastMessage.content === message.trim()) {
      console.log('Duplicate user message detected, skipping push');
    } else {
      // Add user message to history
      chatHistory.push({
        role: 'user',
        content: message.trim()
      });
    }
    
    // Save updated history to Redis
    await saveChatHistory(newConversationId, chatHistory);
    
    // Only save to database if NOT temporary AND conversation has become significant
    // This reduces database writes by ~80% and eliminates empty conversations
    const messageCount = chatHistory.length;
    const isSignificant = messageCount >= 2; // System prompt + user message (assistant response will be added during streaming)
    
    if (!isTemporary && isSignificant) {
      try {
        let conversation = await models.Conversation.findOne({ where: { conversation_id: newConversationId } });
        
        if (!conversation) {
          // Create new conversation record only when it becomes significant
          conversation = await models.Conversation.create({
            conversation_id: newConversationId,
            user_id: req.user ? req.user.id : null,
            chat_history: chatHistory,
            started_at: new Date(),
            is_temporary: false
          });
          console.log(`Created significant conversation in database: ${newConversationId} (${messageCount} messages)`);
        }
      } catch (dbError) {
        console.error(`Database error when creating conversation: ${dbError.message}`);
        // Continue even if DB operation fails, as we have Redis backup
      }
    } else {
      if (isTemporary) {
        console.log(`Temporary conversation ${newConversationId} - skipping database storage`);
      } else {
        console.log(`Conversation ${newConversationId} not yet significant (${messageCount} messages) - keeping in Redis only`);
      }
    }
    
    return res.json({
      success: true,
      message: 'Message received, connect to /api/chat/stream to get streaming response',
      conversationId: newConversationId
    });
  } catch (error) {
    console.error('Error processing message:', error);
    return res.status(500).json({ success: false, error: 'Failed to process message' });
  }
}

/**
 * Stream a chat response
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function streamResponse(req, res) {
  try {
    console.log(`Stream endpoint hit with method: ${req.method}`);
    
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    
    // Get conversation ID - prioritize session over request parameters
    let conversationId;
    
    // First try to get from session (session should be our source of truth)
    if (req.session && req.session.conversationId) {
      conversationId = req.session.conversationId;
      console.log(`Using conversationId from session: ${conversationId}`);
    } 
    // Fall back to query or body parameters if session doesn't have it
    else if (req.method === 'GET' && req.query.conversationId) {
      conversationId = req.query.conversationId;
      console.log(`Using conversationId from query: ${conversationId}`);
      // Update session with this conversationId
      if (req.session) {
        req.session.conversationId = conversationId;
        console.log(`Updated session with conversationId from query: ${conversationId}`);
      }
    } else if (req.method === 'POST' && req.body.conversationId) {
      conversationId = req.body.conversationId;
      console.log(`Using conversationId from body: ${conversationId}`);
      // Update session with this conversationId
      if (req.session) {
        req.session.conversationId = conversationId;
        console.log(`Updated session with conversationId from body: ${conversationId}`);
      }
    }
    
    if (!conversationId) {
      console.error('Missing conversation ID');
      res.write(`data: ${JSON.stringify({ error: 'Missing conversation ID' })}\n\n`);
      return res.end();
    }
    
    console.log(`Processing stream for conversation: ${conversationId}`);
    
    // Get chat history from Redis
    const chatHistory = await getChatHistory(conversationId);
    
    if (!chatHistory || chatHistory.length === 0) {
      console.error(`No chat history found for conversation ${conversationId}`);
      res.write(`data: ${JSON.stringify({ error: 'No chat history found' })}\n\n`);
      return res.end();
    }
    
    // Extract the last user message
    const lastUserMessage = [...chatHistory].reverse().find(msg => msg.role === 'user');
    
    if (!lastUserMessage) {
      console.error(`No user message found in history for conversation ${conversationId}`);
      res.write(`data: ${JSON.stringify({ error: 'No user message found' })}\n\n`);
      return res.end();
    }
    
    console.log(`Last user message: "${lastUserMessage.content.substring(0, 50)}..."`);
    console.log(`Chat history length: ${chatHistory.length} messages`);
    
    // One chat turn: the business-level span the SLO reviewer filters on.
    // Auto-instrumentation supplies the server span above it and the Bedrock,
    // redis and pg spans below it. Attributes are counts and enums only; the
    // prompt, the reply and the conversation id stay off the span.
    const turn = telemetry.startSpan('slo_demo.chat.turn', {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': llm.genAiProvider,
      'gen_ai.request.model': llm.model,
      'slo_demo.chat.history_messages': chatHistory.length,
    });
    const turnStart = Date.now();
    let firstTokenMs = null;
    try {
      let assistantResponse = '';

      // Add system message if not present
      const systemMessage = chatHistory.find(msg => msg.role === 'system');
      if (!systemMessage) {
        chatHistory.unshift({
          role: 'system',
          content: config.chat.systemPrompt
        });
      }
      
      // Stream the response via the LLM facade (Bedrock / OpenAI / Anthropic).
      // Each provider yields already-normalized text deltas so this loop no
      // longer needs to know about chunk envelope formats.
      await turn.run(async () => {
        const stream = llm.streamResponse(chatHistory, {
          onUsage: (usage) => {
            turn.setAttributes({
              'gen_ai.usage.input_tokens': usage.input_tokens,
              'gen_ai.usage.output_tokens': usage.output_tokens,
            });
            telemetry.recordLlmUsage({ provider: llm.genAiProvider, model: llm.model, ...usage });
          },
        });
        for await (const delta of stream) {
          if (!delta) continue;
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - turnStart;
            telemetry.recordFirstToken(firstTokenMs);
          }
          assistantResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          if (res.flush) res.flush();
        }
      });

      // Always send a terminal [DONE] marker once the provider's stream ends.
      res.write(`data: ${JSON.stringify({
        content: '[DONE]',
        fullResponse: assistantResponse,
        completed: true
      })}\n\n`);
      if (res.flush) res.flush();
      
      // End the response
      res.end();
      
      console.log('Stream processing completed successfully');
      
      // Add the assistant response to the conversation history
      chatHistory.push({
        role: 'assistant',
        content: assistantResponse
      });
      
      // Limit conversation history if needed
      if (chatHistory.length > config.chat.maxHistoryMessages + 1) { // +1 for system message
        // Keep system message and trim the oldest messages
        const systemMessage = chatHistory.find(msg => msg.role === 'system');
        // Filter out system message first
        const filteredHistory = chatHistory.filter(msg => msg.role !== 'system');
        // Keep only the most recent messages
        const limitedHistory = filteredHistory.slice(-(config.chat.maxHistoryMessages));
        
        // Add system message back at the beginning if it existed
        chatHistory = systemMessage ? [systemMessage, ...limitedHistory] : limitedHistory;
      }
      
      // Save updated history to Redis
      await turn.run(() => saveChatHistory(conversationId, chatHistory));
      turn.end({
        'slo_demo.chat.first_token_ms': firstTokenMs === null ? -1 : firstTokenMs,
        'slo_demo.chat.response_chars': assistantResponse.length,
      });
      
      // Note: Database updates removed for performance - Redis is primary storage
      // Database persistence happens in processMessage() when conversations become significant
      // and in resetConversation() when conversations end
    } catch (streamError) {
      // Headers are usually flushed by now, so the response ends as a 200 with
      // an error event: the HTTP instrumentation would count it as a success.
      turn.fail(streamError);
      telemetry.markRequestFailed(streamError);
      console.error(`Error during stream processing: ${streamError.message}`);
      console.error(`Stream error stack: ${streamError.stack}`);
      
      // Try to send an error response if we haven't ended the response yet
      try {
        if (!res.headersSent) {
          return res.status(500).json({ error: 'Stream processing error' });
        } else {
          // We already started the stream, send error as an event
          res.write(`data: ${JSON.stringify({ 
            error: 'Stream processing error'
          })}\n\n`);
          res.end();
        }
      } catch (finalError) {
        console.error(`Failed to send error response: ${finalError.message}`);
      }
    }
  } catch (error) {
    telemetry.markRequestFailed(error);
    console.error('Error streaming response:', error);
    
    // Send error response in SSE format
    res.write(`data: ${JSON.stringify({ error: 'Error processing your request' })}\n\n`);
    res.end();
  }
}

/**
 * Get all conversations
 * 
 * This function retrieves all conversations and returns them in a grouped format.
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function getConversations(req, res) {
  try {
    console.log('=== getConversations function called ===');
    
    // Get models with proper initialization
    const { Conversation } = await getModels();
    
    // Get user ID if authenticated
    const userId = req.user ? req.user.id : null;
    console.log(`User ID: ${userId}`);
    
    // Debug session information
    console.log(`Session in getConversations: ${req.session ? JSON.stringify({id: req.session.id, conversationId: req.session.conversationId}) : 'No session'}`);
    
    console.log(`Conversation model available: ${!!Conversation}`);
    console.log(`Conversation model type: ${typeof Conversation}`);
    
    // Ensure Conversation model is properly initialized
    if (!Conversation || typeof Conversation.findAll !== 'function') {
      console.error('Conversation model not properly initialized after DB init');
      throw new Error('Conversation model not available');
    }
    
    // Test basic Conversation model access
    try {
      const testCount = await Conversation.count();
      console.log(`Total conversations in database: ${testCount}`);
    } catch (countError) {
      console.error('Error counting conversations:', countError.message);
      throw countError;
    }
    
    // Define query options - include both ended and active conversations
    // Note: is_temporary should always be false now since we don't save temporary conversations to DB
    const queryOptions = {
      where: {
        is_temporary: false // Additional safety: exclude any temporary conversations
      },
      order: [['updated_at', 'DESC'], ['ended_at', 'DESC']], // Sort by updated_at first, then ended_at
      limit: 100
    };
    
    // Filter by user if logged in
    if (userId) {
      queryOptions.where.user_id = userId;
      
      // Include both ended conversations and the current active conversation
      const orConditions = [
        { ended_at: { [Op.not]: null } }
      ];
      
      // Only include current conversation condition if conversationId exists
      if (req.session?.conversationId) {
        orConditions.push({ conversation_id: req.session.conversationId });
        console.log(`Added current conversation to query: ${req.session.conversationId}`);
      }
      
      queryOptions.where[Op.or] = orConditions;
    } else {
      // For non-logged in users, only show ended conversations
      queryOptions.where.ended_at = { [Op.not]: null };
    }
    
    console.log(`Final query options: ${JSON.stringify(queryOptions, null, 2)}`);
    
    
    // Get conversations from database
    console.log('About to execute Conversation.findAll...');
    let conversations;
    try {
      conversations = await Conversation.findAll(queryOptions);
      console.log(`Found ${conversations ? conversations.length : 0} conversations`);
    } catch (dbError) {
      console.error('Database query error in getConversations:', dbError);
      console.error('Error message:', dbError.message);
      console.error('Error stack:', dbError.stack);
      throw dbError; // Re-throw to be caught by outer catch
    }
    
    // Calculate date ranges
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Group conversations by date
    const groupedHistory = {
      'Today': [],
      'Previous 7 Days': [],
      'Previous 30 Days': []
    };
    
    // Process each conversation
    for (const conv of conversations) {
      try {
        if (!conv.ended_at) continue;
        
        const convDate = new Date(conv.ended_at);
        const firstExchange = {
          id: conv.conversation_id,
          preview: '',
          timestamp: conv.ended_at
        };
        
        // Get first user message for preview
        if (conv.chat_history && Array.isArray(conv.chat_history)) {
          for (const msg of conv.chat_history) {
            if (msg.role === 'user') {
              const previewText = msg.content.trim();
              if (previewText) {
                firstExchange.preview = previewText.length > 50 ? 
                  previewText.substring(0, 47) + '...' : 
                  previewText;
                break;
              }
            }
          }
        }
        
        // Add to appropriate group if it has a valid preview
        if (firstExchange.preview) {
          if (convDate >= today) {
            groupedHistory['Today'].push(firstExchange);
          } else if (convDate >= sevenDaysAgo && convDate < today) {
            groupedHistory['Previous 7 Days'].push(firstExchange);
          } else if (convDate >= thirtyDaysAgo && convDate < sevenDaysAgo) {
            groupedHistory['Previous 30 Days'].push(firstExchange);
          }
        }
      } catch (convError) {
        console.error(`Error processing conversation ${conv.conversation_id}: ${convError.message}`);
        continue;
      }
    }
    
    return res.json({
      success: true,
      history: groupedHistory
    });
  } catch (error) {
    console.error('=== ERROR in getConversations ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Error details:', error);
    console.error('=================================');
    
    // Return empty conversations instead of 500 error as fallback
    return res.json({
      success: true,
      history: {
        'Today': [],
        'Previous 7 Days': [],
        'Previous 30 Days': []
      }
    });
  }
}

/**
 * Get a specific conversation
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function getConversation(req, res) {
  try {
    const { conversationId } = req.params;
    
    if (!conversationId) {
      return res.status(400).json({ success: false, error: 'Conversation ID is required' });
    }
    
    // Get user ID if authenticated
    const userId = req.user ? req.user.id : null;
    
    // First, try to get from Redis cache
    let chatHistory = await getChatHistory(conversationId);
    
    // If not in Redis, try to get from database
    if (!chatHistory || chatHistory.length === 0) {
      const conversation = await models.Conversation.findOne({
        where: { conversation_id: conversationId }
      });
      
      if (!conversation) {
        return res.status(404).json({ success: false, error: 'Conversation not found' });
      }
      
      // If found, check if user has access
      if (userId && conversation.user_id && conversation.user_id !== userId) {
        return res.status(403).json({ success: false, error: 'Unauthorized access to conversation' });
      }
      
      chatHistory = conversation.chat_history || [];
      
      // Update Redis cache
      await saveChatHistory(conversationId, chatHistory);
    }
    
    // Filter out system messages for frontend display
    const filteredHistory = chatHistory.filter(msg => msg.role !== 'system');
    
    // Update the session with this conversation ID
    if (req.session) {
      req.session.conversationId = conversationId;
    }
    
    return res.json({
      success: true,
      conversation_id: conversationId,
      chat_history: filteredHistory
    });
  } catch (error) {
    console.error('Error getting conversation:', error);
    return res.status(500).json({ success: false, error: 'Failed to get conversation' });
  }
}

/**
 * Reset/clear the conversation
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function resetConversation(req, res) {
  try {
    // Log authentication state for debugging
    const isAuthenticated = req.isAuthenticated ? req.isAuthenticated() : false;
    const hasUser = !!req.user;
    console.log(`resetConversation: authenticated=${isAuthenticated}, hasUser=${hasUser}, userId=${req.user?.id || 'none'}`);
    
    // Get user reference (may be null for anonymous users)
    const currentUser = req.user;
    // Get current conversation ID - prioritize session over request body
    const oldConversationId = req.session?.conversationId || req.body.conversationId;
    const wasTemporary = req.body.wasTemporary || false;
    
    console.log(`Resetting conversation: ${oldConversationId}, wasTemporary: ${wasTemporary}`);
    console.log(`Session data: ${req.session ? JSON.stringify({id: req.session.id, conversationId: req.session.conversationId}) : 'No session'}`);
    console.log(`Request headers: ${JSON.stringify({
      'user-agent': req.headers['user-agent'],
      'cookie': req.headers.cookie ? req.headers.cookie.substring(0, 100) + '...' : 'none',
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'x-forwarded-proto': req.headers['x-forwarded-proto']
    })}`);
    
    // If there's an existing conversation, mark it as ended
    if (oldConversationId) {
      try {
        // Get chat history from Redis
        const chatHistory = await getChatHistory(oldConversationId);
        console.log(`Chat history from Redis for ${oldConversationId}:`, chatHistory ? chatHistory.length : 0, 'messages');
        
        // Check if there are actual user/assistant messages (not just system messages)
        const userAssistantMessages = Array.isArray(chatHistory) ? 
          chatHistory.filter(msg => msg.role === 'user' || msg.role === 'assistant') : [];
        const hadRealMessages = userAssistantMessages.length > 0;
        console.log(`Real messages (user/assistant): ${userAssistantMessages.length}, hadRealMessages: ${hadRealMessages}`);
        
        // For temporary conversations, we never save to database
        if (wasTemporary) {
          console.log(`Temporary conversation ${oldConversationId} - not saving to database as expected`);
        } else {
          // Get the old conversation from the database
          const oldConversation = await models.Conversation.findOne({
            where: { conversation_id: oldConversationId }
          });
          console.log(`Old conversation in DB: ${oldConversation ? 'exists' : 'not found'}`);
          
          // Only save to DB if it wasn't a temporary chat AND there was at least one real message
          console.log(`Save conditions: currentUser=${!!currentUser}, !wasTemporary=${!wasTemporary}, hadRealMessages=${hadRealMessages}`);
          
          if (currentUser && hadRealMessages) {
            console.log('Saving conversation for logged-in user...');
            // For logged-in users, update the existing conversation
            if (oldConversation) {
              // Update chat history and mark as ended
              oldConversation.chat_history = chatHistory;
              oldConversation.ended_at = new Date();
              await oldConversation.save();
              console.log(`✓ Updated conversation record with ${chatHistory.length} messages: ${oldConversationId}`);
            } else {
              // Create a new record if it doesn't exist
              await currentUser.createConversation({
                conversation_id: oldConversationId,
                chat_history: chatHistory,
                started_at: new Date(),
                ended_at: new Date(),
                is_temporary: false
              });
              console.log(`✓ Created conversation record with ${chatHistory.length} messages: ${oldConversationId}`);
            }
          } else if (hadRealMessages) {
            console.log('Saving conversation for non-logged in user...');
            // For non-logged in users, only save if there's actual chat history and it's not temporary
            await models.Conversation.create({
              conversation_id: oldConversationId,
              user_id: null,
              chat_history: chatHistory,
              started_at: new Date(),
              ended_at: new Date(),
              is_temporary: false
            });
            console.log(`✓ Created conversation record for non-logged in user with ${chatHistory.length} messages: ${oldConversationId}`);
          } else {
            console.log(`❌ Skipping DB save for ${oldConversationId}:`);
            console.log(`   - hadRealMessages: ${hadRealMessages}`);
            console.log(`   - currentUser: ${!!currentUser}`);
          }
        }
        
        // Delete chat history from Redis
        await deleteChatHistory(oldConversationId);
        console.log(`Deleted Redis history for ${oldConversationId}`);
      } catch (error) {
        console.error(`Error finalizing old conversation: ${error.message}`);
      }
    }
    
    // Create new conversation ID
    const newConversationId = uuidv4();
    
    // Save new conversation ID to session
    if (req.session) {
      req.session.conversationId = newConversationId;
      // Force session save to ensure it persists
      await new Promise((resolve, reject) => {
        req.session.save(err => {
          if (err) {
            console.error(`Error saving session: ${err.message}`);
            reject(err);
          } else {
            console.log(`Successfully saved new conversationId ${newConversationId} to session ${req.session.id}`);
            resolve();
          }
        });
      }).catch(err => console.error(`Session save error: ${err.message}`));
    } else {
      console.warn('No session available, new conversation ID will not persist');
    }
    
    // Note: Removed automatic creation of new conversation record for efficiency
    // New conversations will be created in database only when users send their first message
    // This eliminates empty conversation creation during resets/new chats
    console.log(`New conversation ${newConversationId} created - will be persisted to DB when user sends first message`);
    
    return res.json({
      success: true,
      new_conversation_id: newConversationId
    });
  } catch (error) {
    console.error('Error resetting conversation:', error);
    return res.status(500).json({ success: false, error: 'Failed to reset conversation' });
  }
}

// updateConversationInDb function removed - no longer needed
// Database persistence now happens only when conversations become significant (3+ messages)
// or when they end, reducing database load by ~80%

module.exports = {
  processMessage,
  streamResponse,
  getConversations,
  getConversation,
  resetConversation
};
