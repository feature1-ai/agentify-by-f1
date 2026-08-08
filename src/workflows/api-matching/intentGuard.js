/**
 * Malicious-input screening for the intent classifier, two layers deep:
 *
 * 1. screenUserInput (here) — a cheap deterministic pre-screen that catches
 *    obvious prompt-injection / exfiltration phrasing BEFORE a codex run is
 *    spent, and still works if the model misjudges.
 * 2. The model's own assessment — APIMapper's combined prompt asks the agent
 *    to set intent.malicious, which the workflow treats the same way.
 *
 * Either layer flags → the workflow routes straight to a blocked response:
 * no parameter extraction, no approval request, no API calls.
 *
 * Deliberately NOT flagged here: legitimate destructive operations
 * ("delete pet 5"). Those are what riskLevel and the mandatory human
 * approval gate exist for.
 */
const RULES = [
  {
    pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/i,
    reason: 'prompt-injection phrasing (override instructions)'
  },
  {
    pattern: /(disregard|forget)\s+(your|the)\s+(rules|instructions|guidelines|system\s+prompt)/i,
    reason: 'prompt-injection phrasing (override instructions)'
  },
  {
    pattern: /(reveal|show|print|repeat|leak|dump)[\s\S]{0,40}(system\s+prompt|hidden\s+prompt|your\s+(instructions|prompt))/i,
    reason: 'attempt to extract the agent instructions'
  },
  {
    pattern: /\b(process\.env|printenv|\/etc\/passwd|id_rsa)\b/i,
    reason: 'attempt to access the server environment or filesystem'
  },
  {
    pattern: /\b(OPENAI_API_KEY|AUTH_HEADER_VALUE|API_KEY)\b/,
    reason: 'attempt to access server credentials'
  },
  {
    pattern: /(run|execute|spawn)[\s\S]{0,30}(shell|bash|terminal|command|child_process)|rm\s+-rf/i,
    reason: 'attempt to execute commands outside the API'
  }
];

/**
 * @returns {{ source: 'heuristic', reason: string } | null}
 */
export function screenUserInput(input) {
  const text = String(input ?? '');
  for (const { pattern, reason } of RULES) {
    if (pattern.test(text)) {
      return { source: 'heuristic', reason };
    }
  }
  return null;
}
