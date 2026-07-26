import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Swara',
  version: '0.1.0',
  permissions: ['sidePanel', 'activeTab', 'scripting', 'storage'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  // Chrome refuses to show the getUserMedia prompt inside a side panel, so the
  // panel sends the user to this page to grant it once for the extension origin.
  options_page: 'src/permission/index.html',
  web_accessible_resources: [
    {
      // The side panel opens this extension-owned full page with
      // chrome.runtime.getURL; listing it keeps CRX's production build aware
      // of the otherwise independent HTML entry point.
      resources: ['src/vault/index.html'],
      matches: ['<all_urls>'],
    },
  ],
  action: {
    default_title: 'Open Swara',
  },
});
