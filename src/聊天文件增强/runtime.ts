import {
  ChatRenameNames,
  collectRelationStringValues,
  extractChatDeleteNamesFromRequestBody,
  extractChatRenameNamesFromRequestBody,
  isLikelyChatImportFile,
  replaceRelationNames,
  sanitizeChatName,
  sanitizeImportedChatName,
  shouldPromptForImportedRename,
} from './logic';
import { OperationRecord, useSettingsStore } from './settings';

type PendingImport = {
  capturedAt: number;
  previousChatName: string;
  rawFileName: string;
  targetName: string;
};

type RelationIssue = {
  path: string;
  source: string;
  value: string;
};

export type RelationInspection = {
  broken: RelationIssue[];
  currentChatName: string;
  mentionCount: number;
  repairableCount: number;
  warnings: string[];
};

type RenamePatchState = {
  original: typeof SillyTavern.renameChat;
  owners: Set<string>;
  target: typeof SillyTavern;
};

type ImportFetchPatchState = {
  original: typeof fetch;
  owners: Set<string>;
};

type ReloadChatHistoryOptions = {
  removedNames?: string[];
};

const RENAME_PATCH_KEY = '__chatFileEnhanceRenamePatch';
const IMPORT_FETCH_PATCH_KEY = '__chatFileEnhanceFetchPatch';
const IMPORT_CAPTURE_WINDOW = 45_000;
const IMPORT_RETRY_INTERVAL = 500;
const FILE_INPUT_POLL_INTERVAL = 250;
const CHAT_DELETE_URL_PATTERN = /\/api\/chats\/(?:delete|group\/delete)(?:$|[/?#])/i;
const CHAT_RENAME_URL_PATTERN = /\/api\/chats\/(?:rename|group\/rename)(?:$|[/?#])/i;

let pending_import: PendingImport | null = null;
let import_retry_timer: number | null = null;
let file_input_poll_timer: number | null = null;
let last_captured_file_key = '';
const completed_rename_side_effects = new Set<string>();

function getHostDocument(): Document {
  return window.parent?.document ?? document;
}

function getHostWindow(): Window {
  return window.parent ?? window;
}

function isChatImportFileInput(target: EventTarget | null): target is HTMLInputElement {
  const input = target as HTMLInputElement | null;
  return input?.tagName === 'INPUT' && input.type === 'file' && input.id === 'chat_import_file';
}

function stopImportRetry(): void {
  if (import_retry_timer === null) {
    return;
  }

  window.clearInterval(import_retry_timer);
  import_retry_timer = null;
}

function scheduleImportRetry(): void {
  stopImportRetry();
  import_retry_timer = window.setInterval(() => {
    void consumePendingImport('导入完成轮询');
  }, IMPORT_RETRY_INTERVAL);
}

function getChatImportInput(): HTMLInputElement | null {
  return getHostDocument().querySelector('#chat_import_file');
}

function getCurrentChatName(): string {
  return SillyTavern.getCurrentChatId() || getHostDocument().querySelector<HTMLSelectElement>('#extensionTopBarChatName')?.value || '';
}

function addRecord(record: Omit<OperationRecord, 'time'>): void {
  useSettingsStore().addRecord(record);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractChatName(value: unknown): string[] {
  if (typeof value === 'string') {
    return [sanitizeImportedChatName(value), sanitizeChatName(value)].filter(Boolean);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;
  return ['file_name', 'filename', 'file', 'chat', 'chat_id', 'id', 'name']
    .flatMap(key => extractChatName(record[key]))
    .filter(Boolean);
}

async function getKnownChatNames(): Promise<Set<string>> {
  const names = new Set<string>([getCurrentChatName()]);
  const current_character_name = getCurrentCharacterName();
  if (!current_character_name) {
    return names;
  }

  try {
    const history = (await getChatHistoryBrief(current_character_name)) ?? [];
    history.flatMap(extractChatName).forEach(name => names.add(name));
  } catch (error) {
    console.warn('[聊天文件增强] 获取聊天列表失败, 将仅依赖重命名接口报错:', error);
  }

  return names;
}

async function chatNameExists(name: string, old_name: string): Promise<boolean> {
  const known_names = await getKnownChatNames();
  known_names.delete(old_name);
  return known_names.has(name);
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function isChatDeleteRequest(url: string): boolean {
  return CHAT_DELETE_URL_PATTERN.test(url);
}

function isChatRenameRequest(url: string): boolean {
  return CHAT_RENAME_URL_PATTERN.test(url);
}

async function getFetchBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') {
    return init.body;
  }

  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch (error) {
      console.warn('[聊天文件增强] 无法读取请求体:', error);
    }
  }

  return '';
}

function findChatHistoryName(value: unknown): string {
  return extractChatName(value)[0] ?? '';
}

function syncChatSelectAfterRename(old_name: string, new_name: string, history: unknown[]): void {
  const select = getHostDocument().querySelector<HTMLSelectElement>('#extensionTopBarChatName');
  if (!select) {
    return;
  }

  const old_candidates = new Set([old_name, `${old_name}.jsonl`, sanitizeImportedChatName(old_name)].filter(Boolean));
  const new_candidates = new Set([new_name, `${new_name}.jsonl`, sanitizeImportedChatName(new_name)].filter(Boolean));
  let has_new_option = false;

  [...select.options].forEach(option => {
    if (new_candidates.has(option.value) || new_candidates.has(option.textContent?.trim() ?? '')) {
      has_new_option = true;
      return;
    }

    if (old_candidates.has(option.value) || old_candidates.has(option.textContent?.trim() ?? '')) {
      option.value = new_name;
      option.textContent = new_name;
      has_new_option = true;
    }
  });

  if (!has_new_option) {
    const history_match = history.map(findChatHistoryName).find(name => name === new_name);
    if (history_match || new_name) {
      select.add(new Option(history_match || new_name, history_match || new_name));
    }
  }

  const host_window = getHostWindow() as Window & { $?: JQueryStatic; jQuery?: JQueryStatic };
  const jquery = host_window.jQuery ?? host_window.$;
  jquery?.(select).trigger('change.select2');
}

function syncChatSelectWithHistory(history: unknown[], options: ReloadChatHistoryOptions = {}): void {
  const select = getHostDocument().querySelector<HTMLSelectElement>('#extensionTopBarChatName');
  if (!select) {
    return;
  }

  const current_name = getCurrentChatName();
  const removed_names = new Set(options.removedNames ?? []);
  const names = history.map(findChatHistoryName).filter(Boolean);
  if (names.length === 0) {
    return;
  }

  select.replaceChildren(...names.map(name => new Option(name, name, false, name === current_name)));
  if (current_name && !names.includes(current_name) && !removed_names.has(current_name)) {
    select.add(new Option(current_name, current_name, true, true), 0);
  }
  select.value = removed_names.has(current_name) ? names[0] : current_name;

  const host_window = getHostWindow() as Window & { $?: JQueryStatic; jQuery?: JQueryStatic };
  const jquery = host_window.jQuery ?? host_window.$;
  jquery?.(select).trigger('change.select2');
}

async function reloadChatHistoryAfterRename(old_name: string, new_name: string): Promise<void> {
  const settings_store = useSettingsStore();
  if (!settings_store.settings.reloadChatHistoryAfterRename) {
    addRecord({
      action: '重载聊天记录',
      result: 'skipped',
      oldName: old_name,
      newName: new_name,
      detail: '设置已关闭',
    });
    return;
  }

  const current_character_name = getCurrentCharacterName();
  if (!current_character_name) {
    addRecord({
      action: '重载聊天记录',
      result: 'skipped',
      oldName: old_name,
      newName: new_name,
      detail: '未选择角色卡',
    });
    return;
  }

  try {
    const history = (await getChatHistoryBrief(current_character_name)) ?? [];
    syncChatSelectAfterRename(old_name, new_name, history);
    addRecord({
      action: '重载聊天记录',
      result: 'success',
      oldName: old_name,
      newName: new_name,
      detail: `已刷新 ${history.length} 个聊天`,
    });
  } catch (error) {
    addRecord({
      action: '重载聊天记录',
      result: 'failed',
      oldName: old_name,
      newName: new_name,
      detail: getErrorMessage(error),
    });
  }
}

async function reloadChatHistoryAfterFileChange(
  action: string,
  detail: string,
  options: ReloadChatHistoryOptions = {},
): Promise<void> {
  const settings_store = useSettingsStore();
  if (!settings_store.settings.reloadChatHistoryAfterRename) {
    addRecord({
      action: '重载聊天记录',
      result: 'skipped',
      detail: '设置已关闭',
    });
    return;
  }

  const current_character_name = getCurrentCharacterName();
  if (!current_character_name) {
    addRecord({
      action: '重载聊天记录',
      result: 'skipped',
      detail: `${action}: 未选择角色卡`,
    });
    return;
  }

  try {
    const history = (await getChatHistoryBrief(current_character_name)) ?? [];
    syncChatSelectWithHistory(history, options);
    addRecord({
      action: '重载聊天记录',
      result: 'success',
      detail: `${action}: ${detail}; 已刷新 ${history.length} 个聊天`,
    });
  } catch (error) {
    addRecord({
      action: '重载聊天记录',
      result: 'failed',
      detail: `${action}: ${getErrorMessage(error)}`,
    });
  }
}

function collectCurrentRelationIssues(known_names: Set<string>): RelationInspection {
  const current_chat_name = getCurrentChatName();
  const warnings: string[] = [];
  const issues: RelationIssue[] = [];
  let mention_count = 0;

  const addMentions = (source: string, value: unknown): void => {
    const mentions = collectRelationStringValues(value);
    mention_count += mentions.length;
    mentions.forEach(mention => {
      if (known_names.size > 1 && !known_names.has(mention.value)) {
        issues.push({ source, path: mention.path, value: mention.value });
      }
    });
  };

  addMentions('chatMetadata', SillyTavern.chatMetadata);

  try {
    const last_message_id = getLastMessageId();
    if (last_message_id >= 0) {
      getChatMessages(`0-${last_message_id}`).forEach(message => {
        addMentions(`message.${message.message_id}.data`, message.data);
        addMentions(`message.${message.message_id}.extra`, message.extra);
      });
    }
  } catch (error) {
    warnings.push(`读取消息关系字段失败: ${getErrorMessage(error)}`);
  }

  if (known_names.size <= 1) {
    warnings.push('无法获取完整聊天列表, 检查结果仅展示当前已加载聊天内的关系字段。');
  }

  return {
    broken: issues,
    currentChatName: current_chat_name,
    mentionCount: mention_count,
    repairableCount: mention_count,
    warnings,
  };
}

export async function inspectCurrentRelations(): Promise<RelationInspection> {
  return collectCurrentRelationIssues(await getKnownChatNames());
}

export async function repairCurrentRelations(old_name: string, new_name: string): Promise<OperationRecord> {
  const settings_store = useSettingsStore();
  if (!settings_store.settings.autoRepairRelationsAfterRename) {
    return {
      time: new Date().toLocaleString(),
      action: '修复关系链',
      result: 'skipped',
      oldName: old_name,
      newName: new_name,
      detail: '设置已关闭',
    };
  }

  let metadata_replacements = 0;
  let message_replacements = 0;

  try {
    const metadata_result = replaceRelationNames(SillyTavern.chatMetadata, old_name, new_name);
    metadata_replacements = metadata_result.replacements.length;
    if (metadata_replacements > 0) {
      SillyTavern.updateChatMetadata(metadata_result.value, true);
      await SillyTavern.saveMetadata();
    }

    const last_message_id = getLastMessageId();
    if (last_message_id >= 0) {
      const updates = getChatMessages(`0-${last_message_id}`)
        .map(message => {
          const data_result = replaceRelationNames(message.data, old_name, new_name);
          const extra_result = replaceRelationNames(message.extra, old_name, new_name);
          const replacements = data_result.replacements.length + extra_result.replacements.length;
          message_replacements += replacements;
          return replacements > 0
            ? { message_id: message.message_id, data: data_result.value, extra: extra_result.value }
            : null;
        })
        .filter((message): message is { message_id: number; data: Record<string, any>; extra: Record<string, any> } =>
          message !== null,
        );

      if (updates.length > 0) {
        await setChatMessages(updates, { refresh: 'none' });
        await SillyTavern.saveChat();
      }
    }

    return {
      time: new Date().toLocaleString(),
      action: '修复关系链',
      result: 'success',
      oldName: old_name,
      newName: new_name,
      detail: `metadata ${metadata_replacements} 处, 消息 ${message_replacements} 处`,
    };
  } catch (error) {
    return {
      time: new Date().toLocaleString(),
      action: '修复关系链',
      result: 'failed',
      oldName: old_name,
      newName: new_name,
      detail: getErrorMessage(error),
    };
  }
}

async function repairAfterRename(old_name: string, new_name: string): Promise<void> {
  const record = await repairCurrentRelations(old_name, new_name);
  addRecord(record);
  if (record.result === 'failed') {
    toastr.warning(`聊天已改名, 但关系链修复失败: ${record.detail}`);
  }
}

async function completeRenameSideEffects(old_name: string, new_name: string): Promise<void> {
  const key = `${old_name}\u0000${new_name}`;
  if (completed_rename_side_effects.has(key)) {
    return;
  }

  completed_rename_side_effects.add(key);
  await repairAfterRename(old_name, new_name);
  await reloadChatHistoryAfterRename(old_name, new_name);
}

async function safeRenameChat(old_name: string, raw_name: string, action: string): Promise<void> {
  const new_name = sanitizeChatName(raw_name);

  if (!new_name) {
    toastr.error('聊天名为空, 已取消改名');
    addRecord({ action, result: 'blocked', oldName: old_name, detail: '聊天名为空' });
    return;
  }

  if (new_name === old_name) {
    toastr.info('聊天名没有变化');
    addRecord({ action, result: 'skipped', oldName: old_name, newName: new_name, detail: '名称没有变化' });
    return;
  }

  if (await chatNameExists(new_name, old_name)) {
    toastr.error(`已存在同名聊天: ${new_name}`);
    addRecord({ action, result: 'blocked', oldName: old_name, newName: new_name, detail: '聊天名重名' });
    return;
  }

  try {
    await SillyTavern.renameChat(old_name, new_name);
    await completeRenameSideEffects(old_name, new_name);
    toastr.success(`已重命名聊天: ${new_name}`);
    addRecord({ action, result: 'success', oldName: old_name, newName: new_name });
  } catch (error) {
    toastr.error(`重命名失败: ${getErrorMessage(error)}`);
    addRecord({ action, result: 'failed', oldName: old_name, newName: new_name, detail: getErrorMessage(error) });
  }
}

async function resolveImportedRenameTarget(imported_chat_name: string, initial_target_name: string): Promise<string | null> {
  const settings = useSettingsStore().settings;
  let target_name = initial_target_name;
  let should_prompt = shouldPromptForImportedRename({
    showImportRenameDialog: settings.showImportRenameDialog,
    targetNameExists: false,
  });
  let prompt_message = '为导入的聊天文件重命名';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (should_prompt) {
      const prompt_result = getHostWindow().prompt(prompt_message, target_name);
      if (prompt_result === null) {
        addRecord({
          action: '导入后命名',
          result: 'skipped',
          oldName: imported_chat_name,
          newName: target_name,
          detail: '用户取消弹窗',
        });
        return null;
      }
      target_name = sanitizeChatName(prompt_result);
    }

    if (!target_name) {
      toastr.error('聊天名为空, 已取消改名');
      addRecord({ action: '导入后命名', result: 'blocked', oldName: imported_chat_name, detail: '聊天名为空' });
      return null;
    }

    if (!(await chatNameExists(target_name, imported_chat_name))) {
      return target_name;
    }

    toastr.warning(`导入聊天与现有文件重名, 请改名: ${target_name}`);
    prompt_message = `已存在同名聊天: ${target_name}\n请为导入的聊天文件输入新名称`;
    should_prompt = shouldPromptForImportedRename({
      showImportRenameDialog: settings.showImportRenameDialog,
      targetNameExists: true,
    });
  }

  addRecord({
    action: '导入后命名',
    result: 'blocked',
    oldName: imported_chat_name,
    newName: target_name,
    detail: '多次输入重名聊天名',
  });
  return null;
}

export async function safeRenameCurrentChat(raw_name: string, action = '手动安全改名'): Promise<void> {
  await safeRenameChat(getCurrentChatName(), raw_name, action);
}

async function renameImportedChat(imported_chat_name: string, trigger: string): Promise<void> {
  const pending = pending_import;
  if (!pending) {
    return;
  }

  if (Date.now() - pending.capturedAt > IMPORT_CAPTURE_WINDOW) {
    pending_import = null;
    stopImportRetry();
    return;
  }

  pending_import = null;
  stopImportRetry();

  const settings = useSettingsStore().settings;
  if (!settings.useImportedFileName && !settings.showImportRenameDialog) {
    addRecord({
      action: '导入后命名',
      result: 'skipped',
      oldName: imported_chat_name,
      newName: pending.targetName,
      detail: '设置已关闭',
    });
    return;
  }

  const target_name = await resolveImportedRenameTarget(imported_chat_name, pending.targetName);
  if (!target_name) {
    return;
  }

  console.info(`[聊天文件增强] ${trigger} 后尝试将导入聊天重命名为: ${target_name}`);
  await safeRenameChat(imported_chat_name, target_name, '导入后命名');
}

async function consumePendingImport(trigger: string): Promise<void> {
  const pending = pending_import;
  if (!pending) {
    return;
  }

  const current_chat_name = getCurrentChatName();
  if (current_chat_name === pending.previousChatName) {
    return;
  }

  await renameImportedChat(current_chat_name, trigger);
}

function extractImportedChatNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const file_names = record.fileNames;
  if (Array.isArray(file_names)) {
    return file_names
      .filter((file_name): file_name is string => typeof file_name === 'string')
      .map(sanitizeImportedChatName)
      .filter(Boolean);
  }

  return extractChatName(value);
}

async function consumeImportResponse(response: Response, trigger: string): Promise<void> {
  const pending = pending_import;
  if (!pending || !response.ok) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch (error) {
    console.warn('[聊天文件增强] 无法解析导入响应:', error);
    return;
  }

  const imported_chat_name = extractImportedChatNames(parsed)[0];
  if (!imported_chat_name) {
    console.warn('[聊天文件增强] 导入响应里没有可识别的聊天文件名:', parsed);
    addRecord({
      action: '导入响应捕获',
      result: 'failed',
      oldName: pending.previousChatName,
      newName: pending.targetName,
      detail: '导入响应里没有聊天文件名',
    });
    return;
  }

  addRecord({
    action: '导入响应捕获',
    result: 'info',
    oldName: imported_chat_name,
    newName: pending.targetName,
    detail: trigger,
  });

  await renameImportedChat(imported_chat_name, trigger);
  await reloadChatHistoryAfterFileChange('导入', imported_chat_name, { removedNames: [imported_chat_name] });
}

function installImportResponseWatcher(): () => void {
  const owner = getScriptId();
  const host_window = getHostWindow() as Window & Record<string, ImportFetchPatchState | undefined>;
  let patch_state = host_window[IMPORT_FETCH_PATCH_KEY];

  if (!patch_state) {
    patch_state = {
      original: host_window.fetch.bind(host_window),
      owners: new Set(),
    };
    host_window[IMPORT_FETCH_PATCH_KEY] = patch_state;

    host_window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = getRequestUrl(input);
      const rename_names: ChatRenameNames | null = isChatRenameRequest(url)
        ? extractChatRenameNamesFromRequestBody(await getFetchBodyText(input, init))
        : null;
      const deleted_names = isChatDeleteRequest(url)
        ? extractChatDeleteNamesFromRequestBody(await getFetchBodyText(input, init))
        : [];
      const response = await patch_state!.original(input, init);
      if (url.includes('/api/chats/import')) {
        void consumeImportResponse(response, '导入响应');
      } else if (rename_names && response.ok) {
        void completeRenameSideEffects(rename_names.oldName, rename_names.newName);
      } else if (isChatDeleteRequest(url) && response.ok) {
        void reloadChatHistoryAfterFileChange('删除', '服务器响应成功', { removedNames: deleted_names });
      }
      return response;
    }) as typeof fetch;
  }

  patch_state.owners.add(owner);

  return () => {
    const current_state = host_window[IMPORT_FETCH_PATCH_KEY];
    if (!current_state) {
      return;
    }

    current_state.owners.delete(owner);
    if (current_state.owners.size === 0) {
      host_window.fetch = current_state.original;
      delete host_window[IMPORT_FETCH_PATCH_KEY];
    }
  };
}

