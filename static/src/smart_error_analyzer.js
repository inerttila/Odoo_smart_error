/** @odoo-module **/

const FRAMEWORK_MODULES = new Set([
    "web",
    "web_enterprise",
    "owl",
    "@odoo",
]);

const CLIENT_NOISE_PATH_RE = /\/(?:web|web_enterprise|@odoo)\/|\/lib\/|\/owl\./i;

/**
 * @typedef {Object} SmartErrorAnalysis
 * @property {"client"|"server"} source
 * @property {string} title
 * @property {string} message
 * @property {string|null} hint
 * @property {string|null} module
 * @property {string|null} model
 * @property {string|null} field
 * @property {string|null} functionName
 * @property {string|null} file
 * @property {string|null} property
 * @property {string|null} errorKind
 * @property {string|null} traceback
 * @property {boolean} moduleUncertain
 */

/**
 * Walk Error.cause to the deepest Error in the chain.
 * @param {any} error
 * @returns {any}
 */
export function deepestError(error) {
    let current = error;
    while (current instanceof Error && "cause" in current && current.cause) {
        current = current.cause;
    }
    return current;
}

/**
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
function firstMatch(text, regex, group = 1) {
    if (!text) {
        return null;
    }
    const match = text.match(regex);
    return match ? match[group] : null;
}

/** Normalize Windows/Unix path separators for matching. */
function normPath(path) {
    return (path || "").replace(/\\/g, "/");
}

const CORE_PYTHON_NOISE_RE =
    /\/odoo\/(?:http|service|api|modules|tools|osv|cli)\.py$|\/odoo\/(?:http|service|modules|tools|addons\/base)\//i;

const CORE_MODULES = new Set([
    "odoo",
    "base",
    "web",
    "mail",
    "http",
    "werkzeug",
]);

/**
 * Extract Odoo addon technical name from a JS or Python path.
 * @param {string} path
 * @returns {string|null}
 */
