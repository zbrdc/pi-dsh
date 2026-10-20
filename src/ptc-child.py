#!/usr/bin/env python3
"""PTC Python child (dsh ptc-runtime-python analogue).
Reads one JSON line {code, namespaces}; tool calls are synchronous JSON lines
{type:call, callId, fn, args}; host replies {type:call-result, ...}.
Program sets `result` for its return value; print() is captured as logs."""
import sys, json, io, traceback

real_out = sys.stdout
req = json.loads(sys.stdin.readline())
seq = 0

def call(fn, args):
    global seq
    seq += 1
    real_out.write(json.dumps({"type": "call", "callId": seq, "fn": fn, "args": [args]}) + "\n")
    real_out.flush()
    reply = json.loads(sys.stdin.readline())
    if not reply.get("ok"):
        raise RuntimeError(reply.get("error", "tool call failed"))
    return reply.get("value")

class NS:
    def __init__(self, name):
        self._name = name
    def __getattr__(self, item):
        return lambda args=None: call(f"{self._name}.{item}", args)

globals_dict = {"__name__": "__ptc__"}
for ns in (req.get("namespaces") or {}):
    globals_dict[ns] = NS(ns)

buf = io.StringIO()
old = sys.stdout
sys.stdout = buf
error = None
try:
    exec(req["code"], globals_dict)
except Exception:
    error = traceback.format_exc().strip().splitlines()[-1]
finally:
    sys.stdout = old

value = globals_dict.get("result")
try:
    json.dumps(value)
except Exception:
    value = repr(value)
real_out.write(json.dumps({
    "type": "done", "ok": error is None, "error": error,
    "value": value, "logs": buf.getvalue().splitlines(),
}) + "\n")
real_out.flush()
