#!/bin/bash
# Auto-approve 51team MCP tool permissions for tmux sessions
# Usage: ./auto-approve.sh <session-prefix> <duration-seconds>

PREFIX="${1:-shenju-web}"
DURATION="${2:-120}"

echo "Auto-approving 51team MCP permissions for ${PREFIX}-* sessions (${DURATION}s)..."

end=$((SECONDS + DURATION))
while [ $SECONDS -lt $end ]; do
  for session in $(tmux ls 2>/dev/null | grep "^${PREFIX}-" | cut -d: -f1); do
    pane=$(tmux capture-pane -t "$session" -p 2>/dev/null | tail -3)
    if echo "$pane" | grep -q "Do you want to proceed?"; then
      # Check if it's a 51team tool
      if echo "$pane" | grep -q "51team"; then
        tmux send-keys -t "$session" "2" Enter
        echo "  [$(date +%H:%M:%S)] Approved: $session"
      fi
    fi
  done
  sleep 2
done
echo "Auto-approve finished."
