const SECRET_PATTERNS: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer', /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{24,}=*/g],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@\/]+:[^\s@\/]+@/gi],
  ['assignment', /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key|client[_-]?secret|auth)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi],
];

export interface RedactResult {
  text: string;
  redactions: string[];
}

export function redactSecrets(input: string): RedactResult {
  let text = input;
  const redactions: string[] = [];
  for (const [name, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, (...m: string[]) => {
      redactions.push(name);
      if (name === 'bearer') return `${m[1]}[REDACTED:${name}]`;
      if (name === 'url-credentials') return `${m[1]}[REDACTED]@`;
      if (name === 'assignment') return `${m[1]}[REDACTED]`;
      return `[REDACTED:${name}]`;
    });
  }
  return { text, redactions };
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ['override', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?|messages?)\b/i],
  ['role-hijack', /\b(you are now|from now on,? you (are|will|must)|new system prompt|act as (the )?system)\b/i],
  ['fake-tags', /<\/?\s*(system|assistant|developer|tool_call|function_call|instructions?)\s*>/i],
  ['exfiltrate', /\b(send|post|upload|exfiltrate|forward|leak)\b[^.\n]{0,60}\b(api[_ -]?keys?|passwords?|credentials?|secrets?|tokens?|ssh keys?|\.env)\b/i],
  ['hidden-action', /\b(do not|don't|never) (tell|inform|mention to|alert) the user\b/i],
  ['tool-coercion', /\b(always|must|immediately) (run|execute|call)\b[^.\n]{0,40}\b(curl|wget|bash|sh -c|rm -rf|powershell|eval)\b/i],
  ['zero-width', /[​-‏‪-‮⁠-⁤﻿]/],
];

export function scanInjection(text: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of INJECTION_PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(ssri|sertraline|fluoxetine|escitalopram|lexapro|zoloft|prozac|wellbutrin|adderall|vyvanse|ritalin|antidepressant|medication|prescription|diagnos(is|ed)|therapist|therapy session|psychiatrist)\b/i,
  /\b(adhd|ocd|depression|anxiety disorder|bipolar|ptsd|autism|eating disorder|panic attacks?)\b/i,
  /\b(hiv|std|sti|pregnan(t|cy)|miscarriage|abortion)\b/i,
  /\b(social security number|ssn|passport number|bank account|routing number|credit card)\b/i,
  /\b(sexual|sex life|intimate)\b/i,
];

export function looksSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/<\/?\s*(engram-memory|memory-context|system|assistant|developer)[^>]*>/gi, '')
    .replace(/\r/g, '');
}
