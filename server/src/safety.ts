// Safety classifier mirroring Claude Cowork's guardrail model.
//
// Three outcomes for any tool call:
//   - "allow"            : safe to run autonomously
//   - "deny"             : PROHIBITED — never run, return an error to the model
//   - "needs-permission" : explicit-permission action — pause and ask the user
//
// Prohibited actions (never allowed, even with user consent): banking/ID data,
// irreversible deletes, modifying permissions/ownership, investment advice,
// executing trades, system-file modification, account creation.
//
// Explicit-permission actions (need a one-off user approval each time): downloads,
// purchases, financial data, account settings, sharing, accepting terms, OAuth,
// publishing, sending messages, irreversible UI buttons (e.g. submit/confirm).

export type SafetyDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "needs-permission"; reason: string };

// ---- Bash destructive commands (always denied) ----
const BASH_DENY_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+\/(\s|$)/, // rm -rf /
  /\brm\s+-rf?\s+~(\s|$)/, // rm -rf ~
  /\bmkfs\b/, // mkfs
  /\bdd\s+.*of=\/dev\//, // dd to a device
  /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;:/, // fork bomb
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
];

// ---- Bash prohibited: banking/ID data, permissions, trades, system files ----
const BASH_PROHIBITED_PATTERNS: RegExp[] = [
  // Banking / ID / financial data access (match domain or app name)
  /(?:paypal|venmo|cashapp|coinbase|binance|kraken|metamask)\.(?:com|io|app)/i,
  /\b(?:bank|banking|well?s?fargo)\b/i,
  // Identity documents
  /(?:passport|ssn|social.security|national.id|drivers?.licen[sc]e)/i,
  // Modifying permissions / ownership of system paths (allow a mode argument)
  /\b(?:chmod|chown|chgrp)\s+(?:-[Rp]+\s+)*[\dDgostrwxu+=,]+\s+(?:-[Rp]+\s+)*(?:\/[a-z]*\/|(?:\/usr|\/etc|\/bin|\/sbin|\/boot|\/root|\/var)\b)/,
  /\b(?:chmod|chown|chgrp)\s+(?:-[Rp]+\s+)*(?:\/[a-z]*\/|(?:\/usr|\/etc|\/bin|\/sbin|\/boot|\/root|\/var)\b)/,
  // System file modification
  /(?:\/etc\/(?:passwd|shadow|sudoers)|\/boot\/)/,
  // Investment advice / trading execution
  /\b(?:robinhood|etrade|fidelity|schwab|interactive.brokers)\b/i,
  // Package/system installs that could be exfiltration vectors (require review)
  // (apt/yum system-wide; project-local installs are fine)
  /\b(?:apt-get|apt|yum|dnf|brew)\s+(?:install|remove|upgrade)\b/,
];

// ---- Bash needs-permission: network exfil, downloads, destructive-but-reversible ----
const BASH_PERMISSION_PATTERNS: RegExp[] = [
  // Network egress / downloads
  /\b(?:curl|wget|httpie)\b/i,
  // Sending data outbound
  /\b(?:scp|rsync|nc|netcat|socat)\b/,
  // Git push / publish
  /\bgit\s+push\b/,
  /\bnpm\s+publish\b/,
  /\b(?:pip|uv)\s+(?:install|upload)\b/,
  // Mass deletion (reversible only via trash/backups)
  /\brm\s+-rf?\b/,
  // Email / messaging clients
  /\b(?:sendmail|mail|mutt)\b/,
];

// ---- Browser/computer needs-permission patterns (URLs / text content) ----
const URL_PROHIBITED_PATTERNS: RegExp[] = [
  // Banking & financial institutions (match the domain anywhere in the URL)
  /(?:wellsfargo|chase\.com|bankofamerica|hsbc|barclays|paypal\.com|venmo\.com|wise\.com|cash\.app|cashapp)/i,
  // Trading / brokerage
  /(?:robinhood|etrade|fidelity|schwab|interactivebrokers|coinbase|binance|kraken)\.(com|io)/i,
  // Tax / government ID
  /(?:ssa\.gov|irs\.gov|dmv\.|uscis\.gov)/i,
];

const URL_PERMISSION_PATTERNS: RegExp[] = [
  // Checkout / payment flows
  /(?:checkout|payment|billing|pay\.|stripe\.com|\/pay\b)/i,
  // OAuth / account-login screens (accepting terms, granting access)
  /(?:accounts\.google|login\.|signin\.|oauth|\/auth\/|\/login\b)/i,
  // Social publishing / posting
  /(?:twitter\.com\/(compose|intent)|\/post\b|\/publish\b|\/share\b)/i,
  // Email / messaging send surfaces
  /(?:mail\.(google|yahoo)|\/mail\/.*compose|(web\.whatsapp|messages)|\/send\b)/i,
  // Account settings / security changes
  /\/settings\/(security|account|billing|password)/i,
];

