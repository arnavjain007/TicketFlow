/**
 * LLM service — Gemini API integration.
 *
 * Centralizes all LLM calls (moderation, intent classification,
 * clarification generation) so that switching models or providers
 * only requires changes in this one file.
 */

const axios = require('axios');
const config = require('../config');

/**
 * Call Gemini's generateContent endpoint.
 *
 * @param {string} prompt - The full prompt text
 * @param {object} [options]
 * @param {number} [options.temperature=0.2]
 * @param {number} [options.maxOutputTokens=512]
 * @param {number} [options.timeout=15000]
 * @returns {Promise<string>} Raw text response from the model
 */
async function callGemini(prompt, { temperature = 0.2, maxOutputTokens = 512, timeout = 15000 } = {}) {
  if (!config.llm.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.llm.geminiModel}:generateContent?key=${config.llm.geminiApiKey}`;

  const response = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens },
  }, { timeout });

  const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return raw;
}

/**
 * Parse a JSON response from Gemini (strips markdown code fences).
 */
function parseJsonResponse(raw) {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

/**
 * LLM-based moderation check.
 * Tries to refine a flagged message into something appropriate.
 *
 * @param {string} originalText - The original agent message
 * @param {string[]} issues - Script-detected issues
 * @returns {Promise<{ appropriate: boolean, refinedText: string|null, reason: string }>}
 */
async function moderateWithLLM(originalText, issues) {
  const prompt = `You are a customer support response moderator.

A support agent has written a response to a customer. The automated script flagged these issues:
${issues.join(', ')}

Original agent message:
"${originalText}"

Your tasks:
1. Determine if the core message contains useful information for the customer (e.g. a resolution, update, instruction, or helpful answer).
2. If useful: rewrite the message in THIRD PERSON from the perspective of relaying what the support agent said. The rewritten message should sound like the system is conveying the agent's response, NOT like the AI assistant is personally speaking.
   - GOOD examples: "The support team has confirmed that the issue has been resolved.", "The support agent has shared the following update: ...", "The team has noted your concern and is looking into it."
   - BAD examples: "I'm glad to hear the issue has been resolved.", "Great! I'm happy to help.", "I've confirmed that..." — do NOT use first person (I, I'm, I've, we).
   - Keep the useful content intact. Remove any rude, offensive, or unprofessional language.
3. If not useful (e.g. just insults, no actual info): mark as not appropriate.

Return ONLY valid JSON:
{
  "appropriate": true/false,
  "refined_text": "rewritten third-person relay message" or null if not appropriate,
  "reason": "brief explanation of decision"
}`;

  try {
    const raw = await callGemini(prompt, { temperature: 0.2, maxOutputTokens: 512, timeout: 15000 });
    const result = parseJsonResponse(raw);
    return {
      appropriate: !!result.appropriate,
      refinedText: result.refined_text || null,
      reason: result.reason || '',
    };
  } catch (err) {
    console.error('❌ LLM moderation error:', err.message);
    return { appropriate: false, refinedText: null, reason: `LLM error: ${err.message}` };
  }
}

/**
 * LLM-based intent classifier for ticket follow-up messages.
 *
 * Uses fast-path regex for obvious cases, falls back to Gemini for ambiguous ones.
 * Returns one of: 'positive', 'negative', 'casual_ack', 'status_inquiry',
 *                 'off_topic', 'clarification', 'substantive'
 *
 * @param {string} text - User message
 * @param {string} [context='resolution_check'] - Conversation state context
 * @returns {Promise<string>} Intent label
 */
async function classifyTicketIntent(text, context = 'resolution_check') {
  const normalized = text.trim().toLowerCase();

  // ── Fast-path regex (covers clean/obvious cases) ──
  if (context === 'resolution_check') {
    if (/^(yes|yeah|yep|yup|ya|yaa+|resolved|done|fixed|it('?s)?\s*(working|fixed|resolved|good)|all\s*(good|set)|that\s*(works|worked|helped|fixed)|no\s*more\s*issues?|looks?\s*good)\s*[.!]*$/i.test(normalized)) return 'positive';
    if (/^(no+|nope|nah|na+h?|not?\s*really|negative|nuh[\s-]?uh)\s*[.!]*$/i.test(normalized)) return 'negative';
  }
  if (context === 'followup_details') {
    if (/^(no+|nope|nah|na+h?|not?\s*really|negative|nuh[\s-]?uh)\s*[.!]*$/i.test(normalized)) return 'negative';
  }
  if (context === 'waiting_for_agent') {
    const stripped = normalized.replace(/\b(baby|babe|babes|bby|bb|boo|dear|hun|honey|love|dude|bro|man|mate|fam|buddy|pal|thanks|thank\s*you|thankyou|thx|ty)\b/gi, '').trim();
    if (/^(ok(ay)?|okie+|okk+|k+|sure|alright|all\s*right|cool|got\s*it|noted|right|hmm+|oh+|ah+|i\s*see|understood|no\s*worries|no\s*problem|np|sounds?\s*good|fair\s*enough|great|fine|bet|aight|ight|roger|copy)\s*[.!,]*$/i.test(stripped)) return 'casual_ack';
    if (stripped.length === 0) return 'casual_ack';

    // Clarification / bot-reference
    if (/\b(wdym|what\s*(do|did|does)\s*(you|u|that|it|this)\s*mean|what\s*(are|r)\s*(you|u)\s*(saying|talking)|what\s*does\s*that\s*mean|what\s*(is|does)\s*that\s*(supposed\s*to\s*)?mean|i\s*don'?t\s*(understand|get\s*it)|explain\s*(that|this|what)|clarify|huh\??|makes?\s*no\s*sense|doesn'?t\s*make\s*sense)\b/i.test(normalized) ||
        /^(what|huh|wdym)\s*\??$/i.test(normalized) ||
        /\b(you|u)\s*(said|wrote|told|mentioned|typed|stated|just\s*said|literally\s*(said|wrote))\b/i.test(normalized) ||
        /\b(you\s*)?definitely\s*(said|wrote|told|mentioned|typed)\b/i.test(normalized) ||
        /\b(no+\s*)?you\s*(did|didn'?t)\s*(not\s*)?(say|write|mention|tell)\b/i.test(normalized) ||
        /\b(but\s*)?you\s*(just|literally|clearly)\s*(said|wrote|told)\b/i.test(normalized) ||
        /\bwhat\s*(did\s*)?you\s*(just\s*)?(say|write|mean|tell)\b/i.test(normalized) ||
        /\bi\s*(can\s*)?read\s*(what\s*)?(you|it)\s*(said|wrote)\b/i.test(normalized)) {
      return 'clarification';
    }

    // Ticket status inquiries
    if (/\b(ticket|issue|status|update|progress|eta|when|how\s*long|any\s*(update|news|response|reply)|where\s*(is|are)|what('?s|\s+is)\s*(the|my)?\s*(status|update|progress|ticket))\b/i.test(normalized) &&
        !/\b(new|different|another|also|additionally|separate)\b/i.test(normalized)) {
      return 'status_inquiry';
    }

    // Off-topic / casual conversation
    if (/^(how\s*(are|r)\s*(you|u|ya)|how('?re|\s*re)\s*(you|u|ya)|what('?re|\s*re)\s*(you|u|ya)\s*(doing|up\s*to)|what\s*(are|r)\s*(you|u|ya)\s*(doing|up\s*to)|what('?s|\s+is)\s*up|sup|wyd|hyd|how\s*do\s*you\s*do|what\s*do\s*you\s*do|who\s*(are|r)\s*(you|u)|tell\s*me\s*(about|a)\s*(yourself|joke|story)|how('?s|\s+is)\s*(it\s*going|life|your\s*day|everything)|good\s*(morning|afternoon|evening|night)|whats?\s*good)\s*[?!.]*$/i.test(normalized)) {
      return 'off_topic';
    }
  }

  // ── LLM fallback for ambiguous messages ──
  if (!config.llm.geminiApiKey) {
    console.warn('⚠️ GEMINI_API_KEY not set — falling back to substantive for ambiguous message');
    return 'substantive';
  }

  const contextDescriptions = {
    resolution_check: 'The user was asked "Did the support team\'s response resolve your issue?" Classify their reply.',
    followup_details: 'The user said their issue wasn\'t resolved and was asked to describe what\'s still wrong. Classify their reply.',
    waiting_for_agent: 'The user has an open support ticket and the team is working on it. Classify whether this message is just a casual acknowledgment or an actual follow-up with details.',
  };

  const prompt = `You are a customer support chat intent classifier.

Context: ${contextDescriptions[context] || contextDescriptions.resolution_check}

User message: "${text}"

Classify this message into EXACTLY one of these intents:
- "positive": The user is confirming the issue is resolved, or expressing agreement that things are working.
- "negative": The user is saying no / not resolved, but NOT providing any specific details about what's wrong.
- "casual_ack": The user is just casually acknowledging (e.g. "okay", "okie", "cool", "alright", "sure", "kk", "bet").
- "status_inquiry": The user is asking about their ticket status, waiting time, progress, or any update on their existing ticket.
- "off_topic": The user is making casual conversation unrelated to their support issue.
- "clarification": The user is asking about, referring to, or disagreeing with something the bot previously said.
- "substantive": The user is providing actual details about their issue, describing a NEW problem, or giving meaningful follow-up information.

IMPORTANT:
- Only classify as "substantive" if the message contains actual issue details or a new problem description.
- If the user is talking about what the BOT said/wrote/mentioned, classify as "clarification" NOT "substantive".

Return ONLY valid JSON: {"intent": "positive"|"negative"|"casual_ack"|"status_inquiry"|"off_topic"|"clarification"|"substantive"}`;

  try {
    const raw = await callGemini(prompt, { temperature: 0.0, maxOutputTokens: 64, timeout: 8000 });
    const result = parseJsonResponse(raw);
    const intent = result.intent;
    console.log(`🤖 LLM intent classification: "${text}" → ${intent} (context: ${context})`);

    const validIntents = ['positive', 'negative', 'casual_ack', 'status_inquiry', 'off_topic', 'clarification', 'substantive'];
    return validIntents.includes(intent) ? intent : 'substantive';
  } catch (err) {
    console.error('❌ LLM intent classification error:', err.message);
    return 'substantive'; // safe default
  }
}

/**
 * Generate a context-aware clarification response using LLM.
 *
 * @param {string} conversationId
 * @param {string} userText
 * @param {object} activeTicket
 * @param {object[]} recentMessages - Last ~8 messages from the conversation
 * @returns {Promise<string>} The clarification response text
 */
async function generateClarificationResponse(conversationId, userText, activeTicket, recentMessages) {
  const contextLines = recentMessages.map(m =>
    `${m.role === 'user' ? 'User' : 'Bot'}: ${m.message_text}`,
  ).join('\n');

  if (config.llm.geminiApiKey) {
    try {
      const prompt = `You are a helpful customer support chatbot. The user is responding to or asking about something you (the bot) previously said in the conversation.

Recent conversation:
${contextLines}

User's latest message: "${userText}"

The user has an open support ticket (${activeTicket.id}). They are waiting for the support team to respond.

Respond naturally and helpfully:
- Look at YOUR previous messages and figure out what the user is referring to.
- If the user says "you said X" or "you wrote X," acknowledge it and explain what you meant.
- Keep it concise, friendly, and clear (1-2 sentences max).
- Do NOT ask the user to describe their issue again.
- Do NOT say "Your follow-up has been shared with support" — they are talking to YOU about YOUR words.`;

      const text = await callGemini(prompt, { temperature: 0.3, maxOutputTokens: 150, timeout: 8000 });
      if (text.trim()) return text.trim();
    } catch (err) {
      console.error('❌ Clarification LLM error:', err.message);
    }
  }

  // Fallback: check if bot's last message mentioned a time reference
  const lastBotMsg = recentMessages.filter(m => m.role === 'assistant').pop();
  if (lastBotMsg && /\d+\s*(minute|hour|min)/i.test(lastBotMsg.message_text)) {
    return `When I mentioned the time, I was referring to how long your support ticket (${activeTicket.id}) has been open. The support team is still working on it — nothing to worry about!`;
  }
  return `I was providing an update on your support ticket (${activeTicket.id}). The support team is still working on your issue and I'll notify you as soon as they respond.`;
}

module.exports = {
  callGemini,
  parseJsonResponse,
  moderateWithLLM,
  classifyTicketIntent,
  generateClarificationResponse,
};