function captureImportCandidate(file: File): void {
  const target_name = sanitizeImportedChatName(file.name);
  if (!target_name || !isLikelyChatImportFile(file.name)) {
    return;
  }

  const file_key = `${file.name}:${file.size}:${file.lastModified}`;
  if (file_key === last_captured_file_key) {
    return;
  }
  last_captured_file_key = file_key;

  const candidate: PendingImport = {
    capturedAt: Date.now(),
    previousChatName: getCurrentChatName(),
    rawFileName: file.name,
    targetName: target_name,
  };
  pending_import = candidate;
  scheduleImportRetry();
  addRecord({
    action: '导入文件捕获',
    result: 'info',
    oldName: candidate.previousChatName,
    newName: target_name,
    detail: candidate.rawFileName,
  });
}

export function installImportWatcher(): () => void {
  const scan_file_input = (): void => {
    const file = getChatImportInput()?.files?.[0];
    if (file) {
      captureImportCandidate(file);
    } else {
      last_captured_file_key = '';
    }
  };

  const on_file_change = (event: Event): void => {
    if (!isChatImportFileInput(event.target)) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    captureImportCandidate(file);
  };

  const host_document = getHostDocument();
  host_document.addEventListener('change', on_file_change, true);
  file_input_poll_timer = window.setInterval(scan_file_input, FILE_INPUT_POLL_INTERVAL);
  const chat_changed = eventOn(tavern_events.CHAT_CHANGED, () => {
    void consumePendingImport('聊天切换');
  });
  const chat_created = eventOn(tavern_events.CHAT_CREATED, () => {
    window.setTimeout(() => void consumePendingImport('聊天创建'), 0);
  });
  const stop_import_response_watcher = installImportResponseWatcher();

  return () => {
    host_document.removeEventListener('change', on_file_change, true);
    stopImportRetry();
    if (file_input_poll_timer !== null) {
      window.clearInterval(file_input_poll_timer);
      file_input_poll_timer = null;
    }
    chat_changed.stop();
    chat_created.stop();
    stop_import_response_watcher();
  };
}

