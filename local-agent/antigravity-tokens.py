#!/usr/bin/env python3
"""
Tally cumulative Antigravity (agy) token usage from its local SQLite conversation
DBs. agy writes every session to a single global store
(~/.gemini/antigravity-cli/conversations/<id>.db) regardless of cwd/launcher, and
caches each generation's raw protobuf response in the `gen_metadata` table. The
UsageMetadata lives at proto path .1.4 with varint fields:
    2 = uncached prompt tokens   3 = output tokens
    5 = cached prompt tokens     6 = tool-definition tokens
Fields 2 and 5 are disjoint (uncached vs cached portions of the prompt — proven by
field2 < field5 on cache-heavy turns), so total = 2+3+5+6 with no double-count.

Headless, read-only, zero token overhead. Emits a JSON object on stdout.
Hardened vs the original reverse-engineered parser: proper wire-type skipping at
every level (so an unexpected field can't desync the decoder) and a per-blob sanity
guard that drops absurd values instead of corrupting the total.
"""
import os, glob, sqlite3, json, sys

SANITY_MAX = 5_000_000  # a single field above this = parse drift; drop that blob


def read_varint(data, pos):
    shift = val = 0
    while True:
        if pos >= len(data):
            raise IndexError("varint truncated")
        b = data[pos]; pos += 1
        val |= (b & 0x7f) << shift; shift += 7
        if not (b & 0x80):
            return val, pos
        if shift > 70:
            raise ValueError("varint too long")


def iter_fields(data):
    """Yield (field_num, wire_type, value) for one protobuf message, skipping
    cleanly past every field so an unhandled type never desyncs the stream."""
    pos, n = 0, len(data)
    while pos < n:
        key, pos = read_varint(data, pos)
        fn, wt = key >> 3, key & 0x7
        if wt == 0:
            v, pos = read_varint(data, pos); yield fn, wt, v
        elif wt == 1:
            yield fn, wt, data[pos:pos + 8]; pos += 8
        elif wt == 2:
            ln, pos = read_varint(data, pos)
            yield fn, wt, data[pos:pos + ln]; pos += ln
        elif wt == 5:
            yield fn, wt, data[pos:pos + 4]; pos += 4
        else:
            raise ValueError(f"bad wire type {wt}")


def extract_usage(blob):
    """Walk .1 (response) -> .4 (UsageMetadata) -> {2,3,5,6} varints."""
    out = {}
    for fn, wt, val in iter_fields(blob):
        if fn == 1 and wt == 2:
            for f2, w2, v2 in iter_fields(val):
                if f2 == 4 and w2 == 2:
                    for f3, w3, v3 in iter_fields(v2):
                        if w3 == 0:
                            out[f3] = v3
    return out


def tally(conv_dir):
    agg = {"prompt": 0, "output": 0, "cached": 0, "tool": 0}
    rows = bad = dbs = 0
    for db in glob.glob(os.path.join(conv_dir, "*.db")):
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                cur = conn.execute("SELECT data FROM gen_metadata;")
                for (blob,) in cur.fetchall():
                    rows += 1
                    try:
                        f = extract_usage(blob)
                        p, o, c, t = f.get(2, 0), f.get(3, 0), f.get(5, 0), f.get(6, 0)
                        if max(p, o, c, t) > SANITY_MAX:
                            bad += 1; continue
                        agg["prompt"] += p; agg["output"] += o
                        agg["cached"] += c; agg["tool"] += t
                    except Exception:
                        bad += 1
                dbs += 1
            finally:
                conn.close()
        except Exception:
            # locked / unreadable DB (e.g. an active session): skip, count next run
            continue
    agg["total"] = agg["prompt"] + agg["output"] + agg["cached"] + agg["tool"]
    agg["dbs"] = dbs; agg["rows"] = rows; agg["bad_blobs"] = bad
    return agg


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
        "~/.gemini/antigravity-cli/conversations")
    print(json.dumps(tally(d)))