export function moduleFromPath(path) {
    if (!path) {
        return null;
    }
    const p = normPath(path);
    const staticMatch = p.match(/\/([^/]+)\/static\//);
    if (staticMatch) {
        return staticMatch[1];
    }
    // Prefer .../<module>/models|wizard|... (custom addons)
    const pyMatch = p.match(/\/([^/]+)\/(?:models|wizard|wizards|controllers|report|reports)\//);
    if (pyMatch && pyMatch[1] !== "odoo") {
        return pyMatch[1];
    }
    // .../addons/<module>/ or .../base/<module>/ (enterprise layout)
    const addonsMatch = p.match(/\/(?:addons|base)\/([^/]+)\//);
    if (addonsMatch) {
        return addonsMatch[1];
    }
    // Lazy assets: /web/assets/<hash>/web_studio.min.js
    const assetBundle = p.match(/\/web\/assets\/[^/]+\/([a-z0-9_]+?)(?:\.min)?\.js(?:\?|$)/i);
    if (assetBundle) {
        const name = assetBundle[1];
        if (!["web", "web_enterprise", "webclient", "assets_web", "assets_backend", "assets_common"].includes(name)) {
            return name;
        }
    }
    return null;
}

/**
 * Parse Python traceback frames: File "...", line N, in func
 * @param {string} debug
 * @returns {{file: string, line: string|null, functionName: string, module: string|null, isCore: boolean}[]}
 */
export function parsePythonFrames(debug) {
    if (!debug) {
        return [];
    }
    const frames = [];
    const re = /File ["']([^"']+)["'], line (\d+), in (\w+)/g;
    let match;
    while ((match = re.exec(debug)) !== null) {
        const file = match[1];
        const p = normPath(file);
        const module = moduleFromPath(file);
        const isCore =
            CORE_PYTHON_NOISE_RE.test(p) ||
            /\/odoo\/(?:models|fields|sql_db)\.py$/i.test(p) ||
            (module && CORE_MODULES.has(module));
        frames.push({
            file,
            line: match[2],
            functionName: match[3],
            module,
            isCore,
        });
    }
    return frames;
}

/**
 * Pick the most useful frame: last non-core addon frame, else last frame before the exception.
 * @param {{file: string, line: string|null, functionName: string, module: string|null, isCore: boolean}[]} frames
 */
function pickBestPythonFrame(frames) {
    if (!frames.length) {
        return null;
    }
    for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        if (!f.isCore && f.module && !CORE_MODULES.has(f.module)) {
            return f;
        }
    }
    for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        if (!f.isCore && f.module) {
            return f;
        }
    }
    // Prefer fields.determine / _compute_field_value over http._serve_db
    const interesting = [...frames]
        .reverse()
        .find((f) =>
            /(?:fields|models)\.py$/i.test(normPath(f.file)) ||
            /^(?:determine|_compute_field_value|create|write|unlink|read)$/.test(f.functionName)
        );
    return interesting || frames[frames.length - 1];
}

/**
 * True if string looks like an Odoo model technical name (not a Windows username path fragment).
 * @param {string|null} name
 */
function isLikelyModelName(name) {
    if (!name || !name.includes(".")) {
        return false;
    }
    // Reject path fragments like i.tila, Users.foo
    if (/^(?:i|c|d|users|documents|program|windows|appdata)\./i.test(name)) {
        return false;
    }
    // Odoo models: letters/underscores on both sides, e.g. helpdesk.ticket, sale.order
    return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(name);
}

/**
 * @param {string|null|undefined} stack
 * @returns {{module: string|null, file: string|null, functionName: string|null, moduleUncertain: boolean}}
 */
export function analyzeClientStack(stack) {
    if (!stack) {
        return { module: null, file: null, functionName: null, moduleUncertain: true };
    }

    const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
    let bestModule = null;
    let bestFile = null;
    let functionName = null;
    let moduleUncertain = true;

    for (const line of lines) {
        if (!functionName) {
            const fn =
                firstMatch(line, /(?:at\s+)?(?:async\s+)?(get\s+[\w$]+|set\s+[\w$]+|[\w$.]+)\s*(?:\(|@)/) ||
                firstMatch(line, /^([\w$.]+)\s*@/);
            if (fn && !fn.startsWith("http") && fn !== "Object" && fn !== "Array") {
                functionName = fn.replace(/^Object\./, "");
            }
        }

        const url =
            firstMatch(line, /\((https?:\/\/[^)]+)\)/) ||
            firstMatch(line, /(https?:\/\/\S+)/) ||
            firstMatch(line, /(\/[^\s:)]+\.(?:js|ts|xml|py))/);

        if (!url) {
            continue;
        }

        const cleanUrl = url.split("?")[0];
        const mod = moduleFromPath(cleanUrl);
        const isBundle = /\/web\/assets\/[^/]+\//.test(cleanUrl) || /\.min\.js$/.test(cleanUrl);
        const isNoise = CLIENT_NOISE_PATH_RE.test(cleanUrl);

        if (mod && !isNoise && !FRAMEWORK_MODULES.has(mod)) {
            bestModule = mod;
            bestFile = cleanUrl;
            // Bundle names (web_studio.min.js) are useful but less precise than /module/static/
            moduleUncertain = isBundle && !/\/[^/]+\/static\//.test(cleanUrl);
            break;
        }

        if (!bestModule && mod && !isBundle) {
            bestModule = mod;
            bestFile = cleanUrl;
            moduleUncertain = FRAMEWORK_MODULES.has(mod);
        } else if (!bestFile && isBundle) {
            bestFile = cleanUrl;
            if (mod && !bestModule) {
                bestModule = mod;
            }
            moduleUncertain = true;
        }
    }

    return { module: bestModule, file: bestFile, functionName, moduleUncertain };
}

/**
 * @param {string|null|undefined} name
 * @param {string|null|undefined} message
 * @returns {{errorKind: string|null, property: string|null, hint: string|null}}
 */
