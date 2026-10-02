# -*- coding: utf-8 -*-
import json
import logging

from odoo.tools.misc import file_path

_logger = logging.getLogger(__name__)


def load_playbooks():
    path = file_path("smart_error/data/error_playbooks.json")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def match_playbook(analysis, traceback=""):
    """Return the best playbook only when the error text actually contains its keywords.

    Error kind alone is not enough, so a ValueError about a date does not
    inherit a compute-method answer.
    """
    message = str(analysis.get("message") or "")
    blob = " ".join(
        str(part or "")
        for part in (
            analysis.get("errorKind"),
            message,
            analysis.get("functionName"),
            analysis.get("hint"),
            traceback,
        )
    ).lower()
    kind = (analysis.get("errorKind") or "").lower()
    best = None
    best_score = 0
    for book in load_playbooks():
        tokens = [token.lower() for token in (book.get("match") or [])]
        hits = [token for token in tokens if token and token in blob]
        # Every listed keyword must be present. This keeps short tokens
        # such as "year" from matching unrelated ValueError messages.
        if not tokens or len(hits) != len(tokens):
            continue
        score = 4 + len(hits)
        kinds = [item.lower() for item in (book.get("kinds") or [])]
        if kind and kind in kinds:
            score += 3
        # Prefer hits inside the exception message, not a huge traceback.
        if all(token in message.lower() for token in tokens):
            score += 5
        if score > best_score:
            best = book
            best_score = score
    return best


def fill_placeholders(command, analysis):
    module = analysis.get("module") or "the module from the traceback"
    model = analysis.get("model") or "the model in the error"
    method = analysis.get("functionName") or "the missing name"
    field = analysis.get("field") or "the field in the error"
    message = analysis.get("message") or ""
    text = command or ""
    return (
        text.replace("MESSAGE", message)
        .replace("MODULE", module)
        .replace("MODEL", model)
        .replace("METHOD", method)
        .replace("FIELD", field)
    )


def commands_from_playbook(book, analysis):
    steps = []
    for item in book.get("commands") or []:
        command = fill_placeholders(item.get("command"), analysis)
        if not command:
            continue
        steps.append(
            {
                "label": item.get("label") or "Step",
                "command": command,
            }
        )
    return steps


def playbook_examples_text(limit=4):
    """Kept for the training script. Runtime prompts must not send unrelated examples."""
    return ""
