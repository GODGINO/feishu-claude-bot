/**
 * Security rules — hard-coded deny patterns that cannot be overridden.
 * Platform-aware: separate rule sets for macOS/Linux and Windows.
 */

// Unix deny rules
const HARD_DENY_UNIX: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\s*[\/~]\s*$/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\s*[\/~]\s*$/,
  /\bmkfs\b/,
  />\s*\/dev\/sd/,
  />\s*\/dev\/disk/,
  /\bdd\s+.*of=\/dev\//,
  /:(){ :\|:& };:/,
];

// Windows deny rules
const HARD_DENY_WIN: RegExp[] = [
  /\bformat\s+[a-zA-Z]:/i,                              // format C:
  /\brd\s+\/s\s+\/q\s+[a-zA-Z]:\\/i,                    // rd /s /q C:\
  /\bdel\s+\/f\s+\/s\s+\/q\s+[a-zA-Z]:\\/i,             // del /f /s /q C:\
  /\bRemove-Item\s+.*-Recurse.*-Force.*[a-zA-Z]:\\/i,    // Remove-Item -Recurse -Force C:\
  /\bRemove-Item\s+.*[a-zA-Z]:\\.*-Recurse.*-Force/i,    // alternate order
  /\bdiskpart/i,                                          // diskpart (disk management)
  /\bbcdedit/i,                                           // boot config
  /\breg\s+delete\s+HKLM/i,                              // registry nuke
];

export function checkSecurity(command: string): void {
  const rules = process.platform === 'win32' ? HARD_DENY_WIN : HARD_DENY_UNIX;
  for (const rule of rules) {
    if (rule.test(command)) {
      throw new Error(`Command blocked by security rule`);
    }
  }
}
