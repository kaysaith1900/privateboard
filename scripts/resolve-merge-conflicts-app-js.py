#!/usr/bin/env python3
"""Resolve git merge markers in public/app.js (upstream main + voice/i18n fork)."""
from __future__ import annotations

from pathlib import Path

START = "<<<<<<< HEAD\n"
MID = "\n=======\n"
END = "\n>>>>>>> upstream/main\n"


def merge_brief_substages(head: str, up: str) -> str:
    u = up.strip().rstrip(",").strip()
    h = head.strip("\n").rstrip()
    return "    " + u + ",\n\n" + h + "\n    },\n"


def merge_adjourn_meta(head: str, up: str) -> str:
    h = head.rstrip()
    for line in up.split("\n"):
        if "lastBriefMode()" in line:
            return h + "\n" + line.strip() + "\n"
    return head


def merge_adjourn_subject(_head: str, up: str) -> str:
    u = up.strip()
    return (
        u.replace(
            '<span class="adjourn-summary-key">// subject</span>',
            '<span class="adjourn-summary-key">${this.escape(this._t("adj_key_subject"))}</span>',
        ).rstrip()
        + "\n"
    )


def merge_brief_seed(_head: str, _up: str) -> str:
    return (
        "            stages: seededStages,\n"
        "            llmLogs: [],\n"
        "            llmLogOpen: false,\n"
    )


def resolve(head: str, up: str) -> str:
    h, u = head, up

    if '{ v: "opus-4-7"' in h and "opus-4-6-fast" in u and "opus-4-6-fast" not in h:
        return u

    if "migrate_body_one" in h:
        return h

    if "seededStages" in u and "llmLogs" in h:
        return merge_brief_seed(h, u)

    if "_t(\"nk_title\"" in h or '"nk_title"' in h:
        return h

    if "t.primaryDeck" in h:
        return h

    if "_t(\"adj_meta_status" in h and "lastBriefMode" in u:
        return merge_adjourn_meta(h, u)

    if "adjourn-summary-row-subject" in u:
        return merge_adjourn_subject(h, u)

    if "${this.escape(noteTxt)}" in h:
        return h.rstrip() + "\n"

    if "renderBriefLlmTrace" in h and "BRIEF_SUBSTAGES" in u:
        return merge_brief_substages(h, u)

    if not h.strip() and "recLabel" in u:
        return ""

    if h.strip():
        return h
    return u


def dedupe_model_labels(js: str) -> str:
    """MODEL_LABELS had two opus-4-6 keys · keep upstream single entry."""
    bad = '''    "opus-4-6":         "Opus 4.6",
    "opus-4-6":'''
    good = '    "opus-4-6":'
    if bad in js:
        js = js.replace(bad, good, 1)
    return js


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    path = root / "public" / "app.js"
    text = path.read_text()
    out: list[str] = []
    pos = 0
    blocks = 0
    while True:
        start = text.find(START, pos)
        if start < 0:
            out.append(text[pos:])
            break
        out.append(text[pos:start])
        mid_i = text.find(MID, start)
        end_i = text.find(END, mid_i)
        if mid_i < 0 or end_i < 0:
            raise RuntimeError("malformed conflict markers in public/app.js")
        head_b = text[start + len(START):mid_i]
        up_b = text[mid_i + len(MID):end_i]
        out.append(resolve(head_b, up_b))
        pos = end_i + len(END)
        blocks += 1

    merged = dedupe_model_labels("".join(out))
    if "<<<<<<< HEAD" in merged or ">>>>>>> upstream/main" in merged:
        raise RuntimeError("Unresolved merge markers remain in public/app.js")
    path.write_text(merged)
    print(f"Resolved {blocks} conflicts in public/app.js")


if __name__ == "__main__":
    main()