export function analyzeClientMessage(name, message) {
    const text = `${name || ""} ${message || ""}`;
    let errorKind = name || null;
    let property = null;
    let hint = null;

    if (/SyntaxError/i.test(text)) {
        errorKind = "SyntaxError";
        hint = "A JavaScript syntax error was detected. Check recently edited client code for typos or invalid syntax.";
    } else if (/is not iterable/i.test(text)) {
        errorKind = "TypeError";
        property = firstMatch(text, /([\w$]+)\s+is not iterable/i) ||
            firstMatch(text, /\.([\w$]+)\s+is not iterable/i);
        hint = property
            ? `"${property}" is not a list/iterable. It is likely undefined, null, or the wrong type.`
            : "A value that should be a list/iterable is undefined, null, or the wrong type.";
    } else if (/Cannot read propert(?:y|ies) of (undefined|null)/i.test(text)) {
        errorKind = "TypeError";
        property = firstMatch(text, /Cannot read propert(?:y|ies) ['"]?([\w$]+)/i);
        const ofWhat = firstMatch(text, /of (undefined|null)/i);
        hint = property
            ? `Tried to read "${property}" on ${ofWhat || "an empty value"}. A required object is missing.`
            : `Tried to read a property on ${ofWhat || "an empty value"}. A required object is missing.`;
    } else if (/Cannot set propert(?:y|ies) of (undefined|null)/i.test(text)) {
        errorKind = "TypeError";
        property = firstMatch(text, /Cannot set propert(?:y|ies) ['"]?([\w$]+)/i);
        hint = property
            ? `Tried to set "${property}" on an empty value. Initialize the object before assigning.`
            : "Tried to set a property on an empty value.";
    } else if (/is not a function/i.test(text)) {
        errorKind = "TypeError";
        property = firstMatch(text, /([\w$.]+)\s+is not a function/i);
        hint = property
            ? `"${property}" is not a function. Check the method name or that the object is the expected type.`
            : "A value was called as a function but is not callable.";
    } else if (/is not defined/i.test(text)) {
        errorKind = "ReferenceError";
        property = firstMatch(text, /([\w$]+)\s+is not defined/i);
        hint = property
            ? `"${property}" is not defined. Check imports, spelling, or scope.`
            : "A variable or function name is not defined.";
    } else if (/OwlError|owl lifecycle/i.test(text)) {
        errorKind = "OwlError";
        hint = "An error occurred while rendering an Owl component. See the root cause below for the real issue.";
    } else if (/TypeError/i.test(text)) {
        errorKind = "TypeError";
        hint = "A value has the wrong type for the operation being performed.";
    }

    return { errorKind, property, hint };
}

/**
 * @param {object|null|undefined} data
 * @param {string|null|undefined} exceptionName
 * @param {string|null|undefined} message
 * @returns {SmartErrorAnalysis}
 */
export function analyzeRpcError(data, exceptionName, message) {
    const debug = data?.debug || "";
    const serverMessage =
        (data?.arguments && data.arguments.length && data.arguments[0]) ||
        data?.message ||
        message ||
        "";
    const combined = `${serverMessage}\n${debug}`;

    let shortName = exceptionName ? exceptionName.split(".").pop() : null;
    if (!shortName) {
        shortName =
            firstMatch(combined, /\b(AttributeError|TypeError|ValueError|KeyError|NameError|ValidationError|UserError|AccessError)\b/) ||
            "ServerError";
    }

    let title = "Smart Error";
    if (shortName === "ValidationError") {
        title = "Validation Error";
    } else if (shortName === "UserError") {
        title = "Invalid Operation";
    } else if (shortName === "AccessError") {
        title = "Access Error";
    } else if (shortName === "AccessDenied") {
        title = "Access Denied";
    } else if (shortName === "MissingError") {
        title = "Missing Record";
    } else if (shortName === "AttributeError") {
        title = "Missing Method / Attribute";
    } else if (shortName) {
        title = shortName;
    }

    // AttributeError: 'helpdesk.ticket' object has no attribute '_compute_...'
    const attrModel = firstMatch(
        combined,
        /['"]([a-z][a-z0-9_.]*)['"] object has no attribute ['"]([a-zA-Z_][\w]*)['"]/i,
        1
    );
    const attrName = firstMatch(
        combined,
        /['"]([a-z][a-z0-9_.]*)['"] object has no attribute ['"]([a-zA-Z_][\w]*)['"]/i,
        2
    );

    let model =
        data?.model ||
        data?.context?.model ||
        (isLikelyModelName(attrModel) ? attrModel : null) ||
        firstMatch(serverMessage, /\bmodel\s+['"]([a-z0-9_.]+)['"]/i);

    const envModel = firstMatch(debug, /env\[(?:u)?['"]([a-z0-9_.]+)['"]\]/);
    if (!model && isLikelyModelName(envModel)) {
        model = envModel;
    }
    if (model && !isLikelyModelName(model)) {
        model = isLikelyModelName(attrModel) ? attrModel : null;
    }

    let field =
        data?.context?.field ||
        data?.context?.field_name ||
        firstMatch(serverMessage, /Invalid field ['"]?([a-z0-9_.]+)['"]?/i) ||
        firstMatch(serverMessage, /unknown field ['"]?([a-z0-9_.]+)['"]?/i) ||
        firstMatch(serverMessage, /The following fields? are invalid[:\s]+([a-z0-9_,\s]+)/i) ||
        firstMatch(debug, /Invalid field ['"]?([a-z0-9_.]+)['"]?/i);

    if (field && field.includes(",")) {
        field = field.split(",")[0].trim();
    }

    // Infer field from missing compute method only when name looks complete
    // (avoid turning typos like _compute_total_hours_spent_x into a fake field).
    let property = attrName || null;
    let functionName = null;
    if (attrName && /^_?[a-zA-Z]\w*$/.test(attrName)) {
        functionName = attrName;
    }

    const frames = parsePythonFrames(debug);
    const bestFrame = pickBestPythonFrame(frames);

    let module = bestFrame?.module || null;
    if (!module) {
        for (let i = frames.length - 1; i >= 0; i--) {
            if (frames[i].module && !CORE_MODULES.has(frames[i].module)) {
                module = frames[i].module;
                break;
            }
        }
    }

    let file = bestFrame?.file || null;
    if (!functionName && bestFrame?.functionName) {
        functionName = bestFrame.functionName;
    }

    let hint = null;
    if (attrName && /^_compute_/.test(attrName)) {
        hint =
            `The field compute method "${attrName}" does not exist on model "${model || "unknown"}".`;
    } else if (attrName) {
        hint =
            `Object "${model || "unknown"}" has no attribute/method "${attrName}". ` +
            `It was renamed, deleted, or never defined.`;
    } else if (shortName === "ValidationError") {
        hint = field
            ? `A validation rule failed on field "${field}". Check the value entered for that field.`
            : "A validation rule failed. Check the highlighted or mentioned fields and their values.";
    } else if (shortName === "UserError") {
        hint = "The server rejected the operation. Read the message above for the business reason.";
    } else if (shortName === "AccessError" || shortName === "AccessDenied") {
        hint = "The current user does not have the required access rights for this operation.";
    } else if (shortName === "MissingError") {
        hint = "A record was expected but no longer exists (deleted or wrong id).";
    } else if (debug) {
        hint = "A server-side exception occurred. Open details for the Python traceback.";
    }

    return {
        source: "server",
        title,
        message: String(serverMessage),
        hint,
        module,
        model,
        field,
        functionName,
        file,
        property,
        errorKind: shortName,
        traceback: null,
        moduleUncertain: false,
    };
}

/**
 * Analyze a client-side uncaught error.
 * @param {object} uncaughtError
 * @param {any} originalError
 * @returns {SmartErrorAnalysis}
 */
export function analyzeClientError(uncaughtError, originalError) {
    const root = deepestError(originalError) || originalError;
    const name = root?.name || uncaughtError?.name || "Error";
    const message = root?.message || uncaughtError?.message || "";
    const stack = root?.stack || uncaughtError?.traceback || "";

    const stackInfo = analyzeClientStack(stack || uncaughtError?.traceback);
    const msgInfo = analyzeClientMessage(name, message);

    let hint = msgInfo.hint;
    if (stackInfo.moduleUncertain && !stackInfo.module) {
        const assetsHint =
            "Module could not be determined from the minified bundle. Open with ?debug=assets for precise file paths.";
        hint = hint ? `${hint} ${assetsHint}` : assetsHint;
    }

    return {
        source: "client",
        title: "Smart Error",
        message: String(message),
        hint,
        module: stackInfo.module,
        model: null,
        field: null,
        functionName: stackInfo.functionName,
        file: stackInfo.file,
        property: msgInfo.property,
        errorKind: msgInfo.errorKind || name,
        traceback: uncaughtError?.traceback || stack,
        moduleUncertain: stackInfo.moduleUncertain,
    };
}

/**
 * Build clipboard text including smart summary.
 * @param {SmartErrorAnalysis} analysis
 * @param {string|null|undefined} traceback
 */
export function formatClipboard(analysis, traceback) {
    const lines = [
        `Smart Error (${analysis.source})`,
        analysis.title,
        analysis.message,
    ];
    if (analysis.errorKind) {
        lines.push(`Kind: ${analysis.errorKind}`);
    }
    if (analysis.module) {
        lines.push(`Module: ${analysis.module}${analysis.moduleUncertain ? " (uncertain)" : ""}`);
    }
    if (analysis.model) {
        lines.push(`Model: ${analysis.model}`);
    }
    if (analysis.field) {
        lines.push(`Field: ${analysis.field}`);
    }
    if (analysis.functionName) {
        lines.push(`Function: ${analysis.functionName}`);
    }
    if (analysis.property) {
        lines.push(`Property: ${analysis.property}`);
    }
    if (analysis.file) {
        lines.push(`File: ${analysis.file}`);
    }
    if (analysis.hint) {
        lines.push(`Hint: ${analysis.hint}`);
    }
    if (traceback) {
        lines.push("", traceback);
    }
    return lines.join("\n");
}
