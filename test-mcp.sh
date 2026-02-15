#!/bin/bash
# Test script for Playwright MCP server

# Start the server in background
/usr/bin/node /home/mithul/my_files/ta/playwright/build/index.js &
SERVER_PID=$!

sleep 2

# Send initialize
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' >&${SERVER_PID}

sleep 1

# Send tools/list  
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' >&${SERVER_PID}

sleep 1

# Cleanup
kill $SERVER_PID 2>/dev/null

echo "Test complete"
