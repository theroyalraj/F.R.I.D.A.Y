/* global chrome */
// Opens full chat UI in a tab (popup is too small for the React app).
chrome.runtime.onInstalled.addListener(() => {
  // no-op; keeps service worker alive pattern minimal
});

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('index.html');
  chrome.tabs.create({ url });
});
