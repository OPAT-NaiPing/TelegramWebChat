import md5 from 'md5';

import {
  getRequiredServerState,
  getServerBaseApi,
  getServerSignedHeaders,
  normalizeServerUrl,
  requestServerWs,
  SERVER_TOOL_CODES,
} from './serverAccounts';

export type ServerToolPage = 'speech' | 'translate' | 'settings';

export type ServerMaterialGroup = {
  ID: number;
  id?: number;
  name: string;
  [key: string]: any;
};

export type ServerMaterialData = {
  type: number;
  content?: string;
  media?: {
    Url?: string;
    Name?: string;
    Size?: number;
    [key: string]: any;
  };
  [key: string]: any;
};

export type ServerMaterial = {
  ID: number;
  id?: number;
  gid?: number;
  type?: number;
  name: string;
  data: ServerMaterialData;
  [key: string]: any;
};

export type ServerTranslateConfig = {
  cid?: number;
  isolate?: boolean;
  sendAuto?: boolean;
  sendAutoType?: number;
  sendAutoLanguage?: string;
  receiveAuto?: boolean;
  receiveAutoType?: number;
  receiveAutoLanguage?: string;
  imgAuto?: boolean;
  voiceAuto?: boolean;
};

export type ServerToolSettings = {
  autoTranslation: boolean;
  previewTranslation: boolean;
  pageLanguage: string;
  sendAuto: boolean;
  sendAutoLanguage: string;
  sendAutoType: number;
  receiveAuto: boolean;
  receiveAutoLanguage: string;
  receiveAutoType: number;
};

export type ServerMaterialEditInput = {
  ID?: number;
  gid: number;
  name: string;
  data: ServerMaterialData;
  type?: number;
};

export type ServerToolUploadResult = {
  ID?: number;
  url: string;
  path?: string;
  name: string;
  size: number;
  fileType: number;
};

export type ServerToolMessage =
  | {
    type: 'server-tool-send-text';
    text: string;
  }
  | {
    type: 'server-tool-send-material';
    material: ServerMaterial;
  }
  | {
    type: 'server-tool-insert-text';
    text: string;
  }
  | {
    type: 'server-tool-settings-updated';
    settings: ServerToolSettings;
  };

const SETTINGS_STORAGE_KEY = 'serverToolSettings';
const TRANSLATION_CACHE_STORAGE_KEY = 'serverToolTranslationCache';
const RECEIVE_TRANSLATION_SUPPRESSED_STORAGE_KEY = 'serverToolReceiveTranslationSuppressed';
const MATERIAL_PAGE_SIZE = 30;
const SERVER_TOOL_UPLOAD_SOURCE_TYPE = 6;

export const DEFAULT_SERVER_TOOL_SETTINGS: ServerToolSettings = {
  autoTranslation: false,
  previewTranslation: false,
  pageLanguage: 'cn',
  sendAuto: false,
  sendAutoLanguage: 'cn',
  sendAutoType: 1,
  receiveAuto: false,
  receiveAutoLanguage: 'cn',
  receiveAutoType: 1,
};

export const SERVER_TOOL_LANGUAGES = [
  { value: 'cn', label: '简体中文' },
  { value: 'tw', label: '繁体中文' },
  { value: 'en', label: 'English' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'he', label: 'עברית' },
  { value: 'fa', label: 'فارسی' },
  { value: 'pl', label: 'Polski' },
  { value: 'uz', label: 'O‘zbek' },
  { value: 'my', label: 'မြန်မာ' },
  { value: 'ru', label: 'Русский' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ar', label: 'العربية' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'uk', label: 'Українська' },
  { value: 'kk', label: 'Қазақша' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'km', label: 'ភាសាខ្មែរ' },
];

export const SERVER_TOOL_TRANSLATE_CHANNELS = [
  { value: 0, label: '自定义' },
  { value: 1, label: '免费-谷歌' },
  { value: 2, label: '免费-聚合' },
];

const SERVER_TOOL_LANGUAGE_VALUES = new Set(SERVER_TOOL_LANGUAGES.map(({ value }) => value));
const SERVER_TOOL_TRANSLATE_CHANNEL_VALUES = new Set(SERVER_TOOL_TRANSLATE_CHANNELS.map(({ value }) => value));

function getFileSuffix(filename: string) {
  const suffix = filename.split('.').pop();
  return suffix ? `.${suffix}` : '';
}

async function requestServerToolJson<T>(path: string, options: {
  method?: 'GET' | 'POST';
  data?: Record<string, any>;
}) {
  const baseApi = getServerBaseApi();
  if (!baseApi) throw new Error('未配置 SERVER_BASE_API');

  const currentState = getRequiredServerState();
  const method = options.method || 'POST';
  const data = options.data || {};
  const url = new URL(normalizeServerUrl(baseApi, path), window.location.href);
  if (method === 'GET') {
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) url.searchParams.set(key, String(value));
    });
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      ...getServerSignedHeaders(method === 'GET' ? data : {}),
      'x-token': currentState.token,
    },
    body: method === 'POST' ? JSON.stringify(data) : undefined,
  });

  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json() as Promise<T>;
}

