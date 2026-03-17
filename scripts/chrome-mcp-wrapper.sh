#!/bin/bash
# Wrapper script: starts chrome-devtools-mcp WITHOUT auto-launching Chrome.
# Chrome should be started on demand by Claude via start-chrome.sh.
# Usage: chrome-mcp-wrapper.sh <port> <user-data-dir> [extra mcp args...]

PORT="$1"
USER_DATA_DIR="$2"
shift 2

# Start the MCP server, connecting to our session's Chrome instance.
# --userDataDir ensures that if chrome-devtools-mcp auto-launches Chrome (fallback),
# it uses the session-isolated data directory instead of a shared default profile.
exec npx -y chrome-devtools-mcp@latest --browser-url="http://127.0.0.1:${PORT}" --userDataDir="${USER_DATA_DIR}" "$@"
