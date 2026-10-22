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

class OutputLimit(BaseException):
    """Not an Exception, so a program's own `except Exception` cannot swallow the cap."""

class CappedOutput(io.StringIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit
        self.used = 2  # the empty logs array: []
        self.overflowed = False
        self.pending = ""

    def write(self, text):
        cost = len(text.encode("utf-8"))
        if self.limit and self.used + cost > self.limit:
            self.overflowed = True
            raise OutputLimit()
        self.used += cost
        self.pending += text
        # Complete lines go to the host as they appear, so a program that is stopped still reports its output.
        *lines, self.pending = self.pending.split("\n")
        for line in lines:
            real_out.write(json.dumps({"type": "log", "text": line}) + "\n")
            real_out.flush()
        return super().write(text)

buf = CappedOutput(int(req.get("maxOutputBytes") or 0))
old = sys.stdout
sys.stdout = buf
error = None
try:
    exec(req["code"], globals_dict)
except OutputLimit:
    pass
except Exception:
    error = traceback.format_exc().strip().splitlines()[-1]
finally:
    sys.stdout = old

value = globals_dict.get("result")
try:
    value_bytes = len(json.dumps(value).encode("utf-8"))
except Exception:
    value = repr(value)
    value_bytes = len(json.dumps(value).encode("utf-8"))
if not buf.overflowed and buf.limit and buf.used + value_bytes > buf.limit:
    buf.overflowed = True
if buf.overflowed:
    real_out.write(json.dumps({
        "type": "done", "ok": False, "errorKind": "output-limit",
        "error": f"outer output exceeded {buf.limit} bytes", "logs": buf.getvalue().splitlines(),
    }) + "\n")
else:
    real_out.write(json.dumps({
        "type": "done", "ok": error is None, "error": error,
        "value": value, "logs": buf.getvalue().splitlines(),
    }) + "\n")
real_out.flush()
