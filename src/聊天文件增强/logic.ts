const CHAT_IMPORT_EXTENSIONS = new Set(['.json', '.jsonl']);
const ILLEGAL_CHAT_NAME_CHARACTERS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const RELATION_KEY_PATTERN = /(checkpoint|parent|chat|file|filename|file_name)/i;
const DELETE_CHAT_FILE_KEY_PATTERN = /(chat.*file|chatfile|chat_file|file_name|filename|chat_id|chat)/i;

export type RelationReplacement = {
  path: string;
  oldValue: string;
  newValue: string;
};

export type RelationMention = {
  path: string;
  value: string;
};

export type RelationReplaceResult<T> = {
  value: T;
  replacements: RelationReplacement[];
};

export type ChatRenameNames = {
  oldName: string;
  newName: string;
};

function getBaseName(file_name: string): string {
  return file_name.replace(/^.*[\\/]/, '');
}

function removeExtension(file_name: string): string {
  return file_name.replace(/\.[^.\\/]+$/, '');
}

function getExtension(file_name: string): string {
  return file_name.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? '';
}

export function sanitizeImportedChatName(file_name: string): string {
  return sanitizeChatName(removeExtension(getBaseName(file_name.trim())));
}

export function sanitizeChatName(chat_name: string): string {
  return Array.from(chat_name)
    .map(character => (ILLEGAL_CHAT_NAME_CHARACTERS.has(character) || character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
    .trim()
    .replace(/^\.+|\.+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushSanitizedChatFileName(names: string[], value: string): void {
  const sanitized = sanitizeImportedChatName(value) || sanitizeChatName(value);
  if (sanitized && !names.includes(sanitized)) {
    names.push(sanitized);
  }
}

function looksLikeChatMessage(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    ('mes' in value || 'message' in value) &&
    ('name' in value || 'is_user' in value || 'send_date' in value || 'swipes' in value)
  );
}

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isLikelyChatImportFile(file_name: string, content?: string): boolean {
  if (!CHAT_IMPORT_EXTENSIONS.has(getExtension(file_name))) {
    return false;
  }

  if (content === undefined) {
    return true;
  }

  const trimmed = content.trim();
  if (trimmed === '') {
    return false;
  }

  if (getExtension(file_name) === '.jsonl') {
    return trimmed
      .split(/\r?\n/)
      .filter(line => line.trim() !== '')
      .slice(0, 20)
      .some(line => looksLikeChatMessage(parseJsonSafely(line)));
  }

  const parsed = parseJsonSafely(trimmed);
  if (Array.isArray(parsed)) {
    return parsed.some(looksLikeChatMessage);
  }
  if (!isRecord(parsed)) {
    return false;
  }

  if (looksLikeChatMessage(parsed)) {
    return true;
  }

  const maybe_messages = parsed.messages ?? parsed.chat;
  return Array.isArray(maybe_messages) && maybe_messages.some(looksLikeChatMessage);
}

export function shouldPromptForImportedRename(options: {
  showImportRenameDialog: boolean;
  targetNameExists: boolean;
}): boolean {
  return options.showImportRenameDialog || options.targetNameExists;
}

export function extractChatRenameNamesFromRequestBody(body: string): ChatRenameNames | null {
  const parsed = parseJsonSafely(body);
  if (!isRecord(parsed)) {
    return null;
  }

  const old_name_value = parsed.original_file ?? parsed.old_file ?? parsed.oldFileName;
  const new_name_value = parsed.renamed_file ?? parsed.new_file ?? parsed.newFileName;
  if (typeof old_name_value !== 'string' || typeof new_name_value !== 'string') {
    return null;
  }

  const old_name = sanitizeImportedChatName(old_name_value) || sanitizeChatName(old_name_value);
  const new_name = sanitizeImportedChatName(new_name_value) || sanitizeChatName(new_name_value);
  return old_name && new_name ? { oldName: old_name, newName: new_name } : null;
}

export function extractChatDeleteNamesFromRequestBody(body: string): string[] {
  const parsed = parseJsonSafely(body);
  const names: string[] = [];

  const visit = (target: unknown, relation_key = false): void => {
    if (typeof target === 'string') {
      if (relation_key) {
        pushSanitizedChatFileName(names, target);
      }
      return;
    }

    if (Array.isArray(target)) {
      target.forEach(item => visit(item, relation_key));
      return;
    }

    if (!isRecord(target)) {
      return;
    }

    Object.entries(target).forEach(([key, child]) => {
      visit(child, relation_key || DELETE_CHAT_FILE_KEY_PATTERN.test(key));
    });
  };

  visit(parsed);
  return names;
}

function cloneAndReplace(
  value: unknown,
  old_name: string,
  new_name: string,
  path: string[],
  is_relation_context: boolean,
  replacements: RelationReplacement[],
): unknown {
  if (typeof value === 'string') {
    if (is_relation_context && value === old_name) {
      replacements.push({ path: path.join('.'), oldValue: old_name, newValue: new_name });
      return new_name;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      cloneAndReplace(item, old_name, new_name, path.concat(String(index)), is_relation_context, replacements),
    );
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const child_is_relation = is_relation_context || RELATION_KEY_PATTERN.test(key);
        return [
          key,
          cloneAndReplace(child, old_name, new_name, path.concat(key), child_is_relation, replacements),
        ];
      }),
    );
  }

  return value;
}

export function replaceRelationNames<T>(value: T, old_name: string, new_name: string): RelationReplaceResult<T> {
  const replacements: RelationReplacement[] = [];
  return {
    value: cloneAndReplace(value, old_name, new_name, [], false, replacements) as T,
    replacements,
  };
}

function collectMentions(
  value: unknown,
  target_name: string,
  path: string[],
  is_relation_context: boolean,
  mentions: RelationMention[],
): void {
  if (typeof value === 'string') {
    if (is_relation_context && value === target_name) {
      mentions.push({ path: path.join('.'), value });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectMentions(item, target_name, path.concat(String(index)), is_relation_context, mentions),
    );
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  Object.entries(value).forEach(([key, child]) => {
    collectMentions(child, target_name, path.concat(key), is_relation_context || RELATION_KEY_PATTERN.test(key), mentions);
  });
}

export function collectRelationMentions(value: unknown, target_name: string): RelationMention[] {
  const mentions: RelationMention[] = [];
  collectMentions(value, target_name, [], false, mentions);
  return mentions;
}

function collectRelationValues(
  value: unknown,
  path: string[],
  is_relation_context: boolean,
  mentions: RelationMention[],
): void {
  if (typeof value === 'string') {
    if (is_relation_context) {
      mentions.push({ path: path.join('.'), value });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRelationValues(item, path.concat(String(index)), is_relation_context, mentions));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  Object.entries(value).forEach(([key, child]) => {
    collectRelationValues(child, path.concat(key), is_relation_context || RELATION_KEY_PATTERN.test(key), mentions);
  });
}

export function collectRelationStringValues(value: unknown): RelationMention[] {
  const mentions: RelationMention[] = [];
  collectRelationValues(value, [], false, mentions);
  return mentions;
}
