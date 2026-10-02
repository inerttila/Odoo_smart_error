# -*- coding: utf-8 -*-
"""Build an Ollama Modelfile from the Odoo error playbooks.

This is the local "training" path: the playbooks become the model's
fixed examples. Run from any directory:

    python smart_error/training/build_ollama_model.py
    ollama create smart-error -f smart_error/training/Modelfile

Then set Settings > Smart Error model to: smart-error
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLAYBOOKS = ROOT / "data" / "error_playbooks.json"
MODELFILE = Path(__file__).resolve().parent / "Modelfile"
JSONL = Path(__file__).resolve().parent / "odoo_errors.jsonl"
BASE_MODEL = "llama3.2"

SYSTEM = (
    "You are an Odoo 17 error assistant. Reply with JSON only. "
    '{"summary":"one short sentence","commands":[{"label":"...","command":"..."}]}. '
    "Put detail in commands, not in the summary. "
    "Use MODULE/MODEL/METHOD from the report. Do not invent modules. "
    "Upgrade commands: odoo-bin -c CONFIG -d DB -u MODULE --stop-after-init. "
    "Code fixes start with #."
)


def main():
    books = json.loads(PLAYBOOKS.read_text(encoding="utf-8"))
    lines = [
        f"FROM {BASE_MODEL}",
        "",
        'SYSTEM """',
        SYSTEM,
        '"""',
        "",
    ]
    jsonl_lines = []
    for book in books:
        user = (
            f"Odoo error pattern {book['id']}. "
            f"Signals: {', '.join(book.get('match') or [])}."
        )
        answer = json.dumps(
            {"summary": book.get("summary"), "commands": book.get("commands")},
            ensure_ascii=False,
        )
        lines.append(f"MESSAGE user {json.dumps(user)}")
        lines.append(f"MESSAGE assistant {json.dumps(answer)}")
        lines.append("")
        jsonl_lines.append(
            json.dumps(
                {"instruction": SYSTEM, "input": user, "output": answer},
                ensure_ascii=False,
            )
        )
    MODELFILE.write_text("\n".join(lines), encoding="utf-8")
    JSONL.write_text("\n".join(jsonl_lines) + "\n", encoding="utf-8")
    print(f"Wrote {MODELFILE}")
    print(f"Wrote {JSONL}")
    print("Next: ollama create smart-error -f", MODELFILE)


if __name__ == "__main__":
    main()
