"""Fact check: cleanup may reword, but it must never lose or change a number, date or name."""
from __future__ import annotations

import re

ONES = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
TENS = {w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
SCALE = {"hundred": 100, "thousand": 1000}
NUMWORDS = set(ONES) | set(TENS) | set(SCALE)


def _words_to_digits(text: str) -> str:
    """'twenty five' -> '25'. A lone 'one' is left alone ('no one', 'one of us')."""
    tokens = re.findall(r"[A-Za-z']+|\d[\d.,]*|\S", text.lower().replace("-", " "))
    out, i = [], 0
    while i < len(tokens):
        if tokens[i] in NUMWORDS:
            j = i
            while j < len(tokens) and tokens[j] in NUMWORDS:
                j += 1
            seq = tokens[i:j]
            if seq == ["one"]:
                out.append("one")
            else:
                total = cur = 0
                for t in seq:
                    if t in ONES:
                        cur += ONES[t]
                    elif t in TENS:
                        cur += TENS[t]
                    elif t == "hundred":
                        cur = max(cur, 1) * 100
                    else:
                        total += max(cur, 1) * 1000
                        cur = 0
                out.append(str(total + cur))
            i = j
        else:
            out.append(tokens[i])
            i += 1
    return " ".join(out)


def _numbers(text: str) -> set[str]:
    t = re.sub(r"(?<=\d),(?=\d{3})", "", _words_to_digits(text))
    return {n.rstrip(".") for n in re.findall(r"\d+(?:\.\d+)?", t)}


def _names(text: str) -> set[str]:
    found = set()
    for m in re.finditer(r"\b[A-Z][a-z']+\b|\b[A-Z]{2,}\b", text):
        word = m.group(0)
        if word == "I" or word.startswith("I'"):
            continue
        before = text[:m.start()].rstrip()
        at_sentence_start = (not before) or before[-1] in ".!?\n:"
        if at_sentence_start and not word.isupper():
            continue
        found.add(word.lower())
    return found


def facts_preserved(raw: str, cleaned: str) -> bool:
    if not _numbers(raw) <= _numbers(cleaned):
        return False
    low = cleaned.lower()
    return all(re.search(rf"\b{re.escape(n)}\b", low) for n in _names(raw))
