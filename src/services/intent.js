/**
 * Local intent classification service.
 *
 * Regex-based pre-classifier for non-support messages (greetings, thanks,
 * goodbye, acknowledgments, off-topic, gibberish, etc.). Runs entirely
 * locally — no LLM calls — to give instant responses for trivial messages
 * and reduce unnecessary n8n / LLM traffic.
 *
 * Returns { matched: true, category, response } if intercepted,
 * or { matched: false } to let the message continue to n8n.
 */

const config = require('../config');

// ── Common words set (for gibberish detection) ───────────────────────────────
const COMMON_WORDS = new Set([
  // determiners / pronouns / auxiliaries
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'may', 'might', 'can', 'could',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'ours', 'theirs',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
  'and', 'but', 'or', 'nor', 'not', 'no', 'yes', 'so', 'if', 'then', 'than', 'as',
  'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with', 'up', 'out',
  'about', 'after', 'before', 'between', 'through', 'during', 'above', 'below',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'very', 'just', 'also', 'now', 'here', 'there', 'when',
  'where', 'how', 'why', 'too', 'again', 'once', 'please', 'try', 'go', 'get',
  // common verbs
  'make', 'take', 'come', 'see', 'know', 'think', 'look', 'want', 'give', 'use',
  'find', 'tell', 'ask', 'work', 'call', 'need', 'feel', 'become', 'leave', 'put',
  'mean', 'keep', 'let', 'begin', 'seem', 'help', 'show', 'hear', 'play', 'run',
  'move', 'like', 'live', 'believe', 'hold', 'bring', 'happen', 'write', 'provide',
  'sit', 'stand', 'lose', 'pay', 'meet', 'include', 'continue', 'set', 'learn',
  'change', 'lead', 'understand', 'watch', 'follow', 'stop', 'create', 'speak',
  'read', 'allow', 'add', 'spend', 'grow', 'open', 'walk', 'win', 'offer', 'remember',
  'love', 'consider', 'appear', 'buy', 'wait', 'serve', 'die', 'send', 'expect',
  'build', 'stay', 'fall', 'cut', 'reach', 'kill', 'remain', 'suggest', 'raise',
  'pass', 'sell', 'require', 'report', 'decide', 'pull', 'check', 'clear', 'cache',
  'close', 'closed', 'closing', 'assign', 'assigned', 'handle', 'handled',
  'forward', 'forwarded', 'forwarding', 'transfer', 'transferred',
  'respond', 'responded', 'responding', 'notify', 'notified',
  'confirm', 'confirmed', 'confirmation', 'acknowledge', 'acknowledged',
  'investigate', 'investigating', 'investigation', 'review', 'reviewed', 'reviewing',
  'process', 'processed', 'processing', 'complete', 'completed', 'completing',
  'approve', 'approved', 'reject', 'rejected', 'verify', 'verified', 'verifying',
  'submit', 'submitted', 'submitting', 'receive', 'received',
  // support / business domain
  'cookies', 'browser', 'refresh', 'update', 'updated', 'reset', 'error', 'issue', 'issues',
  'problem', 'problems', 'ticket', 'tickets', 'support', 'team', 'account', 'login',
  'password', 'page', 'system', 'server', 'status', 'loan', 'loans', 'payment', 'payments',
  'repayment', 'repayments', 'bank', 'amount', 'balance',
  'escalation', 'escalated', 'escalate', 'escalating',
  'resolution', 'resolve', 'resolved', 'resolving',
  'reply', 'replied', 'response', 'request', 'requested', 'requesting',
  'fix', 'fixed', 'fixing', 'working', 'still', 'already', 'pending', 'failed', 'done',
  'correct', 'incorrect', 'wrong', 'right', 'good', 'bad', 'new', 'old', 'newest', 'latest',
  'looking', 'checking', 'noted', 'please', 'kindly', 'regards',
  'soon', 'shortly', 'immediately', 'asap', 'urgent', 'priority',
  'customer', 'user', 'client', 'agent', 'admin', 'manager',
  'document', 'documents', 'file', 'files', 'upload', 'uploaded', 'download',
  'access', 'accessed', 'permission', 'permissions', 'role', 'roles',
  'company', 'facility', 'tranche', 'disbursement', 'kyc', 'ckyc', 'cibil',
  'pan', 'aadhaar', 'gstin', 'cin', 'otp', 'signatory',
  'application', 'applied', 'progress', 'step', 'steps', 'stage',
  'information', 'info', 'detail', 'details', 'data', 'record', 'records',
  'message', 'messages', 'notification', 'notifications',
  // greetings / closings
  'ok', 'okay', 'sure', 'thanks', 'thank', 'sorry', 'hello', 'hi', 'hey',
  'glad', 'happy', 'great', 'fine', 'nice', 'welcome', 'apologies', 'apologize',
  'further', 'additional', 'another', 'anything', 'everything', 'something', 'nothing',
  'able', 'unable', 'available', 'unavailable', 'possible', 'impossible',
  'today', 'tomorrow', 'yesterday', 'morning', 'evening', 'afternoon',
  'time', 'date', 'day', 'week', 'month', 'hours', 'minutes',
  'back', 'next', 'last', 'first', 'second', 'third',
  'try', 'tried', 'trying', 'test', 'tested', 'testing',
  'log', 'logged', 'logs', 'screenshot', 'screenshots', 'image', 'images',
  'link', 'url', 'email', 'mail', 'phone', 'number', 'address',
  'share', 'shared', 'sharing', 'attach', 'attached', 'attachment',
  'concern', 'concerns', 'question', 'questions', 'query', 'queries',
]);

