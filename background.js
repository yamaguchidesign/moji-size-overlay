function originToMatchPattern(origin) {
  return origin + "/*";
}

function scriptIdForOrigin(origin) {
  const base = "fs-" + origin.replace(/[^a-zA-Z0-9]/g, "_");
  return base.length > 200 ? base.slice(0, 200) : base;
}

function isHttpOrigin(origin) {
  return /^https:\/\//.test(origin) || /^http:\/\//.test(origin);
}

async function registerContentScriptForOrigin(origin) {
  if (!isHttpOrigin(origin)) return;
  const id = scriptIdForOrigin(origin);
  const match = originToMatchPattern(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.some(function (x) { return x.id === id; })) return;
  await chrome.scripting.registerContentScripts([
    {
      id: id,
      matches: [match],
      js: ["content.js"],
      css: ["content.css"],
      runAt: "document_idle",
    },
  ]);
}

async function unregisterContentScriptForOrigin(origin) {
  const id = scriptIdForOrigin(origin);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch (e) {
    /* noop */
  }
}

async function syncRegisteredScriptsFromStorage() {
  const data = await chrome.storage.local.get(["siteSettings"]);
  const siteSettings = data.siteSettings || {};
  for (const origin in siteSettings) {
    if (!Object.prototype.hasOwnProperty.call(siteSettings, origin)) continue;
    if (!siteSettings[origin]) continue;
    if (!isHttpOrigin(origin)) continue;
    const ok = await chrome.permissions.contains({ origins: [originToMatchPattern(origin)] });
    if (ok) {
      await registerContentScriptForOrigin(origin);
    }
  }
  for (const origin2 in siteSettings) {
    if (!Object.prototype.hasOwnProperty.call(siteSettings, origin2)) continue;
    if (siteSettings[origin2]) continue;
    if (!isHttpOrigin(origin2)) continue;
    await unregisterContentScriptForOrigin(origin2);
  }
}

async function registerAndInjectTab(origin, tabId) {
  await registerContentScriptForOrigin(origin);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ["content.css"] });
  } catch (e) {
    /* restricted pages (chrome://, Web Store, etc.) */
  }
}

chrome.runtime.onInstalled.addListener(function () {
  syncRegisteredScriptsFromStorage();
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === "registerAndInject") {
    registerAndInjectTab(request.origin, request.tabId).then(function () {
      sendResponse({ success: true });
    });
    return true;
  }
  if (request.action === "unregisterOrigin") {
    unregisterContentScriptForOrigin(request.origin).then(function () {
      sendResponse({ success: true });
    });
    return true;
  }
  if (request.action === "syncRegisteredScripts") {
    syncRegisteredScriptsFromStorage().then(function () {
      sendResponse({ success: true });
    });
    return true;
  }
  return undefined;
});
