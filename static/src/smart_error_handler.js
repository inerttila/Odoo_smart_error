/** @odoo-module **/

import { registry } from "@web/core/registry";
import { ConnectionLostError, RPCError } from "@web/core/network/rpc_service";
import {
    UncaughtClientError,
    UncaughtPromiseError,
} from "@web/core/errors/error_service";
import { WarningDialog } from "@web/core/errors/error_dialogs";
import { SmartErrorDialog } from "@smart_error/smart_error_dialog";
import { analyzeClientError, analyzeRpcError } from "@smart_error/smart_error_analyzer";

const errorHandlerRegistry = registry.category("error_handlers");
const errorDialogRegistry = registry.category("error_dialogs");
const errorNotificationRegistry = registry.category("error_notifications");

/** Exception keys we enrich (core maps these to WarningDialog). */
const SMART_WARNING_EXCEPTIONS = [
    "odoo.exceptions.UserError",
    "odoo.exceptions.ValidationError",
    "odoo.exceptions.AccessError",
    "odoo.exceptions.AccessDenied",
    "odoo.exceptions.MissingError",
    "odoo.exceptions.Warning",
];

/**
 * True when core would show a specialized dialog/notification we must not replace.
 * @param {RPCError} originalError
 */
function hasSpecializedRpcUi(originalError) {
    if (originalError.Component) {
        return true;
    }
    const exceptionName = originalError.exceptionName;
    if (exceptionName) {
        if (errorNotificationRegistry.contains(exceptionName)) {
            return true;
        }
        if (errorDialogRegistry.contains(exceptionName)) {
            const Comp = errorDialogRegistry.get(exceptionName);
            // Leave RedirectWarning, SessionExpired, custom addons, etc. alone.
            // SmartErrorDialog / WarningDialog for known warning exceptions are ours.
            if (Comp === SmartErrorDialog || Comp === WarningDialog) {
                return false;
            }
            return true;
        }
    }
    const exceptionClass = originalError.data?.context?.exception_class;
    if (exceptionClass && errorDialogRegistry.contains(exceptionClass)) {
        const Comp = errorDialogRegistry.get(exceptionClass);
        if (Comp !== SmartErrorDialog && Comp !== WarningDialog) {
            return true;
        }
    }
    return false;
}

/**
 * @param {import("@web/env").OdooEnv} env
 * @param {*} error
 * @param {Error} originalError
 * @returns {boolean}
 */
export function smartErrorHandler(env, error, originalError) {
    // ----- Server RPC -----
    if (error instanceof UncaughtPromiseError && originalError instanceof RPCError) {
        if (hasSpecializedRpcUi(originalError)) {
            return false;
        }
        error.unhandledRejectionEvent?.preventDefault();

        const analysis = analyzeRpcError(
            originalError.data,
            originalError.exceptionName,
            originalError.message
        );
        env.services.dialog.add(SmartErrorDialog, {
            traceback: error.traceback,
            message: originalError.message,
            name: originalError.name,
            exceptionName: originalError.exceptionName,
            data: originalError.data,
            subType: originalError.subType,
            code: originalError.code,
            type: originalError.type,
            analysis,
        });
        return true;
    }

    // ----- Client JS -----
    if (
        (error instanceof UncaughtClientError || error instanceof UncaughtPromiseError) &&
        !(originalError instanceof RPCError) &&
        !(originalError instanceof ConnectionLostError)
    ) {
        const analysis = analyzeClientError(error, originalError);
        env.services.dialog.add(SmartErrorDialog, {
            traceback: error.traceback,
            message: error.message,
            name: error.name,
            analysis,
        });
        return true;
    }

    return false;
}

errorHandlerRegistry.add("smartErrorHandler", smartErrorHandler, { sequence: 96 });

for (const exceptionName of SMART_WARNING_EXCEPTIONS) {
    errorDialogRegistry.add(exceptionName, SmartErrorDialog, { force: true });
}
