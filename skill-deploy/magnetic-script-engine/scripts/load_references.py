#!/usr/bin/env python3
"""Print only the references needed for one Magnetic Script request."""

from pathlib import Path
import sys


ICP = {
    "healthcare": "icp-healthcare.md",
    "corporate_lnd": "icp-corporate-lnd.md",
    "publishing": "icp-publishing.md",
    "ngo": "icp-ngo.md",
    "unclear": "icp-unclear.md",
}

STYLE = {
    "journey": "style-journey.md",
    "mechanism": "style-mechanism.md",
    "myth": "style-myth.md",
    "before_after": "style-before-after.md",
    "countdown": "style-countdown.md",
    "mystery": "style-mystery.md",
    "qa": "style-qa.md",
    "stakes": "style-stakes.md",
}


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] not in ICP or any(
        key not in STYLE for key in sys.argv[2:]
    ):
        raise SystemExit(
            "Usage: load_references.py <icp_key> <version_a_style_key> <version_b_style_key>"
        )

    icp, style_a, style_b = sys.argv[1:]
    references = [
        ("Factual boundary", "source-accuracy.md"),
        ("Materials sheet", "materials-analysis.md"),
        (f"Selected ICP: {icp}", ICP[icp]),
        (f"Version A style: {style_a}", STYLE[style_a]),
        (f"Version B style: {style_b}", STYLE[style_b]),
        ("Script craft", "script-craft.md"),
        ("Final review", "final-review.md"),
        ("Output format", "output-format.md"),
    ]
    root = Path(__file__).resolve().parents[1] / "references"
    for label, filename in references:
        print(f"\n===== {label} | references/{filename} =====\n")
        print((root / filename).read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
