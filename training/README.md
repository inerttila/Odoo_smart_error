# Train the local Odoo error model

Smart Error already sends matching playbook examples with every request.
This folder builds a dedicated Ollama model so those examples stay in the model itself.

## 1. Build the files

```powershell
python smart_error/training/build_ollama_model.py
```

That writes:

- `Modelfile` — Ollama custom model on top of `llama3.2`
- `odoo_errors.jsonl` — the same cases, if you later fine-tune somewhere else

## 2. Create the model (free, local)

```powershell
ollama create smart-error -f smart_error/training/Modelfile
```

## 3. Use it in Odoo

Settings → Smart Error:

- Provider: **Ollama**
- Model: **smart-error**

## Add more cases

Edit `smart_error/data/error_playbooks.json`, then rebuild and recreate the model.
Each playbook needs `match` keywords, a one-line `summary`, and copyable `commands`.