async function getServerToolFileMd5(file: Blob) {
  return md5(new Uint8Array(await file.arrayBuffer()));
}

function parseMaterialData(data: unknown): ServerMaterialData {
  if (!data) return { type: 1, content: '' };
  if (typeof data === 'object') return data as ServerMaterialData;
  if (typeof data !== 'string') return { type: 1, content: '' };

  try {
    return JSON.parse(data) as ServerMaterialData;
  } catch (err) {
    return { type: 1, content: data };
  }
}

function normalizeMaterial(item: any): ServerMaterial {
  return {
    ...item,
    data: parseMaterialData(item.data),
  };
}

function getTranslationCacheKey(content: string, targetLang: string, type: number) {
  return `${type}:${targetLang}:${content}`;
}

function normalizeServerTranslateLanguage(language: unknown, fallback = DEFAULT_SERVER_TOOL_SETTINGS.sendAutoLanguage) {
  if (language === undefined) return fallback;

  const value = typeof language === 'string' || typeof language === 'number'
    ? String(language).trim().toLowerCase()
    : '';
  if (!value) return fallback;
  if (value === 'zh' || value.startsWith('zh-hans') || value === 'zh-cn') return 'cn';
  if (value.startsWith('zh-hant') || value === 'zh-tw' || value === 'zh-hk') return 'tw';

  const normalized = value.split('-')[0] || fallback;
  return SERVER_TOOL_LANGUAGE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeServerTranslateType(type: unknown, fallback = 1) {
  const value = Number(type);
  if (!Number.isFinite(value)) return fallback;

  // 旧项目和后端协议中自定义翻译通道是 0，这里兼容迁移早期写入的 3。
  const normalized = value === 3 ? 0 : value;
  if (!SERVER_TOOL_TRANSLATE_CHANNEL_VALUES.has(normalized)) return fallback;

  return normalized;
}

function normalizeServerToolBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }

  return fallback;
}

function hasServerToolValue(source: Record<string, any>, keys: string[]) {
  return keys.some((key) => source[key] !== undefined);
}

function getServerToolValue(source: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }

  return undefined;
}

function unwrapServerTranslateConfig(rawConfig: unknown) {
  if (!rawConfig || typeof rawConfig !== 'object') return {};

  const config = rawConfig as Record<string, any>;
  const nestedConfig = config.data;
  if (nestedConfig && typeof nestedConfig === 'object') {
    return nestedConfig as Record<string, any>;
  }

  return config;
}

