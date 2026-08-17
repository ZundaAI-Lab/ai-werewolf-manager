/**
 * 責務: 正式タブ登録とタブ切替を所有する。
 * 変更ルール: 表示タブの変更はゲーム進行や自動実行状態を変更しない。ゲーム規則を独自実装せず、AppUIから渡された正式依存と状態だけを使用する。
 */

export function createTabController({ ui }) {
  if (!ui) throw new TypeError('AppUIがありません。');

  function registerTabView(tab, view = {}) {
    const tabId = String(tab ?? '').trim();
    if (!tabId) throw new TypeError('登録するタブIDがありません。');
    if (typeof view.render !== 'function') throw new TypeError(`タブ「${tabId}」の描画関数がありません。`);
    ui.registeredTabViews.set(tabId, {
      render: view.render,
      beforeRender: typeof view.beforeRender === 'function' ? view.beforeRender : null,
      afterRender: typeof view.afterRender === 'function' ? view.afterRender : null,
    });
    if (ui.activeTab === tabId) ui.render();
  }

  function getActiveTab() {
    return ui.activeTab;
  }

  async function requestTab(tab) {
    return setTab(String(tab ?? ''));
  }

  function isKnownTab(tabId) {
    const builtInTabs = ['workbench', 'setup', 'chat-room', 'character-library', 'records', 'public', 'license'];
    return builtInTabs.includes(tabId) || ui.registeredTabViews.has(tabId);
  }

  function refreshTab(tab) {
    if (ui.activeTab !== tab) return false;
    ui.render();
    return true;
  }

  function setTab(tab) {
    const tabId = String(tab ?? '');
    if (!isKnownTab(tabId)) return false;
    ui.activeTab = tabId;
    ui.render();
    return true;
  }

  return Object.freeze({
    registerTabView,
    getActiveTab,
    requestTab,
    refreshTab,
    setTab,
  });
}
