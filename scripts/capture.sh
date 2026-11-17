#!/bin/sh
# Capture a real pi session that an MCP event wakes, for the README screenshot.
#
#   scripts/capture.sh [model]
#
# Needs the letagents CLI (https://letagents.talk). pi runs with a temporary
# agent directory: your pi settings, sessions and MCP config are not touched,
# but auth.json is copied so the model can run. Writes scripts/session.ansi;
# render it with: python3 scripts/render.py scripts/session.ansi assets/demo.png
set -eu
MODEL=${1:-openai-codex/gpt-6.1-sol}
LETAGENTS=${LETAGENTS:-letagents} # the binary that runs as the MCP server
REPO=$(cd "$(dirname "$0")/.." && pwd)
AGENT=$(mktemp -d)
DEMO=/tmp/demo
NAME=events-demo
mkdir -p "$DEMO"
cp "$HOME/.pi/agent/auth.json" "$AGENT/"
printf '{"mcpServers":{"letagents":{"command":"%s","args":["mcp","--as","%s"]}}}\n' "$LETAGENTS" "$NAME" > "$AGENT/mcp.json"
letagents inbox --as "$NAME" > /dev/null 2>&1 || true

tmux kill-session -t eventsdemo 2>/dev/null || true
# Start pi as the pane's command: no shell prompt in the capture.
tmux new-session -d -s eventsdemo -x 100 -y 60 -c "$DEMO" \
  "env PI_CODING_AGENT_DIR=$AGENT pi -e $REPO/src/index.ts --no-skills --no-context-files --no-session \
--no-prompt-templates --model $MODEL --thinking low --system-prompt 'You are a helpful assistant. Answer briefly.'; sleep 600"
sleep 8
tmux send-keys -t eventsdemo -l "Subscribe to message.received on letagents with include_text. When a message arrives, tell me in one line who wrote and what they want."
sleep 1
tmux send-keys -t eventsdemo Enter
i=0
until grep -q "subscribe" "$AGENT/mcp-events.log" 2>/dev/null && tmux capture-pane -p -t eventsdemo | grep -q '↑[0-9.]*k'; do
  i=$((i + 1)); [ $i -gt 30 ] && { echo "timed out waiting for the subscription" >&2; exit 1; }
  sleep 3
done
sleep 3
MACHINE=$(letagents whoami | awk '/^name:/ {print $2}')
letagents send "$MACHINE/$NAME" "The deploy of build 418 failed on staging. Can you check the logs?" --as ci-bot
# Wait for the event, then for the woken turn to end: the screen stops changing.
i=0
until grep -q "event(s)" "$AGENT/mcp-events.log"; do
  i=$((i + 1)); [ $i -gt 30 ] && { echo "timed out waiting for the event" >&2; exit 1; }
  sleep 1
done
prev=""; i=0
while :; do
  sleep 5
  cur=$(tmux capture-pane -p -t eventsdemo)
  [ "$cur" = "$prev" ] && break
  prev=$cur; i=$((i + 1)); [ $i -gt 24 ] && { echo "timed out waiting for the turn" >&2; exit 1; }
done
tmux capture-pane -p -e -t eventsdemo -S - > "$REPO/scripts/session.ansi"
letagents inbox --as "$NAME" > /dev/null 2>&1 || true
tmux kill-session -t eventsdemo
rm -rf "$AGENT"
echo "$REPO/scripts/session.ansi"
