export type OperationRecord = {
  time: string;
  action: string;
  result: 'success' | 'blocked' | 'failed' | 'skipped' | 'info';
  oldName?: string;
  newName?: string;
  detail?: string;
};

const Settings = z
  .object({
    useImportedFileName: z.boolean().default(true),
    showImportRenameDialog: z.boolean().default(false),
    autoRepairRelationsAfterRename: z.boolean().default(true),
    reloadChatHistoryAfterRename: z.boolean().default(true),
    records: z.array(z.any()).default([]),
  })
  .prefault({});

export type ChatFileEnhanceSettings = z.infer<typeof Settings>;

export const useSettingsStore = defineStore('chat-file-enhance-settings', () => {
  const settings = ref<ChatFileEnhanceSettings>(
    Settings.parse(getVariables({ type: 'script', script_id: getScriptId() })),
  );

  function addRecord(record: Omit<OperationRecord, 'time'>): void {
    settings.value.records = [
      {
        time: new Date().toLocaleString(),
        ...record,
      },
      ...settings.value.records,
    ].slice(0, 30);
  }

  watchEffect(() => {
    insertOrAssignVariables(klona(settings.value), { type: 'script', script_id: getScriptId() });
  });

  return { addRecord, settings };
});
