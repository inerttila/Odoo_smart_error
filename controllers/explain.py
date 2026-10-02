# -*- coding: utf-8 -*-
import json
import logging
import urllib.error
import urllib.request

from odoo import http
from odoo.http import request

from .playbooks import (
    commands_from_playbook,
    match_playbook,
)

_logger = logging.getLogger(__name__)

MAX_TRACEBACK_CHARS = 6000

SYSTEM_PROMPT = (
    "You are an Odoo 17 error assistant. "
    "Reply with JSON only. No markdown. No extra text.\n"
    "Schema:\n"
    '{"summary":"one short sentence","commands":[{"label":"what this step does","command":"copyable command"}]}\n'
    "Rules:\n"
    "- summary is ONE sentence. Put the detail in commands, not in summary.\n"
    "- commands is an ordered list the developer can copy. 1 to 4 steps.\n"
    "- Use real module, model, and method names from the report. Do not invent modules.\n"
    "- Shell upgrades look like: odoo-bin -c CONFIG -d DB -u MODULE --stop-after-init\n"
    "- Code fixes are commands that start with # so they stay copyable notes.\n"
    "- If no shell action is needed, still return the code-fix command.\n"
    "- Do not write essays.\n"
    "- Explain only the message in this report. Do not reuse another error type.\n"
    "- Never mention a compute method unless the message says an attribute is missing.\n"
    "- Put the real error message values in the commands."
)


