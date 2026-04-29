let isOverlayEnabled = false;
const overlayElements = new Map();
const overlayPositions = new Map();
let mouseOverlayElement = null;
let isMouseOverlayVisible = false;
let listenersAttached = false;
let mutationObserver = null;

const DISPLAY_MODES = {
  ALL_AND_MOUSE: "all_and_mouse",
  MOUSE_ONLY: "mouse_only",
};

let currentDisplayMode = DISPLAY_MODES.ALL_AND_MOUSE;

let ruleWalkOrder = 0;
let fontSizeRuleCache = null;

function resetFontSizeRuleCache() {
  fontSizeRuleCache = null;
  ruleWalkOrder = 0;
}

function walkCssRules(ruleList, visitor) {
  if (!ruleList) return;
  for (let i = 0; i < ruleList.length; i++) {
    const rule = ruleList[i];
    if (rule.type === CSSRule.STYLE_RULE) {
      visitor(rule);
    } else if (rule.cssRules) {
      walkCssRules(rule.cssRules, visitor);
    }
  }
}

function buildFontSizeRuleCache() {
  if (fontSizeRuleCache) return fontSizeRuleCache;
  const entries = [];
  const sheets = document.styleSheets;
  for (let si = 0; si < sheets.length; si++) {
    let cssRules;
    try {
      cssRules = sheets[si].cssRules;
    } catch (e) {
      continue;
    }
    walkCssRules(cssRules, function (rule) {
      const rawFs = rule.style && rule.style.getPropertyValue("font-size");
      const rawFont = rule.style && rule.style.getPropertyValue("font");
      const fs = rawFs && rawFs.trim();
      const fromShorthand = !fs && rawFont && extractFontSizeFromShorthand(rawFont.trim());
      const value = fs || fromShorthand;
      if (!value) return;
      const selText = rule.selectorText;
      if (!selText) return;
      const ruleOrder = ruleWalkOrder++;
      const parts = selText.split(",").map(function (p) {
        return p.trim();
      });
      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi];
        if (!part) continue;
        entries.push({
          selector: part,
          value: value.trim(),
          order: ruleOrder,
          specificity: selectorSpecificity(part),
        });
      }
    });
  }
  fontSizeRuleCache = entries;
  return fontSizeRuleCache;
}

function extractFontSizeFromShorthand(fontVal) {
  const m = fontVal.match(
    /\b(\d+(\.\d+)?(px|rem|em|%|cap|ch|ex|ic|lh|rlh|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q))\b/i
  );
  return m ? m[1] : "";
}

function findMatchingClosingParen(str, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < str.length; i++) {
    const ch = str[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitVarInnerArgs(inner) {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      return {
        name: inner.slice(0, i).trim(),
        fallback: inner.slice(i + 1).trim(),
      };
    }
  }
  return { name: inner.trim(), fallback: "" };
}

function replaceAllVarCallsInFontSize(value, element) {
  const win = (element.ownerDocument && element.ownerDocument.defaultView) || window;
  const cs = win.getComputedStyle(element);
  let result = value;
  let iterations = 0;
  while (iterations++ < 32) {
    const lower = result.toLowerCase();
    const idx = lower.indexOf("var(");
    if (idx === -1) {
      break;
    }
    const openParen = idx + 3;
    const closeParen = findMatchingClosingParen(result, openParen);
    if (closeParen < 0) {
      break;
    }
    const inner = result.slice(openParen + 1, closeParen);
    const args = splitVarInnerArgs(inner);
    if (!/^--[\w-]+$/.test(args.name)) {
      break;
    }
    const originalSlice = result.slice(idx, closeParen + 1);
    let replacement = cs.getPropertyValue(args.name).trim();
    if (!replacement && args.fallback) {
      replacement = args.fallback;
    }
    if (!replacement || replacement === originalSlice) {
      break;
    }
    result = result.slice(0, idx) + replacement + result.slice(closeParen + 1);
  }
  return result;
}

