# Smart Error (Odoo 17)

Custom module that improves Odoo’s generic **Odoo Client Error** dialog with clearer context and an optional free AI explanation.

## What it does

When an error appears in the backend UI, Smart Error shows:

- **Source** — Client JS or Server
- **Module / model / field / method** — best-effort from the traceback
- **Short hint** — plain-language summary of the failure
- **See details** — full traceback (same as core)
- **Copy error** — summary + traceback for support

For server RPC errors (`UserError`, `ValidationError`, `AttributeError`, etc.) and client JS errors (`TypeError`, Owl, …).

Specialized dialogs (session expired, redirect warning, automation rules, …) are left alone.

## AI scan (optional)

On open, the dialog can ask a free AI what is going on, and suggest a **command** when an upgrade/restart helps (e.g. `-u module`).

| Provider | Notes |
|----------|--------|
| **Ollama** (default) | Local, free — install [Ollama](https://ollama.com), then `ollama pull llama3.2` |
| **Groq** | Free API key |
| **Gemini** | Free API key from [Google AI Studio](https://aistudio.google.com/) — model e.g. `gemini-3.6-flash` |

Configure under **Settings → Smart Error**.

## Install

1. Add this folder’s parent to `addons_path`, e.g.  
   `C:\Users\...\server\smart_error`
2. Update Apps list and install **Smart Error**
3. Depends on: `web`, `base_setup`


## Notes

- Does **not** patch core files under `base/web`; extends via registries.
- Without `?debug=assets`, client module detection may be uncertain (minified bundles).
