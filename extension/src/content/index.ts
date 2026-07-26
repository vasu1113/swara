import type { SwaraMessage } from '../types';

chrome.runtime.onMessage.addListener(
  (message: SwaraMessage, _sender, sendResponse) => {
    if (message.type === 'SWARA_PING') {
      sendResponse({
        type: 'SWARA_PONG',
        url: location.href,
        title: document.title,
      });
    }
  },
);
