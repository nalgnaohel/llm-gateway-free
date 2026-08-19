#!/bin/sh
# Launch Chrome with a remote-debugging port on a dedicated profile.
# Sign in to ChatGPT / Claude / Gemini once in THIS window; the client agent
# attaches to it over CDP and reuses those sessions.
#
# Chrome 136+ refuses --remote-debugging-port against the default profile, so a
# separate user-data-dir is mandatory, not a preference.
set -eu

PORT="${AIGW_CDP_PORT:-9222}"
PROFILE="${AIGW_CHROME_PROFILE:-$HOME/.ai-gateway-client/chrome-profile}"
START_URL="${AIGW_CHROME_URL:-https://chatgpt.com/}"
mkdir -p "$PROFILE"

BIN=""
for candidate in \
  "${CHROME_BIN:-}" \
  /usr/bin/google-chrome /usr/bin/google-chrome-stable \
  /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then BIN="$candidate"; break; fi
done

if [ -z "$BIN" ]; then
  echo "No Chrome found. Set CHROME_BIN=/path/to/chrome" >&2
  exit 1
fi

echo "Launching $BIN on debug port $PORT"
echo "  profile: $PROFILE"
echo "  sign in to your AI sites in this window; leave the tabs open."
exec "$BIN" \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "$START_URL"
