#!/bin/sh
set -e

echo "Starting AI Agentic Service..."

# Authenticate Codex CLI with the server-wide OpenAI API key
if [ -z "$OPENAI_API_KEY" ]; then
    echo "ERROR: OPENAI_API_KEY is not set. Codex CLI cannot authenticate." >&2
    exit 1
fi

echo "Authenticating Codex CLI with OPENAI_API_KEY..."
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
echo "Codex authentication completed"

# Create required directories if they don't exist
mkdir -p /app/logs
mkdir -p /app/resources/contexts
mkdir -p /app/resources/templates
mkdir -p /app/resources/schemas

# Check if the service is healthy before starting
echo "Checking Node.js environment..."
node --version
npm --version

# Start the application
echo "Starting Node.js application..."
exec node src/index.js