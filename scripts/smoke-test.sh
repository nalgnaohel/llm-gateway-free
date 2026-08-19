#!/bin/sh
# Exercise a running gateway end to end: discovery, non-streaming, streaming,
# cache, error paths, persistence. Safe to re-run.
#
#   ./scripts/smoke-test.sh                       # defaults to cli/claude
#   MODEL=cli/opencode npm run smoke
#   BASE=http://127.0.0.1:8787 MODEL=web/chatgpt npm run smoke
#
# POSIX sh on purpose: no arrays, no pipefail, so `sh scripts/smoke-test.sh`
# works where /bin/sh is dash.
set -u

BASE="${BASE:-http://127.0.0.1:8787}"
MODEL="${MODEL:-cli/claude}"
KEY="${AIGW_API_KEY:-}"

# One wrapper instead of a bash array, so the optional auth header stays a
# single argument and never word-splits.
api() {
  if [ -n "$KEY" ]; then
    curl -H "Authorization: Bearer $KEY" "$@"
  else
    curl "$@"
  fi
}

hr() { printf '\n\033[1m-- %s --------------------------------\033[0m\n' "$*"; }
pretty() { python3 -m json.tool 2>/dev/null || cat; }

hr "1. health"
api -s "$BASE/health" | pretty

hr "2. models currently reachable"
api -s "$BASE/v1/models" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  (gateway not reachable)'); sys.exit(0)
if not d.get('data'): print('  (none - is a client agent connected?)')
for m in d.get('data', []): print('  %-24s %s' % (m['id'], m['aigw']['displayName']))
"

hr "3. non-streaming ($MODEL)"
api -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: SMOKE-OK\"}],\"cache\":false}" \
  | pretty

hr "4. streaming ($MODEL)"
api -sN "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Count from 1 to 5, one per line.\"}],\"stream\":true,\"cache\":false}"

hr "5. cache: same request twice"
BODY="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: CACHE-OK\"}]}"
first=$(api -s -D- -o /dev/null "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d "$BODY" | grep -i '^x-aigw-cache' | tr -d '\r')
second=$(api -s -D- -o /dev/null "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d "$BODY" | grep -i '^x-aigw-cache' | tr -d '\r')
echo "  first  -> $first"
echo "  second -> $second"

hr "6. error paths"
code=$(api -s -o /dev/null -w '%{http_code}' "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"cli/does-not-exist","messages":[{"role":"user","content":"hi"}]}')
echo "  unknown model : HTTP $code   (expect 503)"
code=$(api -s -o /dev/null -w '%{http_code}' "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d '{"messages":[]}')
echo "  missing model : HTTP $code   (expect 400)"

hr "7. connected clients"
curl -s "$BASE/api/clients" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  (gateway not reachable)'); sys.exit(0)
for c in d.get('live', []):
    print('  %s (%s) jobs=%d/%d' % (c['clientId'], c['platform'], c['activeJobs'], c['maxConcurrency']))
    for cap in c['capabilities']:
        print('     %s %-20s %s' % ('OK ' if cap['available'] else '-- ', cap['id'], cap.get('reason') or ''))
"

hr "8. usage rollup"
curl -s "$BASE/api/usage" | pretty