// Sensitive UI element text (computer_click targets) needing permission.
const SENSITIVE_CLICK_TEXT: RegExp[] = [
  /\b(buy|purchase|checkout|pay now|place order|submit order|confirm payment)\b/i,
  /\b(delete account|close account|deactivate|permanently delete)\b/i,
  /\b(allow|grant|authorize|accept|agree|consent)\b/i, // OAuth/permissions prompts
  /\b(send|post|publish|submit|reply)\b/i,
  /\b(transfer|withdraw|deposit|sell|trade)\b/i, // financial actions
];

// Words in any tool input (e.g. create_file/create_docx content, memory) that
// look like secrets — deny exfiltrating them.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[a-zA-Z0-9]{20,})\b/, // OpenAI-style
  /\b(ghp_[a-zA-Z0-9]{20,})\b/, // GitHub PAT
  /\b(AKIA[0-9A-Z]{16})\b/, // AWS access key
  /\b([a-z0-9][a-z0-9._-]*:[a-zA-Z0-9_-]{30,})\b/, // user:token (heuristic)
];

/**
 * Classify a tool call. `toolName` is the Pi tool name; `input` is its arguments
 * object (e.g. { command } for bash, { url } for browser_navigate).
 */
export function classifyToolCall(toolName: string, input: Record<string, unknown> | undefined): SafetyDecision {
  const args = input ?? {};
  // 1. Never allow exfiltrating secrets via any tool.
  const blob = JSON.stringify(args);
  for (const re of SECRET_PATTERNS) {
    if (re.test(blob)) return { outcome: "deny", reason: "Refusing to write/send content that looks like a secret (API key/token). Remove it and retry." };
  }

  // 2. Bash classification.
  if (toolName === "bash" || toolName === "user_bash") {
    const command = String(args.command ?? "");
    for (const re of BASH_DENY_PATTERNS) {
      if (re.test(command)) return { outcome: "deny", reason: `Blocked destructive command: ${command}` };
    }
    for (const re of BASH_PROHIBITED_PATTERNS) {
      if (re.test(command)) return { outcome: "deny", reason: `Prohibited action (banking/ID/permissions/trades/system): ${command}` };
    }
    for (const re of BASH_PERMISSION_PATTERNS) {
      if (re.test(command)) return { outcome: "needs-permission", reason: `This command (${command.split(" ")[0]}) can make outbound changes; please confirm.` };
    }
    return { outcome: "allow" };
  }

  // 3. Browser / computer-use: URLs and click targets.
  const url = String(args.url ?? "");
  for (const re of URL_PROHIBITED_PATTERNS) {
    if (url && re.test(url)) return { outcome: "deny", reason: `Refusing to automate a banking/brokerage/ID site: ${url}` };
  }
  for (const re of URL_PERMISSION_PATTERNS) {
    if (url && re.test(url)) return { outcome: "needs-permission", reason: `This URL touches a sensitive flow (payment/login/publishing): ${url}` };
  }
  // computer_click may carry selector/text resembling sensitive actions.
  const clickText = [String(args.selector ?? ""), String(args.by === "text" ? args.selector ?? "" : "")].join(" ");
  for (const re of SENSITIVE_CLICK_TEXT) {
    if (clickText && re.test(clickText)) {
      return { outcome: "needs-permission", reason: `Clicking a sensitive UI element ("${String(args.selector ?? "").slice(0, 40)}"); please confirm.` };
    }
  }

  // 4. computer_type into password fields needs permission.
  if (toolName === "computer_type" && /password|passwd|secret|otp|2fa/i.test(JSON.stringify(args))) {
    return { outcome: "needs-permission", reason: "Typing into a password/credential field; please confirm." };
  }

  // 5. Default: allow read-only and creative tools (read, grep, write, edit,
  //    doc/memory/artifact creation, ask_question, todo_write, present_files, etc.)
  return { outcome: "allow" };
}

// ---- Legacy bash-only entrypoint (kept for existing tests) ----
export interface BashCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkBash(command: string): BashCheckResult {
  const d = classifyToolCall("bash", { command });
  if (d.outcome === "allow") return { allowed: true };
  return { allowed: false, reason: d.reason };
}
