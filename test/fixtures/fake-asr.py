#!/usr/bin/env python3
"""协议替身：只验证 Node 侧的 worker 生命周期，不做真实转写。"""
import json
import os
import sys
import time

role = os.environ.get("ASR_ROLE", "main")
crash = os.environ.get("FAKE_CRASH", "")
marker_dir = os.environ.get("FAKE_MARKER_DIR", "/tmp")
marker = os.path.join(marker_dir, f"crashed-{role}")

print(json.dumps({"ready": True, "model": "fake-" + role, "load_ms": 1}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id")
    if crash == role and not os.path.exists(marker):
        try:
            open(marker, "w").write("1")
        except OSError:
            pass
        sys.exit(7)
    path = req.get("wav")
    if role == "main" and path and not os.path.exists(path):
        print(json.dumps({"id": rid, "error": "missing wav"}), flush=True)
        continue
    print(json.dumps({"id": rid, "text": f"{role}:ok", "ms": 5, "duration": 1.0}), flush=True)
    time.sleep(0.02)
