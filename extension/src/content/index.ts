import type { SwaraMessage } from '../types';
import { executeActions } from './execute';
import { extractPage } from './extract';

chrome.runtime.onMessage.addListener(
  (message: SwaraMessage, _sender, sendResponse) => {
    if (message.type === 'SWARA_PING') {
      sendResponse({
        type: 'SWARA_PONG',
        url: location.href,
        title: document.title,
      });
      return;
    }

    if (message.type === 'SWARA_EXTRACT') {
      sendResponse({
        type: 'SWARA_EXTRACT_RESULT',
        page: extractPage(),
      });
      return;
    }

    if (message.type === 'SWARA_EXECUTE') {
      sendResponse({
        type: 'SWARA_EXECUTE_RESULT',
        results: executeActions(message.actions),
      });
    }
  },
);