/**
 * Build the default bot capability message using branding config.
 */
function getBotCapabilityResponse() {
  if (config.branding.botCapabilityMessage) return config.branding.botCapabilityMessage;

  const name = config.branding.platformName;
  return `I am a support assistant for the ${name} platform. I can help you with:\n\n` +
    '• Loan queries and application status\n' +
    '• Repayment issues and payment failures\n' +
    '• Account access and login problems\n' +
    '• KYC and verification issues\n' +
    '• Facility and disbursement problems\n' +
    '• Document upload assistance\n' +
    '• Error code troubleshooting\n\n' +
    "Please describe the issue you're facing and I'll do my best to assist you!";
}

/**
 * Classify a user message into a local intent category.
 *
 * @param {string} text - Raw user message
 * @returns {{ matched: boolean, category?: string, response?: string }}
 */
function classifyLocalIntent(text) {
  if (!text || typeof text !== 'string') return { matched: false };

  const raw = text.toLowerCase().trim().replace(/[^a-z0-9\s']/g, '').replace(/\s+/g, ' ');
  // Collapse runs of 3+ identical chars (e.g. "hiiiii" → "hii")
  const msg = raw.replace(/(.)\1{2,}/g, '$1$1');

  // ── 1. GREETINGS ──
  const greetingPatterns = [
    /^h+e+l+o+$/, /^h+e+l+l+o+$/, /^h+i+$/, /^h+i+e*$/, /^h+e+y+$/,
    /^h+i+y+a*$/, /^y+o+$/, /^s+u+p+$/, /^h+o+w+d+y+$/,
    /^good\s*(morning|evening|afternoon|night|day)$/,
    /^(gm|gn|ge)$/, /^whats\s*up$/, /^wassup$/, /^wazzup$/,
    /^hola$/, /^greetings$/, /^namaste$/,
  ];
  for (const p of greetingPatterns) {
    if (p.test(msg)) {
      return { matched: true, category: 'greeting', response: 'Hello! How can I help you today?' };
    }
  }

  // ── 2. THANKS ──
  if (/^(thanks|thankyou|thank\s*you|thx|ty|tysm|thanx|thank\s*u|thnx)\s*[.!]*$/.test(msg)) {
    return { matched: true, category: 'thanks', response: "You're welcome! Let me know if you need anything else." };
  }

  // ── 3. GOODBYE ──
  if (/^(bye|goodbye|good\s*bye|see\s*you|see\s*ya|later|cya|ttyl|take\s*care)\s*[.!]*$/.test(msg)) {
    return { matched: true, category: 'goodbye', response: 'Goodbye! Feel free to reach out anytime.' };
  }

  // ── 4. SIMPLE ACKNOWLEDGMENTS ──
  if (/^(ok|okay|okk+|k+|kk+|cool|nice|great|awesome|perfect|alright|aight|got\s*it|noted|sure|fine|np|no\s*problem|no\s*worries)\s*[.!]*$/.test(msg)) {
    return { matched: true, category: 'acknowledgment', response: 'Alright! Let me know if there is anything else I can help with.' };
  }

  // ── 5. PERSONAL INTRODUCTIONS ──
  if (/^(my\s*name\s*is|im|i\s*am|this\s*is)\s+[a-z]+$/.test(msg) ||
      /^(im|i\s*am)\s+from\s+[a-z]+$/.test(msg)) {
    return { matched: true, category: 'introduction', response: 'Nice to meet you! How can I help you today?' };
  }

  // ── 6. BOT CAPABILITY QUESTIONS ──
  const capabilityPatterns = [
    /^what\s*(all\s*)?(can|do) you do$/,
    /^what\s*are\s*your\s*(capabilities|features|functions|skills)$/,
    /^what\s*are\s*you(\s*capable\s*of)?$/,
    /^who\s*are\s*you$/,
    /^are\s*you\s*(a\s*)?(bot|ai|human|real|chatbot|robot)$/,
    /^what\s*is\s*(this|this\s*chat|this\s*bot)(\s*for)?$/,
    /^how\s*(can|do)\s*you\s*help(\s*me)?$/,
    /^what\s*(services?|features?|help|things?)\s*(do|can)\s*you\s*(offer|provide|give|do)$/,
    /^what\s*kind\s*of\s*(help|support|issues?|problems?)\s*(can|do)\s*you\s*(help|handle|solve|support|assist)(\s*with)?$/,
    /^how\s*does\s*this\s*(work|bot\s*work|chat\s*work)$/,
    /^what\s*do\s*you\s*support$/,
    /^tell\s*me\s*(about\s*)?(yourself|what\s*you\s*do|your\s*capabilities)$/,
  ];
  for (const p of capabilityPatterns) {
    if (p.test(msg)) {
      return { matched: true, category: 'bot_capability', response: getBotCapabilityResponse() };
    }
  }

  // ── 7. NO-ISSUE / JUST BROWSING / DISMISSAL ──
  const noIssuePatterns = [
    /^i\s*don'?t\s*have\s*(a\s*|any\s*)?(issue|problem|error|complaint|question)s?$/,
    /^(i\s*don'?t\s*need\s*(any\s*)?help|no\s*help\s*needed)$/,
    /^(nothing|nope|no)\s*(i\s*)?(just\s*)?(wanted\s*to\s*talk|browsing|looking\s*around|checking)$/,
    /^i'?m?\s*just\s*(browsing|looking|checking|exploring|testing)$/,
    /^(i\s*don'?t\s*want\s*to\s*raise\s*(a\s*)?ticket)$/,
    /^(no\s*issues?|no\s*problems?|everything\s*(is\s*)?(fine|good|ok|okay|working))$/,
    /^what\s*if\s*i\s*don'?t\s*(want|need)\s*(any\s*)?(service|help|support)$/,
    /^i\s*don'?t\s*(want|need)\s*(any\s*)?(service|help|support|assistance)$/,
    /^there('?s?|\s*is)\s*nothing\s*(you|u)\s*(can|could)\s*(help|do|assist)\s*(me\s*)?(with)?$/,
    /^(you|u)\s*(can'?t|cannot|couldn'?t|won'?t)\s*(help|assist|do\s*anything\s*for)\s*(me|us)?$/,
    /^nothing\s*(you|u)\s*(can|could)\s*(help|do|assist)\s*(me\s*)?(with)?$/,
    /^(you|u)\s*(are|r)\s*(no|not)\s*(help|useful|use)$/,
    /^(nah|no|nope)\s*(there'?s?\s*)?(nothing|nah)\s*(you|u)?\s*(can)?\s*(help|do)?\s*(with)?$/,
    /^(i'?m?\s*(good|fine|okay|ok)|no\s*thanks|no\s*thank\s*you|all\s*good)\s*[.!]*$/,
  ];
  for (const p of noIssuePatterns) {
    if (p.test(msg)) {
      return {
        matched: true,
        category: 'no_issue',
        response: "No problem at all! If you ever run into any issues with the platform, feel free to come back and I'll be happy to help. Have a great day!",
      };
    }
  }

  // ── 8. OFF-TOPIC / CHITCHAT ──
  const offTopicPatterns = [
    /^(tell\s*me\s*a\s*joke|make\s*me\s*laugh)$/,
    /^what\s*is\s*the\s*meaning\s*of\s*life$/,
    /^(whats|what\s*is)\s*your\s*(name|age)$/,
    /^how\s*old\s*are\s*you$/,
    /^(can\s*we\s*be\s*friends|be\s*my\s*friend)$/,
    /^what\s*is\s*\d+\s*[\+\-\*\/x]\s*\d+$/,
    /^(do\s*you\s*have\s*feelings|are\s*you\s*alive|are\s*you\s*real)$/,
    /^(sing\s*(me\s*)?a\s*song|tell\s*me\s*a\s*story)$/,
    /^(who\s*made\s*you|who\s*created\s*you|who\s*built\s*you)$/,
    /^(whats\s*the\s*weather|hows\s*the\s*weather)$/,
    /^(i\s*love\s*you|do\s*you\s*love\s*me|i\s*like\s*you)$/,
    /^(lets\s*just\s*chat|lets\s*talk|can\s*you\s*chat)$/,
    /^(whos\s*the\s*president|what\s*year\s*is\s*it)$/,
    /^(play\s*a\s*game|lets\s*play)$/,
  ];
  for (const p of offTopicPatterns) {
    if (p.test(msg)) {
      const name = config.branding.platformName;
      return {
        matched: true,
        category: 'off_topic',
        response: `That's a fun question, but I'm designed specifically to help with support issues on the ${name} platform. If you have any technical issues, loan queries, or account problems, I'm here to help!`,
      };
    }
  }

  // ── 9. GIBBERISH (random chars, keyboard mash) ──
  const stripped = msg.replace(/[^a-z0-9]/g, '');
  const words = msg.split(/\s+/).filter(Boolean);

  if (stripped.length === 0 && text.trim().length > 0) {
    return { matched: true, category: 'gibberish', response: "I couldn't understand that. Could you please rephrase your message? I'm here to help with any platform-related issues." };
  }
  if (stripped.length > 2 && /^([a-z])\1{2,}$|^[^aeiou]{5,}$|^(.{1,2})\2{2,}$/i.test(stripped)) {
    return { matched: true, category: 'gibberish', response: "I couldn't understand that. Could you please rephrase your message? I'm here to help with any platform-related issues." };
  }
  if (words.length === 1 && stripped.length > 6 && !COMMON_WORDS.has(stripped)) {
    return { matched: true, category: 'gibberish', response: "I couldn't understand that. Could you please rephrase your message? I'm here to help with any platform-related issues." };
  }

  // ── 10. UNCLEAR / VAGUE (very short fragments) ──
  const unclearExact = new Set([
    'help', 'issue', 'problem', 'check this', 'its not', 'i cant',
    'where is', 'what about', 'i need', 'how do i', 'is there',
    'my thing', 'the thing', 'i want to', 'please do',
  ]);
  if (unclearExact.has(msg)) {
    return {
      matched: true,
      category: 'unclear',
      response: "Could you please provide a bit more detail about what you need help with? For example, you can describe the error you're seeing, the page you're on, or the action you were trying to perform.",
    };
  }

  // Not intercepted — let n8n handle
  return { matched: false };
}

/**
 * Check if a user message is an escalation / support contact request.
 * @param {string} text
 * @returns {boolean}
 */
function isEscalationRequest(text) {
  if (!text) return false;
  const msg = text.toLowerCase().trim().replace(/[^a-z0-9\s']/g, '').replace(/\s+/g, ' ');
  const patterns = [
    /\bcontact\s*support\b/,
    /\bconnect\s*(me\s*)?to\s*support\b/,
    /\bhuman\s*(support|agent)\b/,
    /\btalk\s*to\s*(support|agent|human|someone|a\s*person)\b/,
    /\brepresentative\b/,
    /\breal\s*person\b/,
    /\bcustomer\s*care\b/,
    /\bescalate\b/,
    /\braise\s*(a\s*)?ticket\b/,
    /\bcreate\s*(a\s*)?ticket\b/,
    /\bi\s*(want|need)\s*(a\s*)?ticket\b/,
    /\bfollow\s*up\s*(on\s*)?(my\s*)?(ticket|issue)\b/,
    /\braise\s*this\s*again\b/,
    /\bask\s*the\s*support\s*team\b/,
    /\bcheck\s*with\s*(the\s*)?support\b/,
    /\bi\s*(want|need)\s*to\s*contact\s*support\b/,
    /\bi\s*(want|need)\s*support\b/,
    /\bplease\s*(connect|contact|reach|escalate|follow)\b/,
  ];
  return patterns.some(p => p.test(msg));
}

/**
 * Check if user message is an acknowledgment / resolution confirmation.
 * @param {string} text
 * @returns {boolean}
 */
function isUserAcknowledgment(text) {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  const ackPatterns = [
    /^(thanks|thank\s*you|thx|ty|great|ok(ay)?|cool|got\s*it|alright|sure|noted|perfect|resolved|done|working\s*now|fixed|all\s*good|all\s*set)\s*[.!]*$/i,
    /^(that\s*(works|worked|helped|fixed\s*it))[.!]*$/i,
    /^(issue\s*(is\s*)?resolved|problem\s*(is\s*)?fixed|it'?s?\s*working\s*now)[.!]*$/i,
    /^(no\s*(more\s*)?issues?|looks?\s*good|seems?\s*(fine|good|ok))[.!]*$/i,
  ];
  return ackPatterns.some(p => p.test(normalized));
}

module.exports = {
  classifyLocalIntent,
  isEscalationRequest,
  isUserAcknowledgment,
  COMMON_WORDS,
};
