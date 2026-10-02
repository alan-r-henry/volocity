// Volocity background service worker - relays keyboard commands to the
// active tab's content script.

const RATE_STEP = 0.1;
const BOOST_STEP = 0.1;

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const messages = {
    'speed-up': { type: 'volocity-rate-delta', delta: RATE_STEP },
    'speed-down': { type: 'volocity-rate-delta', delta: -RATE_STEP },
    'boost-up': { type: 'volocity-boost-delta', delta: BOOST_STEP },
    'boost-down': { type: 'volocity-boost-delta', delta: -BOOST_STEP },
    'toggle-overlay': { type: 'volocity-toggle-overlay' }
  };

  const message = messages[command];
  if (!message) return;

  chrome.tabs.sendMessage(tab.id, message).catch(() => {
    // No content script on this tab (e.g. chrome:// pages) - ignore.
  });
});

// Toolbar badge shows the active site's speed at a glance (blank at 1x,
// i.e. only when something non-default is actually in effect).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'volocity-badge' || !sender.tab || !sender.tab.id) return;
  const tabId = sender.tab.id;
  const text = Math.abs(msg.rate - 1) > 0.001 ? `${msg.rate.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x` : '';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c5cff' });
});
