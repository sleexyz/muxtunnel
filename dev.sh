#!/bin/bash
# Start MuxTunnel development servers

cd "$(dirname "$0")"

# Check if tmux is running
if ! tmux list-sessions &>/dev/null; then
  echo "⚠️  Warning: tmux is not running. Start tmux first."
fi

echo "Starting MuxTunnel..."
echo "  Backend: http://localhost:3002"
echo "  Frontend: http://localhost:5181"
echo ""

# Run both servers
# Using npm to run in parallel
npm run dev &
PID_BACKEND=$!

npm run dev:vite &
PID_FRONTEND=$!

# Handle Ctrl+C to clean up
trap "kill $PID_BACKEND $PID_FRONTEND 2>/dev/null; exit" INT TERM

wait
