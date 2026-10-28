"""Backfill usage-meter's per-session stats from Claude Code transcripts.

Writes <out>/<session id>.json in the shape the mod keeps (hooks/sessions.ts),
marked "src": "backfill". A session the mod already writes ("src": "live") is
left alone unless --force.

Cheap by construction: each transcript is streamed line by line, a line is
parsed only when a byte test says it is an assistant reply, a typed prompt or
a title, and only usage, model, timestamp and tool names are kept. Files not
modified within --days are not opened.

  py -I tools/backfill.py                       # last 7 days, default folders
  py -I tools/backfill.py --days 14 --projects D:/other/.claude/projects
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

HOUR = 3_600_000


def default_projects():
    home = Path.home()
    dirs = [home / ".claude" / "projects"]
    # Sessions that run inside WSL keep their transcripts there.
    wsl = Path(r"\\wsl.localhost")
    if sys.platform == "win32" and wsl.exists():
        for distro in wsl.iterdir():
            for user in (distro / "home").glob("*"):
                p = user / ".claude" / "projects"
                if p.is_dir():
                    dirs.append(p)
    return [d for d in dirs if d.is_dir()]


def ms(ts):
    return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)


def new_stats(sid):
    return {
        "id": sid, "first": None, "last": None, "turns": 0,
        "tok": [0, 0, 0, 0], "agentTok": [0, 0, 0, 0], "agentTurns": 0,
        "models": {}, "tools": {}, "hours": {}, "src": "backfill",
        "_seen": set(), "_tools_seen": set(), "_agents": set(),
    }


def add(a, u):
    a[0] += u.get("input_tokens") or 0
    a[1] += u.get("output_tokens") or 0
    a[2] += u.get("cache_read_input_tokens") or 0
    a[3] += u.get("cache_creation_input_tokens") or 0


def scan(path, sessions, since):
    with open(path, "rb") as f:
        for raw in f:
            is_reply = b'"type":"assistant"' in raw and b'"usage"' in raw
            is_prompt = (not is_reply and b'"type":"user"' in raw
                         and b'"tool_result"' not in raw and b'"isMeta":true' not in raw)
            is_title = b'"type":"custom-title"' in raw
            if not (is_reply or is_prompt or is_title):
                continue
            try:
                o = json.loads(raw)
            except ValueError:
                continue
            sid = o.get("sessionId")
            if not sid:
                continue
            s = sessions.get(sid)
            if s is None:
                s = sessions[sid] = new_stats(sid)
            if is_title:
                s["title"] = o.get("customTitle") or s.get("title")
                continue
            ts = o.get("timestamp")
            if not ts:
                continue
            t = ms(ts)
            if t < since:
                continue
            s["first"] = t if s["first"] is None else min(s["first"], t)
            s["last"] = t if s["last"] is None else max(s["last"], t)
            if o.get("cwd") and not o.get("isSidechain"):
                s["cwd"] = o["cwd"]
            side = bool(o.get("isSidechain"))
            if o.get("type") == "user":
                if side:
                    s["_agents"].add(o.get("agentId"))
                elif not o.get("isMeta"):
                    s["turns"] += 1
                continue
            m = o.get("message") or {}
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id") not in s["_tools_seen"]:
                    s["_tools_seen"].add(b.get("id"))
                    s["tools"][b.get("name")] = s["tools"].get(b.get("name"), 0) + 1
            # One reply is written as one row per content block, each with the
            # same id and usage: count it once.
            key = m.get("id") or o.get("requestId") or o.get("uuid")
            if key in s["_seen"]:
                continue
            s["_seen"].add(key)
            u = m.get("usage") or {}
            add(s["agentTok"] if side else s["tok"], u)
            add(s["models"].setdefault(m.get("model") or "?", [0, 0, 0, 0]), u)
            add(s["hours"].setdefault(str(t // HOUR * HOUR), [0, 0, 0, 0]), u)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--projects", nargs="*", type=Path, help="transcript folders (default: ~/.claude/projects and WSL's)")
    ap.add_argument("--out", type=Path, default=Path.home() / ".claude" / "usage-meter" / "sessions")
    ap.add_argument("--force", action="store_true", help="overwrite sessions the mod writes live")
    args = ap.parse_args()

    started = time.time()
    since = int((started - args.days * 86400) * 1000)
    folders = args.projects or default_projects()
    sessions = {}
    files = size = 0
    for folder in folders:
        for root, _, names in os.walk(folder):
            for name in names:
                if not name.endswith(".jsonl"):
                    continue
                p = Path(root) / name
                st = p.stat()
                if st.st_mtime * 1000 < since:
                    continue
                files += 1
                size += st.st_size
                scan(p, sessions, since)

    args.out.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    for sid, s in sessions.items():
        if s["first"] is None:
            continue
        target = args.out / f"{sid}.json"
        if target.exists() and not args.force:
            try:
                if json.loads(target.read_text(encoding="utf-8")).get("src") == "live":
                    skipped += 1
                    continue
            except ValueError:
                pass
        s["agentTurns"] = len(s.pop("_agents") - {None})
        del s["_seen"], s["_tools_seen"]
        target.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
        os.utime(target, (s["last"] / 1000, s["last"] / 1000))
        written += 1

    print(f"{files} transcripts, {size / 1e6:.0f} MB in {time.time() - started:.1f} s; "
          f"{written} sessions written, {skipped} left to the mod -> {args.out}")


if __name__ == "__main__":
    main()
