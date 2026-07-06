import { createScriptIdDiv, teleportStyle } from '@util/script';
import { createPinia, setActivePinia } from 'pinia';
import App from './设置面板.vue';
import { installImportWatcher, installRenameHook } from './runtime';

$(() => {
  const pinia = createPinia();
  setActivePinia(pinia);

  const app = createApp(App).use(pinia);
  const $app = createScriptIdDiv().appendTo('#extensions_settings2');
  app.mount($app[0]);

  const { destroy } = teleportStyle();
  const stop_import_watcher = installImportWatcher();
  const stop_rename_hook = installRenameHook();

  toastr.info('聊天文件增强已加载');

  $(window).on('pagehide', () => {
    stop_import_watcher();
    stop_rename_hook();
    app.unmount();
    $app.remove();
    destroy();
  });
});
