#!/usr/bin/env python3
"""Check VO pacing in a magnetic-script draft.

Reads a markdown file with tables whose first column is a time range
(e.g. `0:00–0:05`) and second column is voiceover. Groups rows under the
nearest preceding "## Version X" heading and reports, per version:
- words and words/sec per segment (flags dense > 3.0 w/s, thin < 1.5 w/s)
- hook word count (rows ending at or before 0:15; target 30-40)
- total words vs total duration (target ~2.2-2.8 w/s overall)
- gaps/overlaps between consecutive segments

Usage: python check_timing.py draft.md
Stdlib only.
"""
import re
import sys

RANGE = re.compile(r"^\s*(\d+):(\d{2})\s*[–\-—]\s*(\d+):(\d{2})\s*$")
VERSION = re.compile(r"^##\s+(Version\s+\w+.*)$", re.I)


def secs(m, s):
    return int(m) * 60 + int(s)


def words(text):
    text = re.sub(r"\[[^\]]*\]", " ", text)  # ignore [bracket notes]
    text = re.sub(r"[*_`]", "", text)
    count = 0
    for tok in re.findall(r"[A-Za-z0-9’']+", text):
        if tok.isdigit() and len(tok) > 2:
            count += (len(tok) + 1) // 2  # "4400" is said "forty-four hundred"
        else:
            count += 1
    return count


def parse(path):
    versions = {}
    current = "Unlabelled"
    for line in open(path, encoding="utf-8"):
        vm = VERSION.match(line.strip())
        if vm:
            current = vm.group(1).strip()
            continue
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        rm = RANGE.match(cells[0].replace("*", ""))
        if not rm:
            continue
        start = secs(rm.group(1), rm.group(2))
        end = secs(rm.group(3), rm.group(4))
        versions.setdefault(current, []).append((start, end, words(cells[1]), cells[0]))
    return versions


def report(name, rows):
    rows.sort(key=lambda r: r[0])
    print(f"\n=== {name} ===")
    flags = 0
    prev_end = None
    for start, end, w, label in rows:
        dur = end - start
        note = ""
        if dur <= 0:
            note = "  !! bad range"
            flags += 1
        else:
            wps = w / dur
            if wps > 3.0:
                note = f"  !! DENSE ({wps:.2f} w/s)"
                flags += 1
            elif wps < 1.5 and w > 0:
                note = f"  ~ thin ({wps:.2f} w/s) — needs visual reason"
            elif w == 0:
                note = "  ~ visual-only beat"
        if prev_end is not None and start != prev_end:
            note += f"  !! gap/overlap vs previous end {prev_end}s"
            flags += 1
        print(f"  {label:<14} {w:>3} words / {dur:>3}s{note}")
        prev_end = end
    hook_words = sum(w for s, e, w, _ in rows if e <= 15)
    total_words = sum(r[2] for r in rows)
    total_dur = rows[-1][1] - rows[0][0] if rows else 0
    print(f"  Hook (≤0:15): {hook_words} words (target 30–40)"
          + ("  !! off target" if not 25 <= hook_words <= 45 else ""))
    if total_dur:
        overall = total_words / total_dur
        tag = ""
        if overall > 2.9:
            tag = "  !! overall too dense"
            flags += 1
        elif overall < 2.0:
            tag = "  ~ overall light — fine for Low or visual-led scripts; otherwise tighten or shorten duration"
        print(f"  Total: {total_words} words / {total_dur}s = {overall:.2f} w/s{tag}")
    print(f"  Flags: {flags}")
    return flags


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    versions = parse(sys.argv[1])
    if not versions:
        print("No timestamped table rows found. Use ranges like 0:00–0:05 in column 1.")
        sys.exit(1)
    total = sum(report(n, r) for n, r in versions.items())
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