function resolveVarFontSizeForDisplay(rawFontSize, element) {
  if (!rawFontSize || !/var\s*\(/i.test(rawFontSize)) {
    return { text: rawFontSize, usedComputedFallback: false };
  }
  const expanded = replaceAllVarCallsInFontSize(rawFontSize, element);
  if (!expanded || /var\s*\(/i.test(expanded)) {
    const win = (element.ownerDocument && element.ownerDocument.defaultView) || window;
    return { text: win.getComputedStyle(element).fontSize, usedComputedFallback: true };
  }
  return { text: expanded.trim(), usedComputedFallback: false };
}

function selectorSpecificity(selector) {
  let s = selector.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, "");
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  const a = (s.match(/#[a-zA-Z_][\w-]*/g) || []).length;
  let b = 0;
  b += (s.match(/\.[a-zA-Z_][\w-]*/g) || []).length;
  b += (s.match(/\[[^\]]+\]/g) || []).length;
  const pseudos = s.match(/:(?!:)[a-zA-Z-][\w-]*(\([^)]*\))?/g) || [];
  for (let i = 0; i < pseudos.length; i++) {
    const p = pseudos[i];
    if (/^:not\(/i.test(p)) continue;
    b++;
  }
  const cMatches = s.match(/(^|[\s>+~,#])(\*|[a-zA-Z][a-zA-Z0-9]*)/g) || [];
  let c = 0;
  for (let j = 0; j < cMatches.length; j++) {
    const token = cMatches[j].replace(/^[\s>+~,#]+/, "").trim();
    if (token && token !== "*" && !/^#[a-zA-Z_]/.test(token)) c++;
  }
  return [a, b, c];
}

function compareSpecificity(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function matchesSelectorSafe(el, selector) {
  try {
    return el.matches(selector);
  } catch (e) {
    return false;
  }
}

function getAuthorFontSize(element) {
  const inline = element.style && element.style.getPropertyValue("font-size");
  if (inline && inline.trim()) {
    const raw = inline.trim();
    const r = resolveVarFontSizeForDisplay(raw, element);
    return { text: r.text, fromAuthor: !r.usedComputedFallback };
  }
  const inlineFont = element.style && element.style.getPropertyValue("font");
  const fromInlineSh = inlineFont && extractFontSizeFromShorthand(inlineFont.trim());
  if (fromInlineSh) {
    const r = resolveVarFontSizeForDisplay(fromInlineSh, element);
    return { text: r.text, fromAuthor: !r.usedComputedFallback };
  }

  const rules = buildFontSizeRuleCache();
  let best = null;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!matchesSelectorSafe(element, r.selector)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const cmp = compareSpecificity(r.specificity, best.specificity);
    if (cmp > 0 || (cmp === 0 && r.order > best.order)) {
      best = r;
    }
  }
  if (best && best.value) {
    const r = resolveVarFontSizeForDisplay(best.value, element);
    return { text: r.text, fromAuthor: !r.usedComputedFallback };
  }

  const computed = window.getComputedStyle(element).fontSize;
  return { text: computed, fromAuthor: false };
}

function hasDirectTextNode(element) {
  const nodes = element.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === Node.TEXT_NODE && n.textContent && /\S/.test(n.textContent)) {
      return true;
    }
  }
  return false;
}

function shouldSkipElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
  const tag = element.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG") return true;
  if (element.classList.contains("font-size-overlay")) return true;
  if (element.classList.contains("font-size-mouse-overlay")) return true;

  const st = window.getComputedStyle(element);
  if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return true;

  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return true;

  if (!hasDirectTextNode(element)) return true;

  return false;
}

function getElementPosition(element) {
  const rect = element.getBoundingClientRect();
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  return {
    left: rect.left + scrollX,
    top: rect.top + scrollY,
    width: rect.width,
    height: rect.height,
  };
}

const OVERLAY_POSITIONS = {
  TOP_LEFT: "top-left",
  TOP_RIGHT: "top-right",
  BOTTOM_LEFT: "bottom-left",
  BOTTOM_RIGHT: "bottom-right",
  CENTER: "center",
};

function calculateOverlayPosition(elementRect, position, overlayWidth, overlayHeight) {
  const margin = 2;
  switch (position) {
    case OVERLAY_POSITIONS.TOP_LEFT:
      return { left: elementRect.left + margin, top: elementRect.top + margin };
    case OVERLAY_POSITIONS.TOP_RIGHT:
      return {
        left: elementRect.left + elementRect.width - overlayWidth - margin,
        top: elementRect.top + margin,
      };
    case OVERLAY_POSITIONS.BOTTOM_LEFT:
      return {
        left: elementRect.left + margin,
        top: elementRect.top + elementRect.height - overlayHeight - margin,
      };
    case OVERLAY_POSITIONS.BOTTOM_RIGHT:
      return {
        left: elementRect.left + elementRect.width - overlayWidth - margin,
        top: elementRect.top + elementRect.height - overlayHeight - margin,
      };
    case OVERLAY_POSITIONS.CENTER:
      return {
        left: elementRect.left + (elementRect.width - overlayWidth) / 2,
        top: elementRect.top + (elementRect.height - overlayHeight) / 2,
      };
    default:
      return { left: elementRect.left + margin, top: elementRect.top + margin };
  }
}

function isOverlapping(rect1, rect2) {
  return !(
    rect1.left + rect1.width < rect2.left ||
    rect2.left + rect2.width < rect1.left ||
    rect1.top + rect1.height < rect2.top ||
    rect2.top + rect2.height < rect1.top
  );
}

function isParentChild(parentElement, childElement) {
  return parentElement.contains(childElement) && parentElement !== childElement;
}

function areSiblings(element1, element2) {
  return element1.parentNode === element2.parentNode && element1 !== element2;
}

function getElementLevel(element) {
  let level = 0;
  let current = element.parentNode;
  while (current && current !== document.body) {
    level++;
    current = current.parentNode;
  }
  return level;
}

function moveElementUp(element, offset) {
  const overlay = overlayElements.get(element);
  if (overlay) {
    const currentRect = overlayPositions.get(element);
    if (currentRect) {
      const newRect = {
        left: currentRect.left,
        top: currentRect.top - offset,
        width: currentRect.width,
        height: currentRect.height,
      };
      overlay.style.top = newRect.top + "px";
      overlayPositions.set(element, newRect);
    }
  }
}

function shouldMoveElementUp(currentElement, overlappingElement) {
  if (isParentChild(overlappingElement, currentElement)) return true;
  if (areSiblings(currentElement, overlappingElement)) {
    return getElementLevel(overlappingElement) <= getElementLevel(currentElement);
  }
  return getElementLevel(overlappingElement) < getElementLevel(currentElement);
}

function findBestPosition(elementRect, overlayWidth, overlayHeight, currentElement) {
  const positions = Object.values(OVERLAY_POSITIONS);
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    const overlayRect = calculateOverlayPosition(
      elementRect,
      position,
      overlayWidth,
      overlayHeight
    );
    if (
      overlayRect.left < 0 ||
      overlayRect.top < 0 ||
      overlayRect.left + overlayWidth > window.innerWidth + (window.pageXOffset || 0) ||
      overlayRect.top + overlayHeight > window.innerHeight + (window.pageYOffset || 0)
    ) {
      continue;
    }
    let hasOverlap = false;
    let overlappingElement = null;
    for (const [existingElement, existingRect] of overlayPositions) {
      if (isOverlapping(overlayRect, existingRect)) {
        hasOverlap = true;
        overlappingElement = existingElement;
        break;
      }
    }
    if (!hasOverlap) {
      return { position: position, rect: overlayRect };
    }
    if (overlappingElement && currentElement && shouldMoveElementUp(currentElement, overlappingElement)) {
      moveElementUp(overlappingElement, 24);
      return { position: position, rect: overlayRect };
    }
  }
  return {
    position: OVERLAY_POSITIONS.TOP_LEFT,
    rect: calculateOverlayPosition(
      elementRect,
      OVERLAY_POSITIONS.TOP_LEFT,
      overlayWidth,
      overlayHeight
    ),
  };
}

function createOverlayElement(element) {
  const info = getAuthorFontSize(element);
  const overlay = document.createElement("div");
  overlay.className =
    "font-size-overlay " +
    (info.fromAuthor ? "font-size-overlay--author" : "font-size-overlay--fallback");
  overlay.textContent = info.fromAuthor ? info.text : info.text + " (算出)";
  overlay.setAttribute("aria-hidden", "true");
  return overlay;
}

function createMouseOverlayElement() {
  const overlay = document.createElement("div");
  overlay.className = "font-size-mouse-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.display = "none";
  return overlay;
}

function clearAllOverlays() {
  overlayElements.forEach(function (overlay) {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  });
  overlayElements.clear();
  overlayPositions.clear();
}

function showAllOverlays() {
  if (!isOverlayEnabled) return;
  if (currentDisplayMode === DISPLAY_MODES.MOUSE_ONLY) {
    clearAllOverlays();
    return;
  }

  resetFontSizeRuleCache();
  buildFontSizeRuleCache();

  clearAllOverlays();

  const candidates = [];
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (shouldSkipElement(el)) continue;
    const position = getElementPosition(el);
    if (position.width <= 0 || position.height <= 0) continue;
    candidates.push({ element: el, position: position });
  }

  candidates.sort(function (a, b) {
    return b.position.width * b.position.height - a.position.width * a.position.height;
  });

  for (let j = 0; j < candidates.length; j++) {
    const item = candidates[j];
    const overlay = createOverlayElement(item.element);
    overlay.style.visibility = "hidden";
    overlay.style.position = "absolute";
    document.body.appendChild(overlay);
    const ob = overlay.getBoundingClientRect();
    const overlayWidth = ob.width;
    const overlayHeight = ob.height;
    const best = findBestPosition(item.position, overlayWidth, overlayHeight, item.element);
    overlay.style.left = best.rect.left + "px";
    overlay.style.top = best.rect.top + "px";
    overlay.style.visibility = "visible";
    overlayPositions.set(item.element, {
      left: best.rect.left,
      top: best.rect.top,
      width: overlayWidth,
      height: overlayHeight,
    });
    overlayElements.set(item.element, overlay);
  }
}

function showMouseOverlay(element, event) {
  if (!isOverlayEnabled || !mouseOverlayElement) return;
  const info = getAuthorFontSize(element);
  mouseOverlayElement.className =
    "font-size-mouse-overlay " +
    (info.fromAuthor ? "font-size-overlay--author" : "font-size-overlay--fallback");
  mouseOverlayElement.textContent = info.fromAuthor ? info.text : info.text + " (算出)";
  const x = event.clientX + 10;
  const y = event.clientY - 28;
  mouseOverlayElement.style.left = x + "px";
  mouseOverlayElement.style.top = y + "px";
  mouseOverlayElement.style.display = "block";
  isMouseOverlayVisible = true;
}

function hideMouseOverlay() {
  if (mouseOverlayElement) {
    mouseOverlayElement.style.display = "none";
    isMouseOverlayVisible = false;
  }
}

function updateMouseOverlayPosition(event) {
  if (!isMouseOverlayVisible || !mouseOverlayElement) return;
  mouseOverlayElement.style.left = event.clientX + 10 + "px";
  mouseOverlayElement.style.top = event.clientY - 28 + "px";
}

function onMouseOverCapture(event) {
  if (!isOverlayEnabled) return;
  const t = event.target;
  if (
    !t ||
    !t.classList ||
    t.classList.contains("font-size-overlay") ||
    t.classList.contains("font-size-mouse-overlay")
  ) {
    return;
  }
  if (shouldSkipElement(t)) return;
  showMouseOverlay(t, event);
}

function onMouseOutCapture() {
  if (!isOverlayEnabled) return;
  hideMouseOverlay();
}

function onMouseMoveCapture(event) {
  if (!isOverlayEnabled) return;
  updateMouseOverlayPosition(event);
}

function onScrollOrResize() {
  if (isOverlayEnabled) showAllOverlays();
}

function onMutations() {
  if (isOverlayEnabled) {
    resetFontSizeRuleCache();
    setTimeout(showAllOverlays, 120);
  }
}

function addEventListeners() {
  if (!mouseOverlayElement) {
    mouseOverlayElement = createMouseOverlayElement();
    document.body.appendChild(mouseOverlayElement);
  }
  if (listenersAttached) return;
  listenersAttached = true;

  document.addEventListener("mouseover", onMouseOverCapture);
  document.addEventListener("mouseout", onMouseOutCapture);
  document.addEventListener("mousemove", onMouseMoveCapture);
  window.addEventListener("scroll", onScrollOrResize);
  window.addEventListener("resize", onScrollOrResize);

  mutationObserver = new MutationObserver(onMutations);
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
}

function removeEventListeners() {
  clearAllOverlays();
  hideMouseOverlay();
  if (listenersAttached) {
    document.removeEventListener("mouseover", onMouseOverCapture);
    document.removeEventListener("mouseout", onMouseOutCapture);
    document.removeEventListener("mousemove", onMouseMoveCapture);
    window.removeEventListener("scroll", onScrollOrResize);
    window.removeEventListener("resize", onScrollOrResize);
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    listenersAttached = false;
  }
}

function getCurrentUrl() {
  return window.location.href;
}

function getSiteKey(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return url;
  }
}

function getSiteSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["siteSettings"], function (result) {
      resolve(result.siteSettings || {});
    });
  });
}

