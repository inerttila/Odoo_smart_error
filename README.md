# Smart Error (Odoo 17)

Smart Error replaces the generic **Odoo Client Error** dialog. The stock popup only says that something failed and hides the traceback under See details. This module reads that same error and shows where it came from, what the message actually means, and the commands that belong to that case.

## What the dialog shows

- **Source:** client JS or server
- **Kind:** `ValueError`, `UserError`, `AttributeError`, Owl `TypeError`, and so on
- **Module, model, field, method, file** when the traceback contains them
- **Explanation:** one line plus the real exception text
- **Commands:** copyable steps for this error (fix a value, start a service, restart Odoo, or `-u module`)
- **See details** and **Copy error** stay, with the full traceback included

Specialized Odoo dialogs (session expired, redirect warning, automation rules) are left alone.

## How an error is chosen

The first pass is local, in `data/error_playbooks.json`. A playbook is used only when **every** keyword is in the error. The exception type alone is not enough, so a `ValueError` about a date does not receive a compute-method answer.


If no playbook matches, the dialog asks the configured AI. The model must answer this message only. It must not reuse a sample from a different error. Detail goes into the command list, not into a long paragraph.

Placeholders in a command (`MESSAGE`, `MODULE`, `MODEL`, `METHOD`) are filled from the traceback before the dialog opens.

## AI providers

**Settings → Smart Error**

| Provider | Notes |
|----------|--------|
| Ollama | Local and free. `llama3.2`, or the local model `smart-error` built from the playbooks |
| Groq | Free API key |
| Gemini | Free API key. Current model id: `gemini-3.6-flash` |

Auto-explain runs when the dialog opens. **Ask AI again** repeats the call.

### Train the local model

Playbooks are the training set. Add a case in `data/error_playbooks.json` (`id`, `match`, `summary`, `commands`), then:

```powershell
python smart_error/training/build_ollama_model.py
ollama create smart-error -f smart_error/training/Modelfile
```

Set the Ollama model name to `smart-error`.

## Install

1. Add this addon’s parent folder to `addons_path`.
2. Update the Apps list and install **Smart Error**.
3. Depends on `web` and `base_setup`.

Core files under `base/web` are not edited. The module registers an `error_handlers` entry (sequence 96) and a dialog on `web.assets_backend`.

## Layout

```
smart_error/
  controllers/explain.py          # /smart_error/explain
  controllers/playbooks.py        # keyword match
  data/error_playbooks.json
  static/src/                     # analyzer, dialog, handler
  training/                       # Modelfile + odoo_errors.jsonl
```