function normalizeServerTranslateConfig(rawConfig: unknown, cid = 0): ServerTranslateConfig {
  const config = unwrapServerTranslateConfig(rawConfig);
  const hasSendAutoType = hasServerToolValue(config, ['sendAutoType', 'send_auto_type', 'sendType']);
  const hasSendAutoLanguage = hasServerToolValue(
    config,
    ['sendAutoLanguage', 'send_auto_language', 'sendLanguage', 'sendLang'],
  );
  const hasReceiveAutoType = hasServerToolValue(config, ['receiveAutoType', 'receive_auto_type', 'receiveType']);
  const hasReceiveAutoLanguage = hasServerToolValue(
    config,
    ['receiveAutoLanguage', 'receive_auto_language', 'receiveLanguage', 'receiveLang'],
  );
  const sendAutoLanguage = normalizeServerTranslateLanguage(
    getServerToolValue(config, ['sendAutoLanguage', 'send_auto_language', 'sendLanguage', 'sendLang']),
    DEFAULT_SERVER_TOOL_SETTINGS.sendAutoLanguage,
  );
  const receiveAutoLanguage = normalizeServerTranslateLanguage(
    getServerToolValue(config, ['receiveAutoLanguage', 'receive_auto_language', 'receiveLanguage', 'receiveLang']),
    DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoLanguage,
  );

  // 后端历史版本可能返回字符串、数字或嵌套 data，这里统一成控件 option 能匹配的值。
  return {
    cid: Number(getServerToolValue(config, ['cid', 'CID']) ?? cid) || cid,
    isolate: normalizeServerToolBoolean(getServerToolValue(config, ['isolate']), false),
    sendAuto: normalizeServerToolBoolean(getServerToolValue(config, ['sendAuto', 'send_auto']), false),
    sendAutoType: hasSendAutoType ? normalizeServerTranslateType(
      getServerToolValue(config, ['sendAutoType', 'send_auto_type', 'sendType']),
      DEFAULT_SERVER_TOOL_SETTINGS.sendAutoType,
    ) : undefined,
    sendAutoLanguage: hasSendAutoLanguage ? sendAutoLanguage : undefined,
    receiveAuto: normalizeServerToolBoolean(getServerToolValue(config, ['receiveAuto', 'receive_auto']), false),
    receiveAutoType: hasReceiveAutoType ? normalizeServerTranslateType(
      getServerToolValue(config, ['receiveAutoType', 'receive_auto_type', 'receiveType']),
      DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoType,
    ) : undefined,
    receiveAutoLanguage: hasReceiveAutoLanguage ? receiveAutoLanguage : undefined,
    imgAuto: normalizeServerToolBoolean(getServerToolValue(config, ['imgAuto', 'img_auto']), false),
    voiceAuto: normalizeServerToolBoolean(getServerToolValue(config, ['voiceAuto', 'voice_auto']), false),
  };
}

export function loadServerToolSettings(): ServerToolSettings {
  try {
    const settings = {
      ...DEFAULT_SERVER_TOOL_SETTINGS,
      ...JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'),
    };

    return {
      ...settings,
      sendAutoLanguage: normalizeServerTranslateLanguage(
        settings.sendAutoLanguage,
        DEFAULT_SERVER_TOOL_SETTINGS.sendAutoLanguage,
      ),
      sendAutoType: normalizeServerTranslateType(settings.sendAutoType, DEFAULT_SERVER_TOOL_SETTINGS.sendAutoType),
      receiveAutoLanguage: normalizeServerTranslateLanguage(
        settings.receiveAutoLanguage,
        DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoLanguage,
      ),
      receiveAutoType: normalizeServerTranslateType(
        settings.receiveAutoType,
        DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoType,
      ),
    };
  } catch (err) {
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
    return DEFAULT_SERVER_TOOL_SETTINGS;
  }
}

export function saveServerToolSettings(settings: ServerToolSettings) {
  const normalizedSettings = {
    ...settings,
    sendAutoLanguage: normalizeServerTranslateLanguage(
      settings.sendAutoLanguage,
      DEFAULT_SERVER_TOOL_SETTINGS.sendAutoLanguage,
    ),
    sendAutoType: normalizeServerTranslateType(settings.sendAutoType, DEFAULT_SERVER_TOOL_SETTINGS.sendAutoType),
    receiveAutoLanguage: normalizeServerTranslateLanguage(
      settings.receiveAutoLanguage,
      DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoLanguage,
    ),
    receiveAutoType: normalizeServerTranslateType(
      settings.receiveAutoType,
      DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoType,
    ),
  };

  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizedSettings));
  window.dispatchEvent(new CustomEvent('server-tool-settings-updated', { detail: normalizedSettings }));
}

export function mergeServerTranslateConfigToSettings(
  config: ServerTranslateConfig,
  savedSettings = loadServerToolSettings(),
): ServerToolSettings {
  const normalizedConfig = normalizeServerTranslateConfig(config, config.cid || 0);

  return {
    ...savedSettings,
    sendAuto: Boolean(normalizedConfig.sendAuto),
    sendAutoLanguage: normalizedConfig.sendAutoLanguage || savedSettings.sendAutoLanguage,
    sendAutoType: normalizedConfig.sendAutoType ?? savedSettings.sendAutoType,
    receiveAuto: Boolean(normalizedConfig.receiveAuto),
    receiveAutoLanguage: normalizedConfig.receiveAutoLanguage || savedSettings.receiveAutoLanguage,
    receiveAutoType: normalizedConfig.receiveAutoType ?? savedSettings.receiveAutoType,
  };
}

