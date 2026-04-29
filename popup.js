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

async function saveSiteSettings(enabled) {
  const result = await chrome.storage.local.get(["siteSettings"]);
  const siteSettings = result.siteSettings || {};
  const siteKey = getSiteKey(currentTab.url);
  siteSettings[siteKey] = enabled;
  await chrome.storage.local.set({ siteSettings: siteSettings });
}

async function toggleExtension(enabled) {
  try {
    await saveSiteSettings(enabled);
    updateUI(enabled);

    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, {
        action: "toggleOverlay",
        enabled: enabled,
      });

      if (response && response.success) {
        statusText.textContent = enabled ? "オーバーレイ表示が有効です" : "オーバーレイ表示が無効です";
        statusText.style.color = enabled ? "#e65100" : "#666";
      } else {
        statusText.textContent = "設定を保存しました。ページを再読み込みしてください。";
        statusText.style.color = "#ff9800";
      }
    } catch (error) {
      statusText.textContent = "設定を保存しました。ページを再読み込みしてください。";
      statusText.style.color = "#ff9800";
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
    statusText.textContent = "エラー: ページを再読み込みしてください";
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

    const status = await getExtensionStatus();
    updateUI(status.enabled);
    updateModeUI(status.mode);

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
        statusText.textContent = "設定は有効ですが、ページを再読み込みしてください";
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
