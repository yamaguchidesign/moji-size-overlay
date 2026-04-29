const toggleSwitch = document.getElementById("toggleSwitch");
const statusText = document.getElementById("statusText");
const modeAllAndMouse = document.getElementById("modeAllAndMouse");
const modeMouseOnly = document.getElementById("modeMouseOnly");

let currentTab = null;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getSiteKey(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return url;
  }
}

function canUseSitePermission(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch (e) {
    return false;
  }
}

async function saveSiteSettings(enabled) {
  const result = await chrome.storage.local.get(["siteSettings"]);
  const siteSettings = result.siteSettings || {};
  const siteKey = getSiteKey(currentTab.url);
  siteSettings[siteKey] = enabled;
  await new Promise(function (resolve) {
    chrome.storage.local.set({ siteSettings: siteSettings }, resolve);
  });
}

async function requestHostPermissionForCurrentTab() {
  const origin = getSiteKey(currentTab.url);
  return chrome.permissions.request({
    origins: [origin + "/*"],
  });
}

async function ensureInjectedIfEnabled() {
  if (!currentTab || !currentTab.id) return;
  if (!canUseSitePermission(currentTab.url)) return;
  const origin = getSiteKey(currentTab.url);
  const result = await chrome.storage.local.get(["siteSettings"]);
  const siteSettings = result.siteSettings || {};
  if (!siteSettings[origin]) return;
  const hasPerm = await chrome.permissions.contains({ origins: [origin + "/*"] });
  if (!hasPerm) return;
  await chrome.runtime.sendMessage({
    action: "registerAndInject",
    origin: origin,
    tabId: currentTab.id,
  });
}

async function getExtensionStatus() {
  try {
    const result = await chrome.storage.local.get(["siteSettings", "displayMode"]);
    const siteSettings = result.siteSettings || {};
    const currentUrl = currentTab.url;
    const siteKey = getSiteKey(currentUrl);
    const fallbackStatus = !!siteSettings[siteKey];
    const fallbackMode = result.displayMode || "all_and_mouse";

    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, { action: "getStatus" });
      return {
        enabled: response.enabled,
        mode: response.mode || fallbackMode,
      };
    } catch (error) {
      return {
        enabled: fallbackStatus,
        mode: fallbackMode,
      };
    }
  } catch (storageError) {
    return {
      enabled: false,
      mode: "all_and_mouse",
    };
  }
}

async function toggleExtension(enabled) {
  try {
    if (enabled) {
      if (!canUseSitePermission(currentTab.url)) {
        statusText.textContent = "このページでは利用できません（http/https のページでお試しください）";
        statusText.style.color = "#d32f2f";
        return;
      }
      const granted = await requestHostPermissionForCurrentTab();
      if (!granted) {
        statusText.textContent = "このサイトで使うには許可が必要です。もう一度オンにしてください。";
        statusText.style.color = "#ff9800";
        return;
      }
      await saveSiteSettings(true);
      await chrome.runtime.sendMessage({
        action: "registerAndInject",
        origin: getSiteKey(currentTab.url),
        tabId: currentTab.id,
      });
      try {
        await chrome.tabs.sendMessage(currentTab.id, { action: "ping" });
        statusText.textContent = "オーバーレイ表示が有効です";
        statusText.style.color = "#e65100";
      } catch (error) {
        statusText.textContent = "設定を保存しました。表示されない場合はページを再読み込みしてください。";
        statusText.style.color = "#ff9800";
      }
      updateUI(true);
    } else {
      await saveSiteSettings(false);
      try {
        await chrome.tabs.sendMessage(currentTab.id, {
          action: "toggleOverlay",
          enabled: false,
        });
      } catch (e) {
        /* content script が無いタブでは無視 */
      }
      await chrome.runtime.sendMessage({
        action: "unregisterOrigin",
        origin: getSiteKey(currentTab.url),
      });
      statusText.textContent = "オーバーレイ表示が無効です";
      statusText.style.color = "#666";
      updateUI(false);
    }
  } catch (storageError) {
    statusText.textContent = "エラー: 設定の保存に失敗しました";
    statusText.style.color = "#d32f2f";
  }
}

function updateUI(enabled) {
  if (enabled) {
    toggleSwitch.classList.add("active");
  } else {
    toggleSwitch.classList.remove("active");
  }
}

function updateModeUI(mode) {
  if (mode === "all_and_mouse") {
    modeAllAndMouse.checked = true;
  } else if (mode === "mouse_only") {
    modeMouseOnly.checked = true;
  }
}

modeAllAndMouse.addEventListener("change", async function () {
  if (this.checked) {
    await changeMode("all_and_mouse");
  }
});

modeMouseOnly.addEventListener("change", async function () {
  if (this.checked) {
    await changeMode("mouse_only");
  }
});

async function changeMode(mode) {
  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, {
      action: "changeMode",
      mode: mode,
    });

    if (response && response.success) {
      const modeText = mode === "all_and_mouse" ? "全表示 + マウスオーバー" : "マウスオーバーのみ";
      statusText.textContent = "モードを変更しました (" + modeText + ")";
      statusText.style.color = "#e65100";
    } else {
      statusText.textContent = "モード変更に失敗しました";
      statusText.style.color = "#d32f2f";
    }
  } catch (error) {
    statusText.textContent = "エラー: ページを再読み込みするか、このサイトで拡張をオンにしてください";
    statusText.style.color = "#d32f2f";
  }
}

toggleSwitch.addEventListener("click", async function () {
  const isCurrentlyActive = toggleSwitch.classList.contains("active");
  const newState = !isCurrentlyActive;
  await toggleExtension(newState);
});

async function initialize() {
  try {
    currentTab = await getCurrentTab();

    if (!currentTab) {
      statusText.textContent = "タブが見つかりません";
      statusText.style.color = "#d32f2f";
      return;
    }

    await ensureInjectedIfEnabled();

    const status = await getExtensionStatus();
    updateUI(status.enabled);
    updateModeUI(status.mode);

    const origin = getSiteKey(currentTab.url);
    const stored = await chrome.storage.local.get(["siteSettings"]);
    const siteSettings = stored.siteSettings || {};
    const storedOn = !!siteSettings[origin];
    const hasPerm =
      canUseSitePermission(currentTab.url) &&
      (await chrome.permissions.contains({ origins: [origin + "/*"] }));

    if (storedOn && !hasPerm && canUseSitePermission(currentTab.url)) {
      statusText.textContent =
        "このサイトでは以前オンにしていました。再度オンにすると、サイトごとの許可を求められます。";
      statusText.style.color = "#ff9800";
      return;
    }

    try {
      await chrome.tabs.sendMessage(currentTab.id, { action: "ping" });
      if (status.enabled) {
        const modeText = status.mode === "all_and_mouse" ? "全表示 + マウスオーバー" : "マウスオーバーのみ";
        statusText.textContent = "オーバーレイ表示が有効です (" + modeText + ")";
        statusText.style.color = "#e65100";
      } else {
        statusText.textContent = "オーバーレイ表示が無効です";
        statusText.style.color = "#666";
      }
    } catch (error) {
      if (status.enabled) {
        statusText.textContent = "設定は有効ですが、表示するにはページを再読み込みしてください";
        statusText.style.color = "#ff9800";
      } else {
        statusText.textContent = "オーバーレイ表示が無効です";
        statusText.style.color = "#666";
      }
    }
  } catch (error) {
    statusText.textContent = "エラー: ページを再読み込みしてください";
    statusText.style.color = "#d32f2f";
  }
}

document.addEventListener("DOMContentLoaded", initialize);