export function normalizeServerTranslateConfigForSave(config: ServerTranslateConfig): ServerTranslateConfig {
  const normalizedConfig = normalizeServerTranslateConfig(config, config.cid || 0);

  return {
    ...config,
    cid: normalizedConfig.cid,
    isolate: Boolean(normalizedConfig.isolate),
    sendAuto: Boolean(normalizedConfig.sendAuto),
    sendAutoType: normalizedConfig.sendAutoType ?? DEFAULT_SERVER_TOOL_SETTINGS.sendAutoType,
    sendAutoLanguage: normalizedConfig.sendAutoLanguage || DEFAULT_SERVER_TOOL_SETTINGS.sendAutoLanguage,
    receiveAuto: Boolean(normalizedConfig.receiveAuto),
    receiveAutoType: normalizedConfig.receiveAutoType ?? DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoType,
    receiveAutoLanguage: normalizedConfig.receiveAutoLanguage || DEFAULT_SERVER_TOOL_SETTINGS.receiveAutoLanguage,
    imgAuto: Boolean(normalizedConfig.imgAuto),
    voiceAuto: Boolean(normalizedConfig.voiceAuto),
  };
}

export function clearServerMaterialCache() {
  localStorage.removeItem('serverToolMaterialGroups');
  localStorage.removeItem('serverToolMaterialMap');
}

function loadTranslationCache() {
  try {
    return JSON.parse(localStorage.getItem(TRANSLATION_CACHE_STORAGE_KEY) || '{}') as Record<string, string>;
  } catch (err) {
    localStorage.removeItem(TRANSLATION_CACHE_STORAGE_KEY);
    return {};
  }
}

function saveTranslationCache(cache: Record<string, string>) {
  localStorage.setItem(TRANSLATION_CACHE_STORAGE_KEY, JSON.stringify(cache));
}

export function getCachedServerTranslation(content: string, targetLang: string, type = 1) {
  return loadTranslationCache()[getTranslationCacheKey(content, targetLang, type)];
}

export function setCachedServerTranslation(content: string, targetLang: string, type: number, translated: string) {
  const cache = loadTranslationCache();
  cache[getTranslationCacheKey(content, targetLang, type)] = translated;
  saveTranslationCache(cache);
}

export function getServerReceiveTranslationOptions() {
  const settings = loadServerToolSettings();
  if (!settings.receiveAuto) return undefined;

  return {
    targetLang: settings.receiveAutoLanguage,
    type: normalizeServerTranslateType(settings.receiveAutoType),
  };
}

function getSuppressedReceiveTranslationKey(chatId: string, messageId: number, targetLang?: string) {
  return `${chatId}:${messageId}:${targetLang || 'all'}`;
}

function loadSuppressedReceiveTranslations() {
  try {
    return JSON.parse(
      localStorage.getItem(RECEIVE_TRANSLATION_SUPPRESSED_STORAGE_KEY) || '{}',
    ) as Record<string, true>;
  } catch (err) {
    localStorage.removeItem(RECEIVE_TRANSLATION_SUPPRESSED_STORAGE_KEY);
    return {};
  }
}

export function suppressServerReceiveTranslation(chatId: string, messageId: number, targetLang?: string) {
  const suppressed = loadSuppressedReceiveTranslations();
  suppressed[getSuppressedReceiveTranslationKey(chatId, messageId, targetLang)] = true;
  localStorage.setItem(RECEIVE_TRANSLATION_SUPPRESSED_STORAGE_KEY, JSON.stringify(suppressed));
}

export function allowServerReceiveTranslation(chatId: string, messageId: number, targetLang?: string) {
  const suppressed = loadSuppressedReceiveTranslations();
  const keys = targetLang
    ? [
      getSuppressedReceiveTranslationKey(chatId, messageId, targetLang),
      getSuppressedReceiveTranslationKey(chatId, messageId),
    ]
    : Object.keys(suppressed).filter((key) => key.startsWith(`${chatId}:${messageId}:`));

  if (!keys.some((key) => suppressed[key])) return;

  keys.forEach((key) => {
    delete suppressed[key];
  });

  localStorage.setItem(RECEIVE_TRANSLATION_SUPPRESSED_STORAGE_KEY, JSON.stringify(suppressed));
}

export function isServerReceiveTranslationSuppressed(chatId: string, messageId: number, targetLang?: string) {
  const suppressed = loadSuppressedReceiveTranslations();

  return Boolean(
    suppressed[getSuppressedReceiveTranslationKey(chatId, messageId)]
    || (targetLang && suppressed[getSuppressedReceiveTranslationKey(chatId, messageId, targetLang)]),
  );
}

