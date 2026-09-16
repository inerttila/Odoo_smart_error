/** @odoo-module **/

import { Component, onMounted, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { standardErrorDialogProps } from "@web/core/errors/error_dialogs";
import {
    analyzeRpcError,
    formatClipboard,
} from "@smart_error/smart_error_analyzer";

export class SmartErrorDialog extends Component {
    setup() {
        this.rpc = useService("rpc");
        this.notification = useService("notification");
        this.state = useState({
            showTraceback: false,
            aiLoading: false,
            aiExplanation: null,
            aiCommand: null,
            aiError: null,
        });
        this.analysis = this.props.analysis || this._buildAnalysisFromProps();
        this.traceback = this.props.traceback || null;

        if (this.props.data && this.props.data.debug) {
            const clientTb = this.traceback || "";
            this.traceback = `${this.props.data.debug}\nThe above server error caused the following client error:\n${clientTb}`;
        }

        onMounted(() => {
            this.explainWithAi({ auto: true });
        });
    }

    _buildAnalysisFromProps() {
        return analyzeRpcError(this.props.data, this.props.exceptionName, this.props.message);
    }

    get title() {
        return this.analysis?.title || this.constructor.title;
    }

    get rows() {
        const a = this.analysis || {};
        const rows = [];
        rows.push({
            label: _t("Source"),
            value: a.source === "server" ? _t("Server") : _t("Client JS"),
        });
        if (a.errorKind) {
            rows.push({ label: _t("Kind"), value: a.errorKind });
        }
        if (a.module) {
            rows.push({
                label: _t("Module"),
                value: a.moduleUncertain ? `${a.module} (${_t("uncertain")})` : a.module,
            });
        } else if (a.source === "client" && a.moduleUncertain) {
            rows.push({ label: _t("Module"), value: _t("unknown — enable debug=assets") });
        }
        if (a.model) {
            rows.push({ label: _t("Model"), value: a.model });
        }
        if (a.field) {
            rows.push({ label: _t("Field"), value: a.field });
        }
        if (a.functionName) {
            const fnLabel =
                a.errorKind === "AttributeError" ? _t("Missing method") : _t("Function");
            rows.push({ label: fnLabel, value: a.functionName });
        }
        if (a.property && a.property !== a.functionName) {
            rows.push({ label: _t("Property"), value: a.property });
        }
        if (a.file) {
            const shortFile = a.file.replace(/^.*[\\/](addons|base|odoo)[\\/]/i, "$1/");
            rows.push({ label: _t("File"), value: shortFile || a.file });
        }
        return rows;
    }

    onClickClipboard() {
        let text = formatClipboard(this.analysis, this.traceback);
        if (this.state.aiExplanation) {
            text += `\n\nAI explanation:\n${this.state.aiExplanation}`;
        }
        if (this.state.aiCommand) {
            text += `\n\nSuggested command:\n${this.state.aiCommand}`;
        }
        browser.navigator.clipboard.writeText(text);
    }

    onClickCopyCommand() {
        if (!this.state.aiCommand) {
            return;
        }
        browser.navigator.clipboard.writeText(this.state.aiCommand);
        this.notification.add(_t("Command copied"), { type: "success" });
    }

    async explainWithAi({ auto = false } = {}) {
        if (this.state.aiLoading) {
            return;
        }
        this.state.aiLoading = true;
        this.state.aiError = null;
        if (!auto) {
            this.state.aiExplanation = null;
            this.state.aiCommand = null;
        }
        try {
            const result = await this.rpc("/smart_error/explain", {
                analysis: this.analysis,
                traceback: this.traceback || this.props.traceback || null,
                message: this.props.message || this.analysis?.message || null,
                auto,
            });
            if (result?.skipped) {
                return;
            }
            if (result?.ok) {
                this.state.aiExplanation = result.explanation;
                this.state.aiCommand = result.command || null;
                this.state.aiError = null;
            } else {
                this.state.aiError = result?.error || _t("AI explanation failed.");
            }
        } catch (e) {
            this.state.aiError = e?.message || String(e);
        } finally {
            this.state.aiLoading = false;
        }
    }
}

SmartErrorDialog.template = "smart_error.SmartErrorDialog";
SmartErrorDialog.components = { Dialog };
SmartErrorDialog.title = _t("Smart Error");
SmartErrorDialog.props = {
    ...standardErrorDialogProps,
    analysis: { type: Object, optional: true },
};
