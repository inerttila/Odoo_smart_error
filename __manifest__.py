# -*- coding: utf-8 -*-
{
    "name": "Smart Error",
    "version": "17.0.1.1.0",
    "category": "Extra Tools",
    "summary": "Enriched error dialogs with module context and free AI explanation",
    "author": "Commprog",
    "license": "LGPL-3",
    "depends": ["web", "base_setup"],
    "data": [
        "data/ir_config_parameter.xml",
        "views/res_config_settings_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "smart_error/static/src/smart_error_analyzer.js",
            "smart_error/static/src/smart_error_dialog.js",
            "smart_error/static/src/smart_error_dialog.xml",
            "smart_error/static/src/smart_error_dialog.scss",
            "smart_error/static/src/smart_error_handler.js",
        ],
    },
    "installable": True,
    "application": False,
    "auto_install": False,
}