export async function fetchServerMaterialGroups(type = 1) {
  const response = await requestServerWs<{ data?: ServerMaterialGroup[]; msg?: string }>({
    code: SERVER_TOOL_CODES.MATERIAL_GROUP_LIST,
    data: JSON.stringify({
      type,
      pageSize: 100,
    }),
  });

  return response.data || [];
}

export async function fetchServerMaterials(groupId: number, offset?: unknown) {
  const response = await requestServerWs<{ data?: any[]; offset?: unknown; msg?: string }>({
    code: SERVER_TOOL_CODES.MATERIAL_LIST,
    data: JSON.stringify({
      ID: groupId,
      offset,
      pageSize: MATERIAL_PAGE_SIZE,
    }),
  });

  return {
    list: (response.data || []).map(normalizeMaterial),
    offset: response.offset,
  };
}

export async function createServerMaterialGroup(name: string, type = 1) {
  const response = await requestServerWs<{ data?: ServerMaterialGroup; msg?: string }>({
    code: SERVER_TOOL_CODES.MATERIAL_GROUP_CREATE,
    data: JSON.stringify({ name, type }),
  });

  return response.data;
}

export async function updateServerMaterialGroup(ID: number, name: string, type = 1) {
  const response = await requestServerWs<{ data?: ServerMaterialGroup; msg?: string }>({
    code: SERVER_TOOL_CODES.MATERIAL_GROUP_UPDATE,
    data: JSON.stringify({ ID, name, type }),
  });

  return response.data;
}

export async function deleteServerMaterialGroup(ID: number) {
  await requestServerWs({
    code: SERVER_TOOL_CODES.MATERIAL_GROUP_DELETE,
    data: JSON.stringify({ ID }),
  });
}

export async function clearServerMaterialGroup(ID: number) {
  await requestServerWs({
    code: SERVER_TOOL_CODES.MATERIAL_GROUP_CLEAR,
    data: JSON.stringify({ ID }),
  });
}

function buildMaterialPayload(input: ServerMaterialEditInput) {
  return {
    ...input,
    type: input.type || 1,
    data: JSON.stringify(input.data),
  };
}

export async function createServerMaterial(input: ServerMaterialEditInput) {
  const response = await requestServerWs<{ data?: any; msg?: string }>({
    code: SERVER_TOOL_CODES.MATERIAL_CREATE,
    data: JSON.stringify(buildMaterialPayload(input)),
  });

  return response.data ? normalizeMaterial(response.data) : undefined;
}

export async function updateServerMaterial(input: ServerMaterialEditInput) {
  const response = await requestServerWs<{ data?: any; msg?: string }>({
    code: SERVER_TOOL_CODES.MATERIAL_UPDATE,
    data: JSON.stringify(buildMaterialPayload(input)),
  });

  return response.data ? normalizeMaterial(response.data) : undefined;
}

export async function deleteServerMaterial(ID: number) {
  await requestServerWs({
    code: SERVER_TOOL_CODES.MATERIAL_DELETE,
    data: JSON.stringify({ ID }),
  });
}

