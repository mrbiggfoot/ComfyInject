import { MARKER_REGEX, processAllImageMarkers, hasImageMarker } from "./parse.js";
import { generateImage } from "./comfy.js";
import { saveLastSeed, getImageData } from "./state.js";
import { MODULE_NAME } from "../settings.js";

// Maximum rendered size of an image's longest side.
// Clicking an image toggles between this cap and its original size.
const MAX_DISPLAY_SIDE = "512px";

/**
 * Builds the <img> tag string that gets injected into the message.
 * Stores prompt and seed as data attributes for outbound.js to read.
 * @param {string} imageUrl - The full ComfyUI /view URL
 * @param {string} prompt - The raw prompt returned by generateImage()
 * @param {number} seed - The resolved seed used for generation
 * @returns {string} The HTML img tag string
 */
function buildImgTag(imageUrl, prompt, seed) {
    return `<img class="comfyinject-image" src="${imageUrl}" data-prompt="${prompt.replace(/"/g, '&quot;')}" data-seed="${seed}" />`;
}

/**
 * Finds the current array index of a message by its send_date.
 * @param {string} sendDate - The send_date to look for
 * @returns {number} The current index, or -1 if not found
 */
function findIndexBySendDate(sendDate) {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        if (context.chat[i].send_date === sendDate) return i;
    }
    return -1;
}

/**
 * Returns the current marker repair toast mode.
 * @returns {"all" | "failures" | "off"}
 */
function getRepairToastMode() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME]?.repair_toast_mode || "failures";
}

/**
 * Returns true if a repairMeta object contains any meaningful repair info.
 * Non-canonical formatting alone does not count unless something was actually
 * defaulted, ignored, or flagged.
 * @param {object|null} repairMeta
 * @returns {boolean}
 */
function hasMeaningfulRepair(repairMeta) {
    if (!repairMeta || typeof repairMeta !== "object") return false;

    const defaulted = Array.isArray(repairMeta.defaulted) ? repairMeta.defaulted : [];
    const duplicateTokens = repairMeta.duplicateTokens || {};

    const duplicateAr = Array.isArray(duplicateTokens.AR) ? duplicateTokens.AR : [];
    const duplicateShot = Array.isArray(duplicateTokens.SHOT) ? duplicateTokens.SHOT : [];
    const duplicateSeed = Array.isArray(duplicateTokens.SEED) ? duplicateTokens.SEED : [];

    return (
        defaulted.length > 0 ||
        duplicateAr.length > 0 ||
        duplicateShot.length > 0 ||
        duplicateSeed.length > 0 ||
        repairMeta.possibleSeedInPrompt === true
    );
}

/**
 * Shows a grouped repair toast for one live-rendered message.
 * This is only used for successful repaired markers.
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeShowGroupedRepairToast(repairedCount, totalCount) {
    if (getRepairToastMode() !== "all") return;
    if (repairedCount <= 0) return;

    toastr.warning(
        `Repaired ${repairedCount}/${totalCount} markers in this message. See Image Gallery for details.`,
        "ComfyInject"
    );
}

/**
 * Logs a grouped repair warning for one live-rendered message.
 * This mirrors the user-facing grouped repair toast.
 * @param {number} messageIndex
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeLogGroupedRepairWarning(messageIndex, repairedCount, totalCount) {
    if (getRepairToastMode() !== "all") return;
    if (repairedCount <= 0) return;

    console.warn("[ComfyInject] Repaired markers in message:", {
        messageIndex,
        repairedCount,
        totalCount,
    });
}

/**
 * Shows a parse-failure toast based on the user's marker repair toast setting.
 * @param {string} errorText
 */
function maybeShowParseFailureToast(errorText) {
    const mode = getRepairToastMode();
    if (mode === "off") return;

    toastr.warning(errorText, "ComfyInject");
}

/**
 * Shows one bulk-scan repair summary toast after scanning old messages.
 * This avoids spamming one toast per message during chat load.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers) {
    if (getRepairToastMode() !== "all") return;
    if (repairedMarkers <= 0) return;

    toastr.warning(
        `Repaired ${repairedMarkers} markers across ${repairedMessages} existing messages. See Image Gallery for details.`,
        "ComfyInject"
    );
}

/**
 * Logs one bulk-scan repair summary warning after scanning old messages.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers) {
    if (getRepairToastMode() !== "all") return;
    if (repairedMarkers <= 0) return;

    console.warn("[ComfyInject] Repaired markers during bulk scan:", {
        repairedMessages,
        repairedMarkers,
    });
}

/**
 * Formats a marker position label within a message.
 * Only includes numbering when the message had multiple markers.
 * @param {number} markerNumber - 1-based marker number within the message
 * @param {number} totalMarkers - Total markers in the message
 * @returns {string}
 */
function formatMarkerPosition(markerNumber, totalMarkers) {
    return totalMarkers > 1 ? ` ${markerNumber}/${totalMarkers}` : "";
}

