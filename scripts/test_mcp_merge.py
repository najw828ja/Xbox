#!/usr/bin/env python3
"""اختبار أداة merge_videos عبر نقطة MCP (JSON-RPC عبر Streamable HTTP)."""
import json, sys, urllib.request, uuid

BASE = "http://127.0.0.1:3000/mcp"
SID = str(uuid.uuid4())

def rpc(payload):
    req = urllib.request.Request(
        BASE,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Mcp-Session-Id": SID},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=280)
    ctype = resp.headers.get("Content-Type", "")
    body = resp.read().decode()
    if not body.strip():
        return None  # 202 Accepted — إشعار بلا رد
    if "text/event-stream" in ctype:
        # استخرج JSON من حدث SSE
        for line in body.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return None
    return json.loads(body)

# initialize
r = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {"name": "e2e-test", "version": "1.0"},
}})
print("initialize:", r["result"]["serverInfo"]["name"], r["result"]["protocolVersion"])
rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})

# merge_videos
r = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
    "name": "merge_videos",
    "arguments": {"urls": ["http://127.0.0.1:3000/v1.mp4", "http://127.0.0.1:3000/v2.mp4"], "wait_seconds": 240},
}})
out = r["result"]
print("isError:", out.get("isError", False))
for c in out.get("content", []):
    print("text:", c.get("text", "")[:700])