function setSiteSettings(siteSettings) {
  chrome.storage.local.set({ siteSettings: siteSettings });
}

function getModeSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["displayMode"], function (result) {
      resolve(result);
    });
  });
}

function setModeSettings(displayMode) {
  chrome.storage.local.set({ displayMode: displayMode });
}

async function initializeExtension() {
  const siteKey = getSiteKey(getCurrentUrl());
  const siteSettings = await getSiteSettings();
  isOverlayEnabled = !!siteSettings[siteKey];
  const modeSettings = await getModeSettings();
  currentDisplayMode = modeSettings.displayMode || DISPLAY_MODES.ALL_AND_MOUSE;
  if (isOverlayEnabled) {
    addEventListeners();
    showAllOverlays();
  }
}

function attachRuntimeMessageListener() {
  if (globalThis.__FS_OVERLAY_MSG__) return;
  globalThis.__FS_OVERLAY_MSG__ = true;
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === "toggleOverlay") {
      isOverlayEnabled = request.enabled;
      const siteKey = getSiteKey(getCurrentUrl());
      if (isOverlayEnabled) {
        addEventListeners();
        showAllOverlays();
      } else {
        removeEventListeners();
      }
      getSiteSettings().then(function (siteSettings) {
        siteSettings[siteKey] = isOverlayEnabled;
        chrome.storage.local.set({ siteSettings: siteSettings }, function () {
          sendResponse({ success: true });
        });
      });
      return true;
    }
    if (request.action === "changeMode") {
      currentDisplayMode = request.mode;
      setModeSettings(currentDisplayMode);
      if (isOverlayEnabled) {
        clearAllOverlays();
        showAllOverlays();
      }
      sendResponse({ success: true });
      return true;
    }
    if (request.action === "getStatus") {
      sendResponse({
        enabled: isOverlayEnabled,
        mode: currentDisplayMode,
      });
      return true;
    }
    if (request.action === "ping") {
      sendResponse({ pong: true });
      return true;
    }
    return undefined;
  });
}

function scheduleInitializeExtension() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeExtension);
  } else {
    initializeExtension();
  }
}

if (globalThis.__FS_OVERLAY_DOC__ === document) {
  initializeExtension();
} else {
  globalThis.__FS_OVERLAY_DOC__ = document;
  attachRuntimeMessageListener();
  scheduleInitializeExtension();
}
