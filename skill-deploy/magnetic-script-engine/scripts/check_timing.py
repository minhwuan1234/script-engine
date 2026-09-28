#!/usr/bin/env python3
"""Check VO timing of a Magnetic Script draft (markdown).

Parses every table row shaped `| 0:00–0:05 | voiceover | on screen |`,
groups rows by the nearest preceding "## Version X" heading, and reports:
- per-segment words/sec (flags >3.0 dense, <1.5 thin)
- hook (0:00–0:15) word count vs 30–40 target
- total VO words vs duration and overall w/s

Usage: python check_timing.py draft.md
"""
import re
import sys

ROW = re.compile(r"^\|\s*(\d+:\d{2})\s*[–\-—]\s*(\d+:\d{2})\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$")
VERSION = re.compile(r"^##\s+(Version\s+\S+.*)$", re.I)
DENSE, THIN = 3.0, 1.5


def secs(t):
    m, s = t.split(":")
    return int(m) * 60 + int(s)


def words(text):
    text = re.sub(r"\[[^\]]*\]", "", text)  # drop [ADD SOURCED STAT] etc.
    text = re.sub(r"[*_`\"“”]", "", text)
    return len(re.findall(r"[A-Za-zÀ-ỹ0-9']+", text))


def main(path):
    versions, current = {}, "Script"
    with open(path, encoding="utf-8") as f:
        for line in f:
            v = VERSION.match(line.strip())
            if v:
                current = v.group(1).strip()
                continue
            r = ROW.match(line.strip())
            if r:
                start, end, vo, screen = r.groups()
                versions.setdefault(current, []).append((secs(start), secs(end), start, end, vo, screen))

    if not versions:
        print("No timestamped rows found (expected `| 0:00–0:05 | VO | On screen |`).")
        return 1

    issues = 0
    for name, rows in versions.items():
        print(f"\n=== {name} ===")
        hook_words = total = 0
        for s, e, st, en, vo, screen in rows:
            dur = e - s
            w = words(vo)
            total += w
            if e <= 15:
                hook_words += w
            if dur <= 0:
                print(f"  {st}–{en}: invalid range"); issues += 1; continue
            wps = w / dur
            flag = ""
            if wps > DENSE:
                flag = "  <-- DENSE"; issues += 1
            elif wps < THIN:
                note = "(visual-only reason noted?)" if screen else "(no On screen note!)"
                flag = f"  <-- THIN {note}"
                if not screen: issues += 1
            print(f"  {st}–{en}  {w:>3}w / {dur:>2}s = {wps:.2f} w/s{flag}")
        end = max(r[1] for r in rows)
        overall = total / end if end else 0
        hook_ok = 30 <= hook_words <= 40
        print(f"  Hook 0:00–0:15: {hook_words} words {'OK' if hook_ok else '<-- target 30–40'}")
        if not hook_ok: issues += 1
        print(f"  Total: {total} words over {end//60}:{end%60:02d} = {overall:.2f} w/s")
    print(f"\n{issues} issue(s) flagged.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__); sys.exit(2)
    sys.exit(main(sys.argv[1]))
