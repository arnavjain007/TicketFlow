/**
 * Moderation service.
 *
 * Two-stage moderation pipeline for agent responses:
 * 1. Fast script-based check (profanity, rudeness, gibberish, caps)
 * 2. LLM fallback via Gemini when script flags issues
 *
 * Only agent/Teams messages go through moderation — bot-generated
 * responses from n8n are trusted and bypass this pipeline.
 */

const { COMMON_WORDS } = require('./intent');

// ── Profanity word list ──────────────────────────────────────────────────────
const PROFANITY_LIST = [
  'fuck', 'shit', 'damn', 'ass', 'bitch', 'bastard', 'crap', 'dick',
  'piss', 'hell', 'idiot', 'stupid', 'moron', 'dumb', 'retard',
  'wtf', 'stfu', 'lmao', 'lmfao', 'af', 'bs',
  'shut up', 'screw you', 'go to hell', 'piss off', 'f off',
  'useless', 'incompetent', 'pathetic', 'worthless', 'trash',
  'suck', 'sucks', 'cunt', 'twat', 'wanker', 'douche',
];

// ── Rudeness patterns ────────────────────────────────────────────────────────
const RUDENESS_PATTERNS = [
  /you('re| are)\s+(useless|stupid|dumb|incompetent|pathetic|worthless|an?\s+idiot)/i,
  /don'?t\s+waste\s+my\s+time/i,
  /i\s+don'?t\s+care\s+(about|what)/i,
  /figure\s+it\s+out\s+yourself/i,
  /not\s+my\s+(problem|job|concern)/i,
  /deal\s+with\s+it/i,
  /that'?s\s+your\s+(fault|problem)/i,
  /stop\s+(bothering|bugging|annoying)/i,
  /go\s+away/i,
  /leave\s+me\s+alone/i,
];

/**
 * Script-based moderation check (fast, no LLM).
 *
 * @param {string} text - The agent message to check
 * @returns {{ passed: boolean, issues: string[], cleanedText: string }}
 */
function scriptModerate(text) {
  const lower = text.toLowerCase();
  const issues = [];
  let cleanedText = text;

  // Check profanity
  for (const word of PROFANITY_LIST) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (regex.test(lower)) {
      issues.push(`profanity: "${word}"`);
      cleanedText = cleanedText.replace(regex, (match) => {
        if (match.length <= 2) return '*'.repeat(match.length);
        return match[0] + '*'.repeat(match.length - 2) + match[match.length - 1];
      });
    }
  }

  // Check rudeness patterns
  for (const pattern of RUDENESS_PATTERNS) {
    if (pattern.test(text)) {
      issues.push(`rudeness pattern: ${pattern.source}`);
    }
  }

  // Excessive caps (yelling) — >60% uppercase in messages >10 chars
  if (text.length > 10) {
    const alphaChars = text.replace(/[^a-zA-Z]/g, '');
    const upperChars = alphaChars.replace(/[^A-Z]/g, '');
    if (alphaChars.length > 5 && upperChars.length / alphaChars.length > 0.6) {
      issues.push('excessive caps (yelling)');
    }
  }

  // Gibberish detection
  const words = lower.replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 0);
  if (words.length > 0) {
    const recognizedCount = words.filter(w => COMMON_WORDS.has(w) || w.length <= 2).length;
    const recognizedRatio = recognizedCount / words.length;

    if (recognizedRatio < 0.25 && words.length <= 10) {
      issues.push('gibberish or nonsensical text');
    }
    if (words.length === 1 && words[0].length > 8 && !COMMON_WORDS.has(words[0])) {
      issues.push('gibberish or nonsensical text');
    }
  }

  // Very short responses
  if (text.trim().length < 3) {
    issues.push('response too short');
  }

  return { passed: issues.length === 0, issues, cleanedText };
}

module.exports = {
  scriptModerate,
  PROFANITY_LIST,
  RUDENESS_PATTERNS,
};