/**
 * Caps the displayed size of a rendered image so the longest side
 * never exceeds MAX_DISPLAY_SIDE. Display-only: the saved message
 * and the file on disk are never touched.
 * @param {HTMLElement} img - The image element
 */
function capImageDisplaySize(img) {
    img.style.maxWidth = MAX_DISPLAY_SIDE;
    img.style.maxHeight = MAX_DISPLAY_SIDE;
    img.style.width = "auto";
    img.style.height = "auto";
    img.style.cursor = "zoom-in";
}

/**
 * Opens a full-browser-window overlay showing the given image at its
 * original size. The width is capped to the window width only when the
 * image is wider than the window; otherwise the original size is kept,
 * even if the height exceeds the window (the overlay scrolls).
 * Closes on click or Escape.
 * @param {string} src - The image URL to display
 */
function openFullImage(src) {
    closeFullImage();

    const overlay = document.createElement("div");
    overlay.id = "comfyinject-fullimage-overlay";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.85); z-index: 9999;
        display: flex; overflow: auto; cursor: zoom-out;
    `;

    const fullImg = document.createElement("img");
    fullImg.src = src;
    // Width-only cap: max-width resolves against the window, so the image
    // is scaled only when wider than the window. Height stays original and
    // the overlay scrolls. margin: auto centers the image when it fits and
    // keeps the top edge reachable when it overflows.
    fullImg.style.cssText = "max-width: 100%; max-height: none; width: auto; height: auto; margin: auto;";

    const escHandler = (e) => {
        if (e.key === "Escape") closeFullImage();
    };
    overlay._escHandler = escHandler;

    overlay.addEventListener("click", closeFullImage);
    document.addEventListener("keydown", escHandler);

    overlay.appendChild(fullImg);
    document.body.appendChild(overlay);
}

/**
 * Closes the full-image overlay if it is open.
 */
function closeFullImage() {
    const overlay = document.getElementById("comfyinject-fullimage-overlay");
    if (!overlay) return;
    if (overlay._escHandler) {
        document.removeEventListener("keydown", overlay._escHandler);
    }
    overlay.remove();
}

/**
 * Adds retry buttons to all rendered comfyinject images in a message.
 * This is done via DOM manipulation (not in message.mes) because
 * ST's HTML sanitizer strips custom divs when rendering messages.
 * Each button stores send_date and imgindex for the retry handler.
 * @param {number} index - The current message array index (for DOM lookup via mesid)
 */
function addRetryButtons(index) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    if (!message) return;

    const messageNode = document.querySelector(`[mesid="${index}"]`);
    if (!messageNode) return;

    // ST's sanitizer prefixes custom classes with "custom-" in the rendered DOM
    const images = messageNode.querySelectorAll(".custom-comfyinject-image");
    if (images.length === 0) return;

    const sendDate = message.send_date;

    images.forEach((img, imgIndex) => {
        // Don't add a second retry button if one already exists
        if (img.parentElement?.querySelector(".comfyinject-retry")) return;

        // Wrap the image in a relative container so we can position the button
        const wrapper = document.createElement("div");
        wrapper.className = "comfyinject-wrapper";
        wrapper.style.cssText = "position: relative; display: inline-block;";
        img.parentElement.insertBefore(wrapper, img);
        wrapper.appendChild(img);

        // Cap the displayed size and open a full-window view on click
        capImageDisplaySize(img);
        img.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            openFullImage(img.src);
        });

        // Create the retry button
        const btn = document.createElement("div");
        btn.className = "comfyinject-retry";
        btn.dataset.senddate = sendDate;
        btn.dataset.imgindex = imgIndex;
        btn.title = "Regenerate with new seed";
        btn.style.cssText = "position: absolute; top: 6px; right: 6px; cursor: pointer; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; z-index: 10;";
        btn.innerHTML = `<i class="fa-solid fa-rotate"></i>`;

        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            e.preventDefault();
            await retryImage(sendDate, imgIndex);
        });

        wrapper.appendChild(btn);

        // Create the image settings button (gear) next to the retry button
        const settingsBtn = document.createElement("div");
        settingsBtn.className = "comfyinject-image-settings";
        settingsBtn.dataset.senddate = sendDate;
        settingsBtn.dataset.imgindex = imgIndex;
        settingsBtn.title = "Edit prompt and orientation";
        settingsBtn.style.cssText = "position: absolute; top: 6px; right: 40px; cursor: pointer; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; z-index: 10;";
        settingsBtn.innerHTML = `<i class="fa-solid fa-gear"></i>`;

        settingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            openImageSettingsDialog(sendDate, imgIndex);
        });

        wrapper.appendChild(settingsBtn);

        // Create the left/right navigation buttons
        addNavButtons(wrapper, img, sendDate, imgIndex);
    });
}

/**
 * Resolves the metadata entry and version history array for one image.
 * Handles both metadata shapes (array of per-image entries, or a single
 * legacy object) and both keys (send_date, legacy message index).
 * @param {string} sendDate - The send_date of the message
 * @param {number} imgIndex - 0-based index of the image within the message
 * @returns {{metadata: object|null, metaKey: string|number, metaEntry: object|null, entry: object, history: Array<object>}}
 */
function resolveVersionMeta(sendDate, imgIndex) {
    const metadata = SillyTavern.getContext().chatMetadata[MODULE_NAME];
    if (!metadata) {
        return { metadata: null, metaKey: null, metaEntry: null, entry: {}, history: [] };
    }

    const messageIndex = findIndexBySendDate(sendDate);
    const metaKey = metadata[sendDate] ? sendDate : messageIndex;
    const metaEntry = metaKey === -1 ? null : metadata[metaKey] || null;

    let entry;
    if (Array.isArray(metaEntry)) {
        entry = metaEntry[imgIndex] && typeof metaEntry[imgIndex] === "object" ? metaEntry[imgIndex] : {};
    } else if (metaEntry && typeof metaEntry === "object") {
        entry = metaEntry;
    } else {
        entry = {};
    }

    const history = Array.isArray(entry.history) ? entry.history : [];

    return { metadata, metaKey, metaEntry, entry, history };
}

/**
 * Adds left/right navigation buttons, a delete button, and a position
 * counter to one image's wrapper.
 * The chevrons cycle through the versions of this image (the original
 * generation plus every result of its regenerate button) with wrap-around.
 * The trash button permanently removes the currently shown version from
 * the version history (disabled when only one version remains).
 * The counter shows the current version number and the total count.
 * Images from other markers in the message are never shown.
 * Navigation is display-only: only the visible <img> src changes,
 * the saved message and metadata are untouched, so the latest saved
 * version returns on the next re-render (swipe, edit, or reload).
 * Deletion is persistent: the metadata history is rewritten and saved.
 * While the image has a single version the chevrons do nothing and the
 * delete button is disabled.
 * @param {HTMLElement} wrapper - The image wrapper element
 * @param {HTMLElement} img - The image element to navigate
 * @param {string} sendDate - The send_date of the message
 * @param {number} imgIndex - 0-based index of this image in the message
 */
function addNavButtons(wrapper, img, sendDate, imgIndex) {
    // Display position within the version history. Starts on the latest
    // saved version; buttons are re-created on every re-render, which
    // resets this along with the restored <img> src.
    let displayIndex = -1;

    const navigate = (direction) => {
        const { history } = resolveVersionMeta(sendDate, imgIndex);
        if (history.length <= 1) return;

        if (displayIndex < 0) displayIndex = history.length - 1;
        const step = direction === "prev" ? -1 : 1;
        displayIndex = (displayIndex + step + history.length) % history.length;

        const version = history[displayIndex];
        if (version?.imageUrl) {
            img.src = version.imageUrl;
        }

        updateCounter();
    };

    const buttons = [
        { className: "comfyinject-nav-left", icon: "fa-chevron-left", direction: "prev", side: "left: 6px;", title: "Previous version" },
        { className: "comfyinject-nav-right", icon: "fa-chevron-right", direction: "next", side: "right: 6px;", title: "Next version" },
    ];

    for (const { className, icon, direction, side, title } of buttons) {
        const btn = document.createElement("div");
        btn.className = className;
        btn.title = title;
        btn.style.cssText = `position: absolute; top: 50%; ${side} transform: translateY(-50%); cursor: pointer; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; z-index: 10;`;
        btn.innerHTML = `<i class="fa-solid ${icon}"></i>`;

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            navigate(direction);
        });

        wrapper.appendChild(btn);
    }

    // Create the delete button (top-left corner)
    const deleteBtn = document.createElement("div");
    deleteBtn.className = "comfyinject-delete";
    deleteBtn.style.cssText = "position: absolute; top: 6px; left: 6px; cursor: pointer; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; z-index: 10;";
    deleteBtn.innerHTML = `<i class="fa-solid fa-trash-can"></i>`;

    const setDeleteEnabled = (enabled) => {
        deleteBtn.style.pointerEvents = enabled ? "auto" : "none";
        deleteBtn.style.opacity = enabled ? "1" : "0.4";
        deleteBtn.title = enabled ? "Delete this version" : "Only one version remains";
    };

    deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const { history } = resolveVersionMeta(sendDate, imgIndex);
        if (history.length <= 1) return;

        const index = displayIndex >= 0 ? Math.min(displayIndex, history.length - 1) : history.length - 1;
        const result = await deleteVersion(sendDate, imgIndex, index, img);
        if (!result) return;

        displayIndex = result.newIndex;
        updateCounter();
        setDeleteEnabled(result.total > 1);
    });

    wrapper.appendChild(deleteBtn);

    // Create the version counter (bottom-right corner)
    const counterEl = document.createElement("div");
    counterEl.className = "comfyinject-counter";
    counterEl.title = "Current version / total versions";
    counterEl.style.cssText = "position: absolute; bottom: 6px; right: 6px; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; z-index: 10;";

    const updateCounter = () => {
        const { history } = resolveVersionMeta(sendDate, imgIndex);
        const total = Math.max(history.length, 1);
        const position = displayIndex >= 0 ? Math.min(displayIndex, total - 1) : total - 1;
        counterEl.textContent = `${position + 1} / ${total}`;
    };

    wrapper.appendChild(counterEl);

    setDeleteEnabled(resolveVersionMeta(sendDate, imgIndex).history.length > 1);
    updateCounter();
}

/**
 * Adds retry buttons to all rendered comfyinject images across the entire chat.
 * Called after scanning existing messages on chat load.
 */
function addAllRetryButtons() {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        addRetryButtons(i);
    }
}

/**
 * Processes a single message by index.
 * If it contains [[IMG: ... ]] markers, generates the images sequentially,
 * injects <img> tags into both the DOM and the mes field,
 * saves metadata keyed by send_date, and calls saveChat().
 * @param {number} index - The message index in the chat array
 */
async function processMessage(index, options = {}) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    const { updateMessageBlock } = SillyTavern.getContext();
    const { suppressRepairNotifications = false } = options;

    if (!message) return { repairedCount: 0, totalCount: 0 };

    // Only process bot messages
    if (message.is_user) return { repairedCount: 0, totalCount: 0 };

    // Skip if no marker present
    if (!hasImageMarker(message.mes)) return { repairedCount: 0, totalCount: 0 };

    console.log(`[ComfyInject] Processing message ${index}`);

    // Count markers for the placeholder
    const markerCount = (message.mes.match(/\[\[IMG:\s*.+?\s*\]\]/gs) || []).length;

    // Show placeholders by patching mes temporarily
    const originalMes = message.mes;
    let placeholderIndex = 0;
    message.mes = message.mes.replace(/\[\[IMG:\s*.+?\s*\]\]/gs, () => {
        placeholderIndex++;
        return `<span class="comfyinject-pending">[Generating image ${placeholderIndex}/${markerCount}...]</span>`;
    });
    try {
        updateMessageBlock(index, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
    }
    message.mes = originalMes;

    // Process all markers sequentially
    const results = await processAllImageMarkers(message.mes, index);

    if (results.length === 0) return { repairedCount: 0, totalCount: 0 };

    // Replace each marker with either a generated image or a structured error state.
    // Only successful generations should be saved into metadata.
    const metadataArray = [];
    let repairedCount = 0;

    for (let markerIndex = 0; markerIndex < results.length; markerIndex++) {
        const result = results[markerIndex];
        const markerNumber = markerIndex + 1;
        const markerPosition = formatMarkerPosition(markerNumber, results.length);

        if (result?.status === "ok") {
            const {
                imageUrl,
                seed,
                prompt,
                ar,
                shot,
                promptId,
                filename,
                effectiveAr,
                effectiveShot,
                resolution,
                shotTags,
                repairMeta,
            } = result;

            if (hasMeaningfulRepair(repairMeta)) {
                repairedCount++;
            }

            const imgTag = buildImgTag(imageUrl, prompt, seed);
            message.mes = message.mes.replace(MARKER_REGEX, imgTag);
            metadataArray.push({
                seed,
                ar,
                shot,
                promptId,
                filename,
                effectiveAr,
                effectiveShot,
                resolution,
                shotTags,
                repairMeta,
                history: [
                    { seed, imageUrl, promptId, filename, prompt },
                ],
            });
        } else if (result?.status === "parse_error") {
            // The marker was found, but parsing could not recover a usable prompt.
            const reason = result?.reason;
            let errorText;
            switch (reason) {
                case "empty_prompt":
                    errorText = `[Image marker${markerPosition} invalid: empty prompt]`;
                    break;
                case "empty_marker":
                    errorText = `[Image marker${markerPosition} invalid: empty marker]`;
                    break;
                default:
                    errorText = `[Image marker${markerPosition} invalid]`;
                    break;
            }

            console.warn("[ComfyInject] Image marker parse failed:", {
                reason,
                rawMarker: result?.rawMarker || null,
                messageIndex: index,
                markerNumber,
                totalMarkers: results.length,
            });

            if (!suppressRepairNotifications) {
                maybeShowParseFailureToast(errorText);
            }

            message.mes = message.mes.replace(
                MARKER_REGEX,
                `<span class="comfyinject-error">${errorText}</span>`
            );
        } else if (result?.status === "generation_error") {
            // Marker parsed successfully, but image generation failed.
            const errorText = `[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]`;

            console.error("[ComfyInject] Image generation failed:", {
                messageIndex: index,
                markerNumber,
                totalMarkers: results.length,
            });

            message.mes = message.mes.replace(
                MARKER_REGEX,
                `<span class="comfyinject-error">${errorText}</span>`
            );
        } else {
            // Fallback guard for any unexpected result shape.
            const errorText = `[Image generation failed${markerPosition ?`: marker${markerPosition}` : ""}]`;

            console.error("[ComfyInject] Unexpected marker result shape:", {
                result,
                messageIndex: index,
                markerNumber,
                totalMarkers: results.length,
            });

            message.mes = message.mes.replace(
                MARKER_REGEX,
                `<span class="comfyinject-error">${errorText}</span>`
            );
        }
    }

    // Re-render the message using ST's own update function
    try {
        updateMessageBlock(index, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
        // metadata and saveChat still run below
    }

    // Add retry buttons via DOM manipulation (after ST renders the message)
    addRetryButtons(index);

    // Save metadata keyed by send_date
    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {};
    }
    context.chatMetadata[MODULE_NAME][message.send_date] = metadataArray;

    // Persist everything to disk
    await context.saveMetadata();
    await context.saveChat();

    if (!suppressRepairNotifications) {
        maybeShowGroupedRepairToast(repairedCount, results.length);
        maybeLogGroupedRepairWarning(index, repairedCount, results.length);
    }

    const successCount = results.filter((result) => result?.status === "ok").length;
    console.log(`[ComfyInject] Message ${index} saved with ${successCount} injected image(s)`);

    return {
        repairedCount,
        totalCount: results.length,
    };
}

/**
 * Scans all existing messages in the current chat and processes
 * any that still have an unprocessed [[IMG: ... ]] marker.
 * Called on APP_READY and CHAT_CHANGED.
 */
async function scanExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;

    console.log(`[ComfyInject] Scanning ${context.chat.length} existing messages`);

    let repairedMessages = 0;
    let repairedMarkers = 0;

    for (let i = 0; i < context.chat.length; i++) {
        const message = context.chat[i];
        if (!message.is_user && hasImageMarker(message.mes)) {
            const summary = await processMessage(i, { suppressRepairNotifications: true });

            if (summary?.repairedCount > 0) {
                repairedMessages++;
                repairedMarkers += summary.repairedCount;
            }
        }
    }

    maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers);
    maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers);

    // Add retry buttons to all already-rendered images (including ones from previous sessions)
    addAllRetryButtons();
}

/**
 * Appends a newly generated version to an image's version history.
 * If the history is missing (legacy chat) and an old version is known,
 * the old version is recorded first so nothing is lost.
 * @param {Array<object>|undefined} history - The existing history array
 * @param {object|null} oldVersion - The version being replaced
 * @param {object} newVersion - The newly generated version
 * @returns {Array<object>} The updated history array
 */
function appendVersionHistory(history, oldVersion, newVersion) {
    const versions = Array.isArray(history) ? [...history] : [];
    if (versions.length === 0 && oldVersion) {
        versions.push(oldVersion);
    }
    versions.push(newVersion);
    return versions;
}

/**
 * Retries image generation for a specific image within a message with a new random seed.
 * Uses send_date to look up metadata (stable across deletions).
 * @param {string} sendDate - The send_date of the message to retry
 * @param {number} imgIndex - Which image within the message to retry (0-based)
 * @param {object} [overrides] - Optional values that take precedence over the stored ones
 * @param {string} [overrides.prompt] - Prompt to use instead of the one stored in the img tag
 * @param {string} [overrides.ar] - AR token to force (e.g. "PORTRAIT" or "LANDSCAPE")
 * @param {{width: number, height: number}} [overrides.resolution] - Explicit pixel resolution
 * @returns {Promise<boolean>} True if the generation succeeded
 */
async function retryImage(sendDate, imgIndex, overrides = {}) {
    const context = SillyTavern.getContext();
    const { updateMessageBlock } = SillyTavern.getContext();
    const metadata = context.chatMetadata[MODULE_NAME];

    // Find the current array index for this message
    const messageIndex = findIndexBySendDate(sendDate);
    if (messageIndex === -1) return false;

    const message = context.chat[messageIndex];
    if (!message || !metadata) return false;

    // Parse prompt from the img tag in mes (source of truth, not stored in metadata)
    const imgTags = [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)];
    const targetTag = imgTags[imgIndex];
    if (!targetTag) return false;

    const tagPrompt = targetTag[0].match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "";
    // A dialog-provided prompt takes precedence over the stored one
    const prompt = overrides.prompt || tagPrompt;
    if (!prompt) return false;

    // Remember the version being replaced so it can be kept in the history
    const oldUrl = targetTag[0].match(/src="([^"]*)"/)?.[1] || null;
    const oldSeed = parseInt(targetTag[0].match(/data-seed="([^"]*)"/)?.[1], 10) || 0;

    // Look up metadata for supplementary fields (ar, shot)
    const images = getImageData(metadata, sendDate).length > 0
        ? getImageData(metadata, sendDate)
        : getImageData(metadata, messageIndex);
    const imageData = images[imgIndex] || {};

    const { ar, shot } = imageData;

    // Fall back to the same marker-level defaults used by the parser
    // if metadata is missing or incomplete.
    const retryAr = overrides.ar || ar || "SQUARE";
    const retryShot = shot || "MEDIUM";

    // Resolve the pixel resolution for this generation.
    // An explicit override (from the image settings dialog) always wins.
    // Without one, a plain retry of a portrait/landscape image while the
    // resolution lock is enabled uses the same inferred orientation
    // resolution the dialog uses, so the last selected orientation sticks.
    const settings = context.extensionSettings[MODULE_NAME];
    const resolutionOverride = overrides.resolution
        || ((settings.resolution_lock_enabled && (retryAr === "PORTRAIT" || retryAr === "LANDSCAPE"))
            ? getOrientationResolution(retryAr)
            : undefined);

    // Generate a new random seed using the shared project-wide max safe integer range.
    const newSeed = Math.floor(Math.random() * 9007199254740991);

    // Show generating state on the retry button
    const retryBtn = document.querySelector(`.comfyinject-retry[data-senddate="${sendDate}"][data-imgindex="${imgIndex}"]`);
    if (retryBtn) {
        retryBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        retryBtn.style.pointerEvents = "none";
    }

    let result;
    try {
        result = await generateImage({
            prompt,
            ar: retryAr,
            shot: retryShot,
            seed: newSeed,
            messageIndex,
            bypassSeedLock: true,
            resolution: resolutionOverride,
        });
    } catch (err) {
        console.error(`[ComfyInject] Retry failed for message ${messageIndex} image ${imgIndex}:`, err);
        toastr.error("Image retry failed.", "ComfyInject");
        // Restore retry button
        if (retryBtn) {
            retryBtn.innerHTML = `<i class="fa-solid fa-rotate"></i>`;
            retryBtn.style.pointerEvents = "auto";
        }
        return false;
    }

    const { imageUrl, seed: effectiveSeed, promptId, filename, effectiveAr, effectiveShot, resolution, shotTags } = result;

    // Save the seed that was actually used so LOCK works
    saveLastSeed(effectiveSeed);

    // Update metadata — try send_date key first, fall back to index for legacy.
    // Guard against missing or malformed entries so retry does not recreate bad metadata.
    const metaKey = metadata[sendDate] ? sendDate : messageIndex;
    const metaEntry = metadata[metaKey];

    const newVersion = { seed: effectiveSeed, imageUrl, promptId, filename, prompt };

    if (Array.isArray(metaEntry)) {
        const existingEntry = metaEntry[imgIndex] && typeof metaEntry[imgIndex] === "object"
            ? metaEntry[imgIndex]
            : {};

        const oldVersion = oldUrl
            ? { seed: oldSeed, imageUrl: oldUrl, promptId: existingEntry.promptId ?? null, filename: existingEntry.filename ?? null, prompt: tagPrompt }
            : null;
        const history = appendVersionHistory(existingEntry.history, oldVersion, newVersion);

        metaEntry[imgIndex] = {
            ...existingEntry,
            seed: effectiveSeed,
            ar: overrides.ar || existingEntry.ar || retryAr,
            shot: existingEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: existingEntry.repairMeta || null,
            history,
        };
    } else if (metaEntry && typeof metaEntry === "object") {
        const oldVersion = oldUrl
            ? { seed: oldSeed, imageUrl: oldUrl, promptId: metaEntry.promptId ?? null, filename: metaEntry.filename ?? null, prompt: tagPrompt }
            : null;
        const history = appendVersionHistory(metaEntry.history, oldVersion, newVersion);

        metadata[metaKey] = {
            ...metaEntry,
            seed: effectiveSeed,
            ar: overrides.ar || metaEntry.ar || retryAr,
            shot: metaEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: metaEntry.repairMeta || null,
            history,
        };
    }

    // Replace the Nth img tag in mes (where N = imgIndex)
    const newImgTag = buildImgTag(imageUrl, prompt, effectiveSeed);
    let count = 0;
    message.mes = message.mes.replace(/<img class="comfyinject-image"[^>]*>/g, (match) => {
        if (count === imgIndex) {
            count++;
            return newImgTag;
        }
        count++;
        return match;
    });

    // Re-render
    try {
        updateMessageBlock(messageIndex, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
    }

    // Re-add retry buttons since updateMessageBlock wipes the DOM
    addRetryButtons(messageIndex);

    // Persist
    await context.saveMetadata();
    await context.saveChat();

    return true;
}

/**
 * Permanently deletes one version from an image's version history.
 * The version that shifted into the deleted slot becomes the new display
 * position (wrapping to the first version when the last one is deleted).
 * When the deleted version was the latest saved one, the <img> tag in
 * message.mes is rewritten to the new latest version so re-renders stay
 * consistent. The message is not re-rendered here: the live <img> is
 * updated in place so the position chosen above is shown right away.
 * @param {string} sendDate - The send_date of the message
 * @param {number} imgIndex - Which image within the message (0-based)
 * @param {number} deleteIndex - 0-based position of the version to delete
 * @param {HTMLElement} img - The live image element to update in place
 * @returns {Promise<{newIndex: number, total: number}|null>} The new display
 * position and version count, or null when nothing was deleted
 */
async function deleteVersion(sendDate, imgIndex, deleteIndex, img) {
    const context = SillyTavern.getContext();
    const { metaKey, metaEntry, entry, history } = resolveVersionMeta(sendDate, imgIndex);
    if (!metaEntry || history.length <= 1) return null;
    if (deleteIndex < 0 || deleteIndex >= history.length) return null;

    const messageIndex = findIndexBySendDate(sendDate);
    const message = context.chat[messageIndex];
    if (!message) return null;

    const versions = [...history];
    const deleted = versions.splice(deleteIndex, 1)[0];
    const newIndex = deleteIndex % versions.length;

    const imgTags = [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)];
    const targetTag = imgTags[imgIndex]?.[0];

    let newTag = null;
    if (targetTag) {
        const tagUrl = targetTag.match(/src="([^"]*)"/)?.[1] || "";
        if (tagUrl && tagUrl === deleted?.imageUrl) {
            // The latest saved version was deleted: promote the new latest
            // version into the saved <img> tag and the entry's top-level
            // fields (which always mirror the latest version).
            const newLatest = versions[versions.length - 1];
            const tagPrompt = targetTag.match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "";
            newTag = buildImgTag(newLatest.imageUrl, newLatest.prompt ?? tagPrompt, newLatest.seed);
            entry.seed = newLatest.seed;
            entry.promptId = newLatest.promptId ?? null;
            entry.filename = newLatest.filename ?? null;
        }
    }

    entry.history = versions;
    if (Array.isArray(metaEntry)) {
        metaEntry[imgIndex] = entry;
    } else {
        context.chatMetadata[MODULE_NAME][metaKey] = entry;
    }

    if (newTag) {
        let count = 0;
        message.mes = message.mes.replace(/<img class="comfyinject-image"[^>]*>/g, (match) => {
            if (count === imgIndex) {
                count++;
                return newTag;
            }
            count++;
            return match;
        });
    }

    const shown = versions[newIndex];
    if (shown?.imageUrl) {
        img.src = shown.imageUrl;
    }

    await context.saveMetadata();
    await context.saveChat();

    return { newIndex, total: versions.length };
}

/**
 * Computes the pixel resolution used for an orientation choice.
 * When the resolution lock is enabled, the orientation resolutions are
 * inferred from the locked resolution: portrait is the shorter-width
 * variant, landscape is the shorter-height variant. Otherwise the
 * resolution is taken from the per-AR-token settings table.
 * @param {"PORTRAIT" | "LANDSCAPE"} ar - The orientation token
 * @returns {{width: number, height: number}}
 */
function getOrientationResolution(ar) {
    const settings = SillyTavern.getContext().extensionSettings[MODULE_NAME];

    if (settings.resolution_lock_enabled) {
        const shortSide = Math.min(settings.resolution_lock.width, settings.resolution_lock.height);
        const longSide = Math.max(settings.resolution_lock.width, settings.resolution_lock.height);
        return ar === "PORTRAIT"
            ? { width: shortSide, height: longSide }
            : { width: longSide, height: shortSide };
    }

    return settings.resolutions[ar] ?? { width: 512, height: 512 };
}

/**
 * Opens the image settings dialog for one rendered image.
 * Allows editing the prompt and choosing the orientation (portrait or
 * landscape, with the pixel resolution taken from the extension
 * settings), then regenerates the image with a new random seed.
 * @param {string} sendDate - The send_date of the message
 * @param {number} imgIndex - Which image within the message (0-based)
 */
function openImageSettingsDialog(sendDate, imgIndex) {
    closeImageSettingsDialog();

    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[MODULE_NAME];
    const metadata = context.chatMetadata[MODULE_NAME];

    const messageIndex = findIndexBySendDate(sendDate);
    const message = context.chat[messageIndex];
    if (!message) return;

    // Current prompt — the img tag's data attribute is the source of truth
    const imgTags = [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)];
    const currentPrompt = imgTags[imgIndex]?.[0].match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "";

    // Current AR token and resolution from metadata (send_date key, legacy index fallback)
    let images = metadata ? getImageData(metadata, sendDate) : [];
    if (images.length === 0 && messageIndex !== -1) {
        images = getImageData(metadata, messageIndex);
    }
    const imageData = images[imgIndex] || {};
    const currentAr = imageData.ar;
    const currentResolution = imageData.resolution;

    // Pre-select the orientation: the current AR when it matches, otherwise
    // infer it from the image's current resolution (wider → landscape,
    // taller → portrait, square or unknown → portrait)
    let selectedAr;
    if (currentAr === "PORTRAIT" || currentAr === "LANDSCAPE") {
        selectedAr = currentAr;
    } else if (currentResolution) {
        selectedAr = currentResolution.width > currentResolution.height ? "LANDSCAPE" : "PORTRAIT";
    } else {
        selectedAr = "PORTRAIT";
    }

    const portraitRes = getOrientationResolution("PORTRAIT");
    const landscapeRes = getOrientationResolution("LANDSCAPE");

    // Overlay
    const overlay = document.createElement("div");
    overlay.id = "comfyinject-image-settings-overlay";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.75); z-index: 9999;
        display: flex; align-items: center; justify-content: center;
    `;

    // Panel
    const panel = document.createElement("div");
    panel.style.cssText = `
        width: 480px; max-width: calc(100vw - 40px); max-height: calc(100vh - 80px);
        overflow-y: auto; border-radius: 8px; padding: 16px 20px;
        background: var(--theme-background, #222); color: var(--theme-text, white);
        border: 1px solid var(--theme-bar, #444);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        font-size: 13px;
    `;

    // Header
    const header = document.createElement("div");
    header.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;";
    header.innerHTML = `<span style="font-size: 16px; font-weight: bold;"><i class="fa-solid fa-gear"></i> Image Settings</span>`;

    const closeBtn = document.createElement("div");
    closeBtn.style.cssText = "cursor: pointer; font-size: 18px; padding: 4px 8px; opacity: 0.8;";
    closeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
    closeBtn.addEventListener("click", closeImageSettingsDialog);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Prompt
    const promptField = document.createElement("div");
    promptField.style.cssText = "margin-bottom: 14px;";
    promptField.innerHTML = `
        <div style="margin-bottom: 4px; font-weight: bold;">Prompt</div>
        <textarea class="text_pole" rows="6" style="width: 100%; resize: vertical;"></textarea>
    `;
    panel.appendChild(promptField);
    const promptTextarea = promptField.querySelector("textarea");
    promptTextarea.value = currentPrompt;

    // Orientation
    const orientationField = document.createElement("div");
    orientationField.style.cssText = "margin-bottom: 6px;";
    orientationField.innerHTML = `
        <div style="margin-bottom: 4px; font-weight: bold;">Orientation</div>
        <label class="checkbox_label" style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: pointer;">
            <input type="radio" name="comfyinject-settings-ar" value="PORTRAIT" ${selectedAr === "PORTRAIT" ? "checked" : ""} />
            <span>Portrait (${portraitRes.width} &times; ${portraitRes.height})</span>
        </label>
        <label class="checkbox_label" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="radio" name="comfyinject-settings-ar" value="LANDSCAPE" ${selectedAr === "LANDSCAPE" ? "checked" : ""} />
            <span>Landscape (${landscapeRes.width} &times; ${landscapeRes.height})</span>
        </label>
    `;
    panel.appendChild(orientationField);

    // Resolution lock note
    if (settings.resolution_lock_enabled) {
        const note = document.createElement("div");
        note.style.cssText = "margin-bottom: 10px; font-size: 11px; opacity: 0.7;";
        note.innerHTML = `Resolution lock is enabled — these sizes are inferred from the locked resolution (${settings.resolution_lock.width} &times; ${settings.resolution_lock.height}).`;
        panel.appendChild(note);
    }

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "menu_button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeImageSettingsDialog);

    const regenBtn = document.createElement("button");
    regenBtn.className = "menu_button";
    regenBtn.innerHTML = `<i class="fa-solid fa-rotate"></i> Regenerate`;

    regenBtn.addEventListener("click", () => {
        const prompt = promptTextarea.value.trim();
        if (!prompt) {
            toastr.warning("Prompt cannot be empty.", "ComfyInject");
            return;
        }

        const ar = orientationField.querySelector("input[name='comfyinject-settings-ar']:checked")?.value;
        if (!ar) return;

        // Close immediately — the retry button's spinner shows the progress
        closeImageSettingsDialog();

        retryImage(sendDate, imgIndex, {
            prompt,
            ar,
            resolution: getOrientationResolution(ar),
        }).catch((err) => console.error("[ComfyInject] Regeneration from image settings failed:", err));
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(regenBtn);
    panel.appendChild(footer);

    // Close on Escape and on backdrop click (panel clicks do not close it)
    const escHandler = (e) => {
        if (e.key === "Escape") closeImageSettingsDialog();
    };
    document.addEventListener("keydown", escHandler);
    overlay._escHandler = escHandler;

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeImageSettingsDialog();
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
}

/**
 * Closes the image settings dialog if it is open.
 */
function closeImageSettingsDialog() {
    const overlay = document.getElementById("comfyinject-image-settings-overlay");
    if (!overlay) return;
    if (overlay._escHandler) {
        document.removeEventListener("keydown", overlay._escHandler);
    }
    overlay.remove();
}

/**
 * Registers all SillyTavern event listeners.
 * Called once from index.js on load.
 */
export function initDom() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Process new bot messages as they are rendered
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (index) => {
        await processMessage(index);
    });

    // Re-scan when chat changes
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        await scanExistingMessages();
    });

    // Re-add retry buttons after swipes and edits since ST re-renders the message DOM
    const reAddRetryButtons = (index) => setTimeout(() => addRetryButtons(index), 100);
    eventSource.on(event_types.MESSAGE_SWIPED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_UPDATED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_EDITED, reAddRetryButtons);

    console.log("[ComfyInject] DOM listener initialized");
}