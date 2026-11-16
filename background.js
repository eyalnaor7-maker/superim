// The toolbar button opens the extension in its own window, which the shopper can move off the cart.
// One window at a time: clicking again reopens it for the tab that is in front now, at the remembered position.
chrome.action.onClicked.addListener(async tab => {
    const { winId, winPos } = await chrome.storage.local.get(['winId', 'winPos']);
    if (winId) await chrome.windows.remove(winId).catch(() => {});
    const base = { url: `popup.html?tabId=${tab.id}`, type: 'popup', width: 378, height: 660 };
    // a remembered position on a screen that is no longer connected is refused: open at the default place instead
    const win = await chrome.windows.create({ ...base, ...(winPos || {}) }).catch(() => chrome.windows.create(base));
    await chrome.storage.local.set({ winId: win.id });
});
