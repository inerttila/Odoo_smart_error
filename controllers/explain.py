# -*- coding: utf-8 -*-
import json
import logging
import urllib.error
import urllib.request

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

MAX_TRACEBACK_CHARS = 6000

SYSTEM_PROMPT = (
    "You are a senior Odoo 17 developer helper. "
    "Given a Smart Error summary and traceback, explain briefly what is going wrong. "
    "Be concrete: name the model, method, field, or module when known. "
    "Keep the explanation short (3-6 sentences). "
    "Do not invent files or modules that are not in the data. "
    "Do not provide long step-by-step tutorials.\n\n"
    "After the explanation, ALWAYS end with exactly one line in this format:\n"
    "COMMAND: <shell command or none>\n"
    "Use COMMAND when an Odoo action helps, for example:\n"
    "- module code/XML/data/view/security changed → "
    "odoo-bin -c <config> -d <db> -u <module> --stop-after-init\n"
    "- new module not visible → update Apps list then install\n"
    "- JS/assets only with --dev=all → hard refresh browser (Ctrl+Shift+R)\n"
    "- Python field/compute definition changed → restart Odoo or -u <module>\n"
    "If the problem is only a code bug (wrong method name, bad value, logic error) "
    "and no upgrade/restart is required, use: COMMAND: none\n"
    "If the module technical name is known, put it in the -u flag. "
    "Do not invent a module name."
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

        payload_text = self._build_user_prompt(analysis or {}, traceback, message)
        try:
            if provider == "groq":
                text = self._call_groq(ICP, payload_text)
            elif provider == "gemini":
                text = self._call_gemini(ICP, payload_text)
            else:
                text = self._call_ollama(ICP, payload_text)
            explanation, command = self._split_command(text)
            if not command:
                command = self._heuristic_command(analysis or {}, traceback or "")
            return {
                "ok": True,
                "explanation": explanation,
                "command": command,
            }
        except Exception as exc:
            _logger.warning("Smart Error AI explain failed (%s): %s", provider, exc)
            return {"ok": False, "error": str(exc)}

    def _split_command(self, text):
        """Extract trailing COMMAND: line from the model reply."""
        if not text:
            return "", None
        lines = text.strip().splitlines()
        command = None
        kept = list(lines)
        for i in range(len(lines) - 1, -1, -1):
            raw = lines[i].strip()
            if raw.upper().startswith("COMMAND:"):
                value = raw.split(":", 1)[1].strip().strip("`")
                if value and value.lower() not in ("none", "n/a", "na", "-"):
                    command = value
                kept = lines[:i]
                # drop blank lines just above COMMAND
                while kept and not kept[-1].strip():
                    kept.pop()
                break
        return "\n".join(kept).strip(), command

    def _heuristic_command(self, analysis, traceback):
        """Best-effort upgrade/restart hint when the model omitted COMMAND."""
        module = analysis.get("module")
        blob = f"{analysis.get('message') or ''}\n{traceback}".lower()
        needs_upgrade = any(
            token in blob
            for token in (
                "parseerror",
                "xmlsyntaxerror",
                "validationerror: error while validating view",
                "ir.ui.view",
                "has no column",
                "undefined column",
                "relation does not exist",
                "keyerror: ",
                "external id not found",
                "parse error",
            )
        )
        if module and needs_upgrade:
            return f"odoo-bin -c CONFIG -d DB -u {module} --stop-after-init"
        if analysis.get("errorKind") == "AttributeError" and analysis.get("functionName"):
            # Missing method after code edit: reload Python (restart or upgrade)
            if module:
                return f"odoo-bin -c CONFIG -d DB -u {module} --stop-after-init"
            return "Restart Odoo (or run with --dev=all) after fixing the Python code"
        if analysis.get("source") == "client" and module:
            return "Hard refresh browser (Ctrl+Shift+R); if assets stale: restart Odoo with --dev=all"
        return None

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
        lines.append("Explain what is going on.")
        lines.append('End with COMMAND: ... or COMMAND: none')
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
