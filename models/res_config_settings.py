# -*- coding: utf-8 -*-
from odoo import api, fields, models

PROVIDER_DEFAULT_MODELS = {
    "ollama": "llama3.2",
    "groq": "llama-3.1-8b-instant",
    "gemini": "gemini-3.6-flash",
}


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    smart_error_ai_provider = fields.Selection(
        selection=[
            ("ollama", "Ollama (local, free)"),
            ("groq", "Groq (free API key)"),
            ("gemini", "Google Gemini (free API key)"),
            ("disabled", "Disabled"),
        ],
        string="Smart Error AI Provider",
        config_parameter="smart_error.ai_provider",
        default="ollama",
    )
    smart_error_ai_model = fields.Char(
        string="Smart Error AI Model",
        config_parameter="smart_error.ai_model",
        default="llama3.2",
        help="Ollama: llama3.2 | Groq: llama-3.1-8b-instant | Gemini: gemini-3.6-flash",
    )
    smart_error_ai_api_key = fields.Char(
        string="Smart Error AI API Key",
        config_parameter="smart_error.ai_api_key",
        help="Required for Groq and Gemini. Not needed for Ollama.",
    )
    smart_error_ai_ollama_url = fields.Char(
        string="Ollama URL",
        config_parameter="smart_error.ai_ollama_url",
        default="http://127.0.0.1:11434",
    )
    smart_error_ai_auto = fields.Boolean(
        string="Auto-explain errors with AI",
        config_parameter="smart_error.ai_auto",
        default=True,
        help="When enabled, Smart Error asks the AI as soon as the dialog opens.",
    )

    @api.onchange("smart_error_ai_provider")
    def _onchange_smart_error_ai_provider(self):
        provider = self.smart_error_ai_provider
        default_model = PROVIDER_DEFAULT_MODELS.get(provider)
        if not default_model:
            return
        current = (self.smart_error_ai_model or "").strip().lower()
        known = {m.lower() for m in PROVIDER_DEFAULT_MODELS.values()}
        # Reset when empty or still set to another provider's default
        if not current or current in known:
            self.smart_error_ai_model = default_model
