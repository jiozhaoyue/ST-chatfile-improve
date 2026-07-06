<template>
  <div class="chat-file-enhance-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>聊天文件增强</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="chat-file-enhance-row">
          <input v-model="settings.useImportedFileName" type="checkbox" />
          <span>聊天文件默认用文件名命名</span>
        </label>
        <label class="chat-file-enhance-row">
          <input v-model="settings.showImportRenameDialog" type="checkbox" />
          <span>导入后自动开重命名弹窗</span>
        </label>
        <label class="chat-file-enhance-row">
          <input v-model="settings.autoRepairRelationsAfterRename" type="checkbox" />
          <span>重命名聊天文件自动修复关系链</span>
        </label>
        <label class="chat-file-enhance-row">
          <input v-model="settings.reloadChatHistoryAfterRename" type="checkbox" />
          <span>删除/导入/改名后重新加载聊天记录</span>
        </label>

        <div class="chat-file-enhance-block">
          <div class="chat-file-enhance-title">手动安全改名</div>
          <div class="chat-file-enhance-controls">
            <input
              v-model.trim="manualName"
              class="text_pole"
              placeholder="新的聊天文件名"
              type="text"
              @keyup.enter="handleRename"
            />
            <input class="menu_button" type="button" value="重命名" @click="handleRename" />
          </div>
        </div>

        <div class="chat-file-enhance-block">
          <div class="chat-file-enhance-title">关系链检查</div>
          <div class="chat-file-enhance-status">
            <span>当前聊天: {{ inspection?.currentChatName || '未读取' }}</span>
            <span>关系字段: {{ inspection?.mentionCount ?? 0 }}</span>
            <span>疑似断链: {{ inspection?.broken.length ?? 0 }}</span>
          </div>
          <div class="chat-file-enhance-controls">
            <input class="menu_button" type="button" value="刷新检查" @click="refreshInspection" />
            <input class="menu_button" type="button" value="一键修复" @click="handleRepair" />
          </div>
          <ul v-if="inspection?.warnings.length" class="chat-file-enhance-list">
            <li v-for="warning in inspection.warnings" :key="warning">{{ warning }}</li>
          </ul>
          <ul v-if="inspection?.broken.length" class="chat-file-enhance-list">
            <li v-for="issue in inspection.broken.slice(0, 5)" :key="`${issue.source}.${issue.path}`">
              {{ issue.source }}.{{ issue.path }} -> {{ issue.value }}
            </li>
          </ul>
        </div>

        <div class="chat-file-enhance-block">
          <div class="chat-file-enhance-title">操作记录</div>
          <ul class="chat-file-enhance-list">
            <li v-for="record in settings.records.slice(0, 6)" :key="`${record.time}-${record.action}-${record.detail}`">
              {{ record.time }} · {{ record.action }} · {{ record.result }}
              <span v-if="record.oldName || record.newName">: {{ record.oldName || '-' }} -> {{ record.newName || '-' }}</span>
              <span v-if="record.detail"> · {{ record.detail }}</span>
            </li>
            <li v-if="settings.records.length === 0">暂无记录</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { onMounted, ref } from 'vue';
import { inspectCurrentRelations, RelationInspection, repairCurrentRelations, safeRenameCurrentChat } from './runtime';
import { useSettingsStore } from './settings';

const settings_store = useSettingsStore();
const { settings } = storeToRefs(settings_store);

const manualName = ref('');
const inspection = ref<RelationInspection | null>(null);

async function refreshInspection(): Promise<void> {
  inspection.value = await inspectCurrentRelations();
}

async function handleRename(): Promise<void> {
  await safeRenameCurrentChat(manualName.value);
  manualName.value = '';
  await refreshInspection();
}

async function handleRepair(): Promise<void> {
  const old_name = window.prompt('要替换的旧聊天文件名');
  if (!old_name) {
    return;
  }
  const new_name = window.prompt('替换为哪个聊天文件名', SillyTavern.getCurrentChatId());
  if (!new_name) {
    return;
  }

  const record = await repairCurrentRelations(old_name, new_name);
  settings_store.addRecord(record);
  if (record.result === 'success') {
    toastr.success(record.detail ?? '关系链修复完成');
  } else {
    toastr.warning(record.detail ?? '关系链未完成修复');
  }
  await refreshInspection();
}

onMounted(() => {
  manualName.value = SillyTavern.getCurrentChatId();
  void refreshInspection();
});
</script>

<style scoped>
.chat-file-enhance-settings {
  margin-block: 0.5rem;
}

.chat-file-enhance-row {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  margin: 0.35rem 0;
}

.chat-file-enhance-block {
  border-top: 1px solid var(--SmartThemeBorderColor);
  margin-top: 0.65rem;
  padding-top: 0.65rem;
}

.chat-file-enhance-title {
  font-weight: 700;
  margin-bottom: 0.35rem;
}

.chat-file-enhance-controls {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.chat-file-enhance-controls .text_pole {
  flex: 1 1 14rem;
  min-width: 0;
}

.chat-file-enhance-status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  margin-bottom: 0.45rem;
}

.chat-file-enhance-list {
  margin: 0.45rem 0 0;
  padding-left: 1.25rem;
}
</style>
