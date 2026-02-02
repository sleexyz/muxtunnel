/**
 * Attention Detection for Claude Code prompts
 *
 * Detects when a tmux pane needs user attention based on common patterns
 * from Claude Code and other interactive CLI tools.
 */

export interface AttentionResult {
  needsAttention: boolean;
  reason?: string;
  matchedPattern?: string;
}

// Claude Code specific patterns
const CLAUDE_CODE_PATTERNS = [
  // Permission prompts with Allow/Deny
  /\bAllow\b.*\bDeny\b/i,
  /\bDeny\b.*\bAllow\b/i,

  // Question prompts (? indicator)
  /^\s*\?\s+/m,

  // Yes/No confirmations
  /\(y\/n\)/i,
  /\(yes\/no\)/i,
  /\[y\/N\]/i,
  /\[Y\/n\]/i,

  // Claude Code specific waiting indicators
  /waiting for your response/i,
  /press enter to continue/i,
  /choose an option/i,

  // Input prompts
  /Enter your (?:choice|response|input)/i,

  // Tool approval patterns
  /Allow this tool/i,
  /Approve this action/i,

  // Common CLI confirmation patterns
  /Are you sure\?/i,
  /Do you want to continue\?/i,
  /Proceed\?/i,
];

// Patterns that indicate the terminal is actively processing (not needing attention)
const PROCESSING_PATTERNS = [
  /^\s*\.\.\.\s*$/m,  // Progress dots
  /running\.\.\./i,
  /loading\.\.\./i,
  /building\.\.\./i,
  /installing\.\.\./i,
  /compiling\.\.\./i,
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,  // Spinner characters
];

/**
 * Detect if pane content suggests user attention is needed
 */
export function detectAttention(content: string): AttentionResult {
  // Check last ~20 lines for relevance (prompts are usually at the bottom)
  const lines = content.split("\n");
  const recentContent = lines.slice(-20).join("\n");

  // First check if something is actively processing
  for (const pattern of PROCESSING_PATTERNS) {
    if (pattern.test(recentContent)) {
      return { needsAttention: false, reason: "Processing in progress" };
    }
  }

  // Check for attention-needed patterns
  for (const pattern of CLAUDE_CODE_PATTERNS) {
    const match = recentContent.match(pattern);
    if (match) {
      return {
        needsAttention: true,
        reason: "Prompt detected",
        matchedPattern: match[0].trim(),
      };
    }
  }

  return { needsAttention: false };
}

/**
 * Check if the last line looks like an input prompt
 * (cursor waiting at end of a prompt-like line)
 */
export function isInputPrompt(content: string): boolean {
  const lines = content.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1] || "";

  // Common prompt endings
  const promptEndings = [
    /[>:?]\s*$/,      // Ends with >, :, or ?
    /\$\s*$/,          // Shell prompt
    />>>\s*$/,         // Python REPL
    /\.\.\.\s*$/,      // Continuation prompt
  ];

  return promptEndings.some(p => p.test(lastLine));
}

/**
 * Extract the most relevant prompt text for display
 */
export function extractPromptText(content: string): string | null {
  const lines = content.split("\n");
  const recentLines = lines.slice(-10);

  // Look for lines with question marks or obvious prompts
  for (let i = recentLines.length - 1; i >= 0; i--) {
    const line = recentLines[i].trim();
    if (line.length > 0 && (line.includes("?") || /Allow|Deny|y\/n/i.test(line))) {
      return line;
    }
  }

  return null;
}
