// Heuristic bash command safety check. Deny obviously destructive commands;
// everything else is allowed (with Phase 2 confirmation UI for sensitive ops).
const DENY_PATTERNS: RegExp[] = [
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

export interface BashCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkBash(command: string): BashCheckResult {
  for (const re of DENY_PATTERNS) {
    if (re.test(command))
      return { allowed: false, reason: `Blocked destructive command: ${command}` };
  }
  return { allowed: true };
}