export async function uploadServerToolMaterialFile(file: File, fileType: number): Promise<ServerToolUploadResult> {
  const fileInfo = {
    suffix: getFileSuffix(file.name),
    md5: await getServerToolFileMd5(file),
    size: file.size,
    type: fileType,
    name: file.name,
    fileType,
    sourceType: SERVER_TOOL_UPLOAD_SOURCE_TYPE,
    groupId: 0,
  };

  const signResponse = await requestServerToolJson<{
    code?: number;
    msg?: string;
    data?: {
      Exist?: boolean;
      ID?: number;
      url?: string;
      path?: string;
      name?: string;
      SectionSize?: number;
      Sign?: string;
      URL?: string;
      Section?: string[];
    };
  }>('/uploadFile/getFileSign', {
    method: 'GET',
    data: fileInfo,
  });

  if (signResponse.code !== 0 || !signResponse.data) {
    throw new Error(signResponse.msg || '获取文件签名失败');
  }

  if (signResponse.data.Exist) {
    return {
      ID: signResponse.data.ID,
      url: signResponse.data.url || '',
      path: signResponse.data.path,
      name: file.name,
      size: file.size,
      fileType,
    };
  }

  const signInfo = signResponse.data;
  const sectionSize = signInfo.SectionSize || file.size;
  if (!signInfo.Sign || !signInfo.URL || sectionSize < 1) {
    throw new Error('文件签名数据异常');
  }

  const chunkCount = Math.max(Math.ceil(file.size / sectionSize), 1);
  let uploadedChunks = 0;
  const existedSections = new Set((signInfo.Section || []).map(String));

  for (let index = 0; index < chunkCount; index++) {
    if (existedSections.has(String(index))) {
      uploadedChunks++;
      continue;
    }

    const chunk = file.slice(index * sectionSize, Math.min(file.size, (index + 1) * sectionSize));
    const formData = new FormData();
    formData.append('md5', await getServerToolFileMd5(chunk));
    formData.append('sign', signInfo.Sign);
    formData.append('file', chunk);
    formData.append('index', String(index));

    const uploadResponse = await fetch(signInfo.URL, {
      method: 'POST',
      body: formData,
    });
    const uploadResult = await uploadResponse.json().catch(() => undefined);
    if (!uploadResponse.ok || uploadResult?.code !== 0) {
      throw new Error(uploadResult?.msg || '上传文件分片失败');
    }

    uploadedChunks++;
  }

  const saveResponse = await requestServerToolJson<{
    code?: number;
    msg?: string;
    data?: {
      ID?: number;
      url?: string;
      path?: string;
      name?: string;
      groupId?: number;
    };
  }>('/uploadFile/fileSave', {
    method: 'POST',
    data: {
      ...fileInfo,
      sign: signInfo.Sign,
      chunkCount,
      uploadedChunks,
      failCount: 0,
    },
  });

  if (saveResponse.code !== 0 || !saveResponse.data?.url) {
    throw new Error(saveResponse.msg || '保存上传文件失败');
  }

  return {
    ID: saveResponse.data.ID,
    url: saveResponse.data.url,
    path: saveResponse.data.path,
    name: saveResponse.data.name || file.name,
    size: file.size,
    fileType,
  };
}

export async function fetchServerTranslateConfig(cid = 0) {
  const response = await requestServerWs<{ data?: ServerTranslateConfig; msg?: string }>({
    aid: 0,
    code: SERVER_TOOL_CODES.TRANSLATE_CONFIG_GET,
    data: JSON.stringify({ cid }),
  });

  return normalizeServerTranslateConfig(response.data, cid);
}

export async function saveServerTranslateConfig(config: ServerTranslateConfig) {
  const normalizedConfig = normalizeServerTranslateConfigForSave(config);
  const response = await requestServerWs<{ data?: { code?: number; msg?: string }; msg?: string }>({
    aid: 0,
    code: SERVER_TOOL_CODES.TRANSLATE_CONFIG_SET,
    data: JSON.stringify(normalizedConfig),
  });

  const businessCode = response.data?.code ?? 0;
  if (businessCode !== 0) {
    throw new Error(response.data?.msg || response.msg || '保存翻译设置失败');
  }

  return normalizedConfig;
}

export async function translateServerText(content: string, options?: {
  targetLang?: string;
  type?: number;
  msgID?: string;
}) {
  const settings = loadServerToolSettings();
  const targetLang = normalizeServerTranslateLanguage(options?.targetLang || settings.sendAutoLanguage);
  const type = normalizeServerTranslateType(options?.type ?? settings.sendAutoType, 1);
  const cached = getCachedServerTranslation(content, targetLang, type);
  if (cached) return cached;

  const response = await requestServerWs<{ data?: string; msg?: string }>({
    code: SERVER_TOOL_CODES.TRANSLATE_TEXT,
    data: JSON.stringify({
      type,
      targetLang,
      msgID: options?.msgID || '',
      content,
    }),
  });

  const translated = response.data || content;
  setCachedServerTranslation(content, targetLang, type, translated);
  return translated;
}

export function postServerToolMessageToFrame(frame: HTMLIFrameElement | undefined, message: ServerToolMessage) {
  frame?.contentWindow?.postMessage(message, window.location.origin);
}

export function isServerToolMessage(data: unknown): data is ServerToolMessage {
  if (!data || typeof data !== 'object') return false;
  const type = (data as { type?: string }).type;
  return type === 'server-tool-send-text'
    || type === 'server-tool-send-material'
    || type === 'server-tool-insert-text'
    || type === 'server-tool-settings-updated';
}