export function installRenameHook(): () => void {
  const owner = getScriptId();
  const first_silly_tavern = SillyTavern;
  const second_silly_tavern = SillyTavern;
  const patch_target =
    first_silly_tavern === second_silly_tavern && typeof first_silly_tavern.renameChat === 'function'
      ? first_silly_tavern
      : null;
  if (!patch_target) {
    return () => {};
  }

  const patch_host = getHostWindow() as Window & Record<string, RenamePatchState | undefined>;
  let patch_state = patch_host[RENAME_PATCH_KEY];

  if (!patch_state) {
    patch_state = {
      original: patch_target.renameChat.bind(patch_target),
      owners: new Set(),
      target: patch_target,
    };
    patch_host[RENAME_PATCH_KEY] = patch_state;

    (patch_target as unknown as { renameChat: typeof SillyTavern.renameChat }).renameChat = async (
      old_name: string,
      new_name: string,
    ) => {
      await patch_state!.original(old_name, new_name);
      await completeRenameSideEffects(old_name, new_name);
    };
  }

  patch_state.owners.add(owner);

  return () => {
    const current_state = patch_host[RENAME_PATCH_KEY];
    if (!current_state) {
      return;
    }

    current_state.owners.delete(owner);
    if (current_state.owners.size === 0) {
      (current_state.target as unknown as { renameChat: typeof SillyTavern.renameChat }).renameChat =
        current_state.original;
      delete patch_host[RENAME_PATCH_KEY];
    }
  };
}