class SmartErrorExplainController(http.Controller):

    @http.route("/smart_error/explain", type="json", auth="user")
    def explain(self, analysis=None, traceback=None, message=None, **kwargs):
        ICP = request.env["ir.config_parameter"].sudo()
        provider = (ICP.get_param("smart_error.ai_provider") or "ollama").strip().lower()
        if provider in ("disabled", "none", "false", "0"):
            return {
                "ok": False,
                "error": "AI explanation is disabled. Enable it in Settings > Smart Error.",
            }

        # Auto-scan on dialog open can be turned off in settings
        if kwargs.get("auto"):
            auto_flag = (ICP.get_param("smart_error.ai_auto") or "True").strip().lower()
            if auto_flag in ("false", "0", "no", ""):
                return {"ok": False, "skipped": True}

        analysis = analysis or {}
        book = match_playbook(analysis, traceback or "")
        if book:
            commands = commands_from_playbook(book, analysis)
            summary = book.get("summary") or ""
            if analysis.get("message"):
                summary = f"{summary} {analysis.get('message')}"
            return {
                "ok": True,
                "explanation": summary.strip(),
                "commands": commands,
                "command": "\n\n".join(
                    f"{step['label']}\n{step['command']}" for step in commands
                )
                or None,
            }

        payload_text = self._build_user_prompt(analysis, traceback, message)
        try:
            if provider == "groq":
                text = self._call_groq(ICP, payload_text)
            elif provider == "gemini":
                text = self._call_gemini(ICP, payload_text)
            else:
                text = self._call_ollama(ICP, payload_text)
            summary, commands = self._parse_ai_payload(text)
            if not commands:
                commands = self._fallback_commands(analysis or {}, traceback or "")
            return {
                "ok": True,
                "explanation": summary,
                "commands": commands,
                "command": "\n\n".join(
                    f"{step['label']}\n{step['command']}" for step in commands
                )
                or None,
            }
        except Exception as exc:
            _logger.warning("Smart Error AI explain failed (%s): %s", provider, exc)
            return {"ok": False, "error": str(exc)}

    def _parse_ai_payload(self, text):
        """Expect JSON {summary, commands}. Fall back to a single block."""
        if not text:
            return "", []
        raw = text.strip()
        if raw.startswith("```"):
            raw = raw.strip("`")
            if raw.lower().startswith("json"):
                raw = raw[4:]
            raw = raw.strip()
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end > start:
            try:
                data = json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                data = None
            if isinstance(data, dict):
                summary = (data.get("summary") or "").strip()
                steps = []
                for item in data.get("commands") or []:
                    if isinstance(item, str):
                        command = item.strip()
                        label = "Step"
                    elif isinstance(item, dict):
                        command = (item.get("command") or "").strip()
                        label = (item.get("label") or "Step").strip()
                    else:
                        continue
                    if command and command.lower() not in ("none", "n/a"):
                        steps.append({"label": label, "command": command})
                return summary, steps
        return raw, []

    def _fallback_commands(self, analysis, traceback):
        book = match_playbook(analysis, traceback)
        if not book:
            return []
        return commands_from_playbook(book, analysis)

    def _build_user_prompt(self, analysis, traceback, message):
        lines = ["Odoo Smart Error report:", ""]
        for key in (
            "source",
            "title",
            "errorKind",
            "module",
            "model",
            "field",
            "functionName",
            "property",
            "file",
            "hint",
            "message",
        ):
            val = analysis.get(key)
            if val:
                lines.append(f"{key}: {val}")
        if message and message != analysis.get("message"):
            lines.append(f"raw_message: {message}")
        tb = (traceback or "")[:MAX_TRACEBACK_CHARS]
        if tb:
            lines.extend(["", "Traceback:", tb])
        lines.append("")
        lines.append("")
        lines.append("Return JSON only about this exact error. Do not answer with a different error pattern.")
        return "\n".join(lines)

    def _http_json(self, url, payload, headers=None, timeout=60):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {err.code}: {body[:500]}") from err
        except urllib.error.URLError as err:
            raise RuntimeError(
                f"Cannot reach AI service at {url}. "
                f"If using Ollama, install it and run: ollama serve && ollama pull llama3.2"
            ) from err

    def _call_ollama(self, ICP, user_text):
        base = (ICP.get_param("smart_error.ai_ollama_url") or "http://127.0.0.1:11434").rstrip("/")
        model = ICP.get_param("smart_error.ai_model") or "llama3.2"
        result = self._http_json(
            f"{base}/api/chat",
            {
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_text},
                ],
            },
            timeout=90,
        )
        content = (result.get("message") or {}).get("content")
        if not content:
            raise RuntimeError("Ollama returned an empty response. Is the model pulled?")
        return content.strip()

    def _call_groq(self, ICP, user_text):
        api_key = ICP.get_param("smart_error.ai_api_key") or ""
        if not api_key:
            raise RuntimeError(
                "Groq API key missing. Set it in Settings > Smart Error "
                "(free key at https://console.groq.com)."
            )
        model = ICP.get_param("smart_error.ai_model") or "llama-3.1-8b-instant"
        result = self._http_json(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_text},
                ],
            },
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=60,
        )
        choices = result.get("choices") or []
        if not choices:
            raise RuntimeError("Groq returned no choices.")
        return (choices[0].get("message") or {}).get("content", "").strip()

    def _call_gemini(self, ICP, user_text):
        api_key = ICP.get_param("smart_error.ai_api_key") or ""
        if not api_key:
            raise RuntimeError(
                "Gemini API key missing. Set it in Settings > Smart Error "
                "(free key at https://aistudio.google.com/apikey)."
            )
        model = (ICP.get_param("smart_error.ai_model") or "gemini-3.6-flash").strip()
        model = model.removeprefix("models/")
        # Migrate retired / wrong defaults (llama3.2, gemini-2.0-flash, etc.)
        retired = {
            "llama3.2",
            "llama3.2:latest",
            "gemini-2.0-flash",
            "gemini-1.5-flash",
            "gemini-pro",
        }
        if not model.lower().startswith("gemini") or model.lower() in retired:
            model = "gemini-3.6-flash"
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent"
        )
        result = self._http_json(
            url,
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": f"{SYSTEM_PROMPT}\n\n{user_text}"}],
                    }
                ],
            },
            headers={"x-goog-api-key": api_key},
            timeout=60,
        )
        candidates = result.get("candidates") or []
        if not candidates:
            raise RuntimeError("Gemini returned no candidates.")
        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        text = "".join(p.get("text", "") for p in parts).strip()
        if not text:
            raise RuntimeError("Gemini returned an empty response.")
        return text
