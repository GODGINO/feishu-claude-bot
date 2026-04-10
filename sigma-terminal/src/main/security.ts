/**
 * Security rules — hard-coded deny patterns that cannot be overridden.
 * These protect against catastrophic commands.
 */

const HARD_DENY: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\s*[\/~]\s*$/,  // rm -rf / or ~
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\s*[\/~]\s*$/,  // rm -fr / or ~
  /\bmkfs\b/,                    // format disk
  />\s*\/dev\/sd/,               // write to disk device
  />\s*\/dev\/disk/,             // macOS disk device
  /\bdd\s+.*of=\/dev\//,        // dd to device
  /:(){ :\|:& };:/,             // fork bomb
];

export function checkSecurity(command: string): void {
  for (const rule of HARD_DENY) {
    if (rule.test(command)) {
      throw new Error(`Command blocked by security rule`);
    }
  }
}
