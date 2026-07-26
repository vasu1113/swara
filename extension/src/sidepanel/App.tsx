import { useState } from 'react';
import type { SwaraPongMessage } from '../types';

function App() {
  const [page, setPage] = useState<SwaraPongMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pingPage = async () => {
    setError(null);
    setPage(null);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab?.id === undefined) {
      setError('No active tab is available.');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'SWARA_PING' }, (response) => {
      if (chrome.runtime.lastError) {
        // Most common cause: the content script isn't in this tab yet (the tab
        // predates the extension install, or it's a chrome:// page).
        setError(
          chrome.runtime.lastError.message ??
            'Could not reach the page. Try reloading the tab.',
        );
        return;
      }

      setPage(response as SwaraPongMessage);
    });
  };

  return (
    <main className="app">
      <h1>Swara</h1>
      <p className="subtitle">Extension scaffold</p>
      <button type="button" onClick={() => void pingPage()}>
        Ping page
      </button>

      {page && (
        <section className="result" aria-live="polite">
          <p>
            <strong>Title</strong>
            {page.title}
          </p>
          <p>
            <strong>URL</strong>
            {page.url}
          </p>
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}

export default App;
