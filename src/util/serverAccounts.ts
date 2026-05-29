import { gunzipSync } from 'fflate';

import type { ApiServerDeviceConfig, ApiSessionData } from '../api/types';
import type { GlobalState } from '../global/types';
import type { SharedSessionData } from '../types';

import { FALLBACK_LANG_CODE, SERVER_ACCOUNT_DEFAULT_LANG_CODE, SESSION_ACCOUNT_PREFIX } from '../config';
import {
  ACCOUNT_SLOT,
  getAccountSlotUrl,
  loadSlotSession,
  writeSlotSession,
} from './multiaccount';
import {
  clearStoredSession,
  hasStoredSession,
} from './sessions';

// 系统指令从 0x0000 开始，命名对齐旧服务 Go 端常量，避免前后端语义偏差。
export const SERVER_SYSTEM_CODES = {
  System: 0x0000,
  PushSystemOffline: 0x0001,
  PushSystemErr: 0x0002,
  SystemCleanSelected: 0x0003,
  PushSystemTip: 0x0004,
  SaveBrowserLog: 0x0005,
  PushSystemUpdate: 0x0006,
  InitSystem: 0x0007,
} as const;

const ACCOUNT_LIST_CODE = 0x1001;
const ACCOUNT_GET_ONLINE_CODE = 0x1005;
const DEFAULT_PAGE_SIZE = 50;
const REQUEST_TIMEOUT = 30000;
const WS_CONNECT_TIMEOUT = 15000;
const SERVER_ACCOUNT_STATE_KEY = 'serverAccountState';
const SERVER_ACCOUNT_SLOT_MAP_KEY = 'serverAccountSlotMap';
const SELECTED_SERVER_ACCOUNT_KEY_PREFIX = 'serverSelectedAccountId';
const SERVER_ACCOUNT_FRAME_QUERY = 'serverAccountFrame';
const SERVER_ACCOUNT_WS_REQUEST_TYPE = 'server-account-ws-request';
const SERVER_ACCOUNT_WS_RESPONSE_TYPE = 'server-account-ws-response';
const SERVER_ACCOUNT_SYSTEM_EVENT = 'server-account-system-message';
const SERVER_ACCOUNT_WS_CONNECTED_EVENT = 'server-account-ws-connected';
const SERVER_ACCOUNT_WS_DISCONNECTED_EVENT = 'server-account-ws-disconnected';

type LoginResponse = {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    user?: ServerUserInfo;
  };
};

type ServerLingoResponse = {
  code?: number;
  msg?: string;
  data?: {
    L?: string;
    language?: string;
    locale?: string;
    reload?: boolean;
    [key: string]: any;
  };
  [key: string]: any;
};

type ServerUserInfo = {
  ID?: number | string;
  id?: number | string;
  username?: string;
  userName?: string;
  [key: string]: any;
};

export type ServerAccount = {
  ID?: number | string;
  id?: number | string;
  account?: string;
  appId?: number | string;
  userId?: number | string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  remark?: string;
  username?: string;
  nickName?: string;
  headimg?: string;
  avatarUri?: string;
  dcid?: number | string;
  dcId?: number | string;
  dcID?: number | string;
  DCID?: number | string;
  authKey?: string;
  auth_key?: string;
  authkey?: string;
  auth?: string;
  cache?: string;
  Cache?: string;
  proxyIp?: string;
  ProxyIp?: string;
  proxy_ip?: string;
  proxy?: string;
  proxyUrl?: string;
  proxyURL?: string;
  mode?: number | string;
  keys?: Record<string, string>;
  [key: string]: any;
};

type AccountListResponse = {
  data?: ServerAccount[] | {
    code?: number;
    msg?: string;
  };
  offset?: unknown;
  msg?: string;
  code?: number;
  [key: string]: any;
};

export type ServerSystemMessage = AccountListResponse;

type ServerAccountWsRequestMessage = {
  type: typeof SERVER_ACCOUNT_WS_REQUEST_TYPE;
  requestId: string;
  payload: Record<string, any>;
};

type ServerAccountWsResponseMessage = {
  type: typeof SERVER_ACCOUNT_WS_RESPONSE_TYPE;
  requestId: string;
  data?: unknown;
  error?: string;
};

export type ServerAccountWsDisconnectedDetail = {
  code?: number;
  reason?: string;
  message: string;
  canReconnect?: boolean;
};

export const SERVER_TOOL_CODES = {
  MATERIAL_GROUP_LIST: 0x5001,
  MATERIAL_GROUP_CREATE: 0x5002,
  MATERIAL_GROUP_UPDATE: 0x5003,
  MATERIAL_GROUP_DELETE: 0x5004,
  MATERIAL_GROUP_CLEAR: 0x5005,
  MATERIAL_LIST: 0x5006,
  MATERIAL_CREATE: 0x5007,
  MATERIAL_UPDATE: 0x5008,
  MATERIAL_DELETE: 0x5009,
  TRANSLATE_CONFIG_GET: 0x9001,
  TRANSLATE_CONFIG_SET: 0x9002,
  TRANSLATE_TEXT: 0x9003,
} as const;

type ServerAccountState = {
  token: string;
  user?: ServerUserInfo;
  accounts: ServerAccount[];
  offset?: unknown;
  hasMore?: boolean;
};

let state: ServerAccountState | undefined;
let socket: WebSocket | undefined;
let connectingPromise: Promise<WebSocket> | undefined;
let isServerWsReconnectBlocked = false;
let serverWsReconnectBlockedMessage = '';
const pendingRequests = new Map<string, (value: AccountListResponse) => void>();
const silentClosingSockets = new WeakSet<WebSocket>();

function dispatchServerSystemMessage(message: ServerSystemMessage) {
  window.dispatchEvent(new CustomEvent<ServerSystemMessage>(SERVER_ACCOUNT_SYSTEM_EVENT, { detail: message }));
}

export function addServerSystemMessageListener(listener: (message: ServerSystemMessage) => void) {
  const eventListener = (event: Event) => {
    listener((event as CustomEvent<ServerSystemMessage>).detail);
  };

  window.addEventListener(SERVER_ACCOUNT_SYSTEM_EVENT, eventListener);

  return () => {
    window.removeEventListener(SERVER_ACCOUNT_SYSTEM_EVENT, eventListener);
  };
}

function dispatchServerWsConnected() {
  window.dispatchEvent(new CustomEvent(SERVER_ACCOUNT_WS_CONNECTED_EVENT));
}

export function addServerWsConnectedListener(listener: () => void) {
  window.addEventListener(SERVER_ACCOUNT_WS_CONNECTED_EVENT, listener);

  return () => {
    window.removeEventListener(SERVER_ACCOUNT_WS_CONNECTED_EVENT, listener);
  };
}

function dispatchServerWsDisconnected(detail: ServerAccountWsDisconnectedDetail) {
  window.dispatchEvent(new CustomEvent<ServerAccountWsDisconnectedDetail>(
    SERVER_ACCOUNT_WS_DISCONNECTED_EVENT,
    { detail },
  ));
}

export function addServerWsDisconnectedListener(listener: (detail: ServerAccountWsDisconnectedDetail) => void) {
  const eventListener = (event: Event) => {
    listener((event as CustomEvent<ServerAccountWsDisconnectedDetail>).detail);
  };

  window.addEventListener(SERVER_ACCOUNT_WS_DISCONNECTED_EVENT, eventListener);

  return () => {
    window.removeEventListener(SERVER_ACCOUNT_WS_DISCONNECTED_EVENT, eventListener);
  };
}

function rejectPendingServerWsRequests(error: Error) {
  pendingRequests.forEach((resolve) => {
    resolve({ code: -1, msg: error.message });
  });
  pendingRequests.clear();
}

function formatBrowserLogReason(reason: any) {
  if (!reason) return { message: '未知错误' };
  if (reason instanceof Error) {
    return {
      message: reason.message,
      stack: reason.stack,
      name: reason.name,
    };
  }

  return {
    message: typeof reason === 'string' ? reason : JSON.stringify(reason),
  };
}

function getSelectedAccountStorageKey() {
  return `${SELECTED_SERVER_ACCOUNT_KEY_PREFIX}_${ACCOUNT_SLOT || 1}`;
}

function getSelectedAccountStorageKeyBySlot(slot: number | undefined) {
  return `${SELECTED_SERVER_ACCOUNT_KEY_PREFIX}_${slot || 1}`;
}

function saveServerAccountSlotMap(slotMap: Record<string, number>) {
  localStorage.setItem(SERVER_ACCOUNT_SLOT_MAP_KEY, JSON.stringify(slotMap));
}

function loadServerAccountSlotMap() {
  try {
    return JSON.parse(localStorage.getItem(SERVER_ACCOUNT_SLOT_MAP_KEY) || '{}') as Record<string, number>;
  } catch (err) {
    localStorage.removeItem(SERVER_ACCOUNT_SLOT_MAP_KEY);
    return {};
  }
}

export function isServerAccountFrame() {
  return process.env.SERVER_ACCOUNT_LOGIN === '1'
    && new URLSearchParams(window.location.search).get(SERVER_ACCOUNT_FRAME_QUERY) === '1';
}

export function getServerAccountFrameUrl(slot: number, serverAccountId?: string) {
  const url = new URL(window.location.href);

  url.searchParams.set(SERVER_ACCOUNT_FRAME_QUERY, '1');
  if (serverAccountId) {
    // 服务账号 ID 只用于外层 iframe 重建，避免槽位异常复用时仍显示上一个账号界面。
    url.searchParams.set('serverAccountId', serverAccountId);
  } else {
    url.searchParams.delete('serverAccountId');
  }
  if (slot === 1) {
    url.searchParams.delete('account');
  } else {
    url.searchParams.set('account', String(slot));
  }
  url.hash = '';

  return url.toString();
}

function persistState() {
  if (!state?.token) return;

  // 旧服务 token 用于聊天页账号侧栏刷新账号列表，避免进入主界面后刷新页面丢失业务 WebSocket 登录态。
  localStorage.setItem(SERVER_ACCOUNT_STATE_KEY, JSON.stringify({
    token: state.token,
    user: state.user,
    accounts: state.accounts,
    offset: state.offset,
    hasMore: state.hasMore,
  }));
}

function restoreState() {
  if (state?.token) return state;

  try {
    const savedState = JSON.parse(
      localStorage.getItem(SERVER_ACCOUNT_STATE_KEY) || '{}',
    ) as Partial<ServerAccountState>;
    if (savedState?.token) {
      state = {
        token: savedState.token,
        user: savedState.user,
        accounts: savedState.accounts || [],
        offset: savedState.offset,
        hasMore: savedState.hasMore,
      };
    }
  } catch (err) {
    localStorage.removeItem(SERVER_ACCOUNT_STATE_KEY);
  }

  return state;
}

export function getRequiredServerState() {
  const currentState = restoreState();
  if (!currentState?.token) {
    throw new Error('旧服务登录态已失效，请重新登录');
  }

  return currentState;
}

function isServerAuthExpiredMessage(message?: string) {
  if (!message) return false;

  return /token|登录|登陆|鉴权|认证|授权|过期|失效|无效|未登录|401|403/i.test(message);
}

export function getServerBaseApi() {
  return trimTrailingSlash(process.env.SERVER_BASE_API || process.env.BASE_API || '');
}

function getBaseWs() {
  return process.env.SERVER_BASE_WS || process.env.BASE_WS || '';
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function shouldSignValue(value: unknown) {
  return value !== '' && value !== undefined && !(typeof value === 'object' && !value);
}

export function normalizeServerUrl(base: string, path: string) {
  if (!base) return path;
  return `${trimTrailingSlash(base)}${path.startsWith('/') ? path : `/${path}`}`;
}

function md5(input: string) {
  function safeAdd(x: number, y: number) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num: number, cnt: number) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function md5cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function md5ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function md5gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function md5hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function md5ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function md5blk(s: string) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i)
        + (s.charCodeAt(i + 1) << 8)
        + (s.charCodeAt(i + 2) << 16)
        + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }
  function md5cycle(x: number[], k: number[]) {
    let [a, b, c, d] = x;
    a = md5ff(a, b, c, d, k[0], 7, -680876936);
    b = md5ff(d, a, b, c, k[1], 12, -389564586);
    c = md5ff(c, d, a, b, k[2], 17, 606105819);
    d = md5ff(b, c, d, a, k[3], 22, -1044525330);
    a = md5ff(a, b, c, d, k[4], 7, -176418897);
    b = md5ff(d, a, b, c, k[5], 12, 1200080426);
    c = md5ff(c, d, a, b, k[6], 17, -1473231341);
    d = md5ff(b, c, d, a, k[7], 22, -45705983);
    a = md5ff(a, b, c, d, k[8], 7, 1770035416);
    b = md5ff(d, a, b, c, k[9], 12, -1958414417);
    c = md5ff(c, d, a, b, k[10], 17, -42063);
    d = md5ff(b, c, d, a, k[11], 22, -1990404162);
    a = md5ff(a, b, c, d, k[12], 7, 1804603682);
    b = md5ff(d, a, b, c, k[13], 12, -40341101);
    c = md5ff(c, d, a, b, k[14], 17, -1502002290);
    d = md5ff(b, c, d, a, k[15], 22, 1236535329);
    a = md5gg(a, b, c, d, k[1], 5, -165796510);
    b = md5gg(d, a, b, c, k[6], 9, -1069501632);
    c = md5gg(c, d, a, b, k[11], 14, 643717713);
    d = md5gg(b, c, d, a, k[0], 20, -373897302);
    a = md5gg(a, b, c, d, k[5], 5, -701558691);
    b = md5gg(d, a, b, c, k[10], 9, 38016083);
    c = md5gg(c, d, a, b, k[15], 14, -660478335);
    d = md5gg(b, c, d, a, k[4], 20, -405537848);
    a = md5gg(a, b, c, d, k[9], 5, 568446438);
    b = md5gg(d, a, b, c, k[14], 9, -1019803690);
    c = md5gg(c, d, a, b, k[3], 14, -187363961);
    d = md5gg(b, c, d, a, k[8], 20, 1163531501);
    a = md5gg(a, b, c, d, k[13], 5, -1444681467);
    b = md5gg(d, a, b, c, k[2], 9, -51403784);
    c = md5gg(c, d, a, b, k[7], 14, 1735328473);
    d = md5gg(b, c, d, a, k[12], 20, -1926607734);
    a = md5hh(a, b, c, d, k[5], 4, -378558);
    b = md5hh(d, a, b, c, k[8], 11, -2022574463);
    c = md5hh(c, d, a, b, k[11], 16, 1839030562);
    d = md5hh(b, c, d, a, k[14], 23, -35309556);
    a = md5hh(a, b, c, d, k[1], 4, -1530992060);
    b = md5hh(d, a, b, c, k[4], 11, 1272893353);
    c = md5hh(c, d, a, b, k[7], 16, -155497632);
    d = md5hh(b, c, d, a, k[10], 23, -1094730640);
    a = md5hh(a, b, c, d, k[13], 4, 681279174);
    b = md5hh(d, a, b, c, k[0], 11, -358537222);
    c = md5hh(c, d, a, b, k[3], 16, -722521979);
    d = md5hh(b, c, d, a, k[6], 23, 76029189);
    a = md5hh(a, b, c, d, k[9], 4, -640364487);
    b = md5hh(d, a, b, c, k[12], 11, -421815835);
    c = md5hh(c, d, a, b, k[15], 16, 530742520);
    d = md5hh(b, c, d, a, k[2], 23, -995338651);
    a = md5ii(a, b, c, d, k[0], 6, -198630844);
    b = md5ii(d, a, b, c, k[7], 10, 1126891415);
    c = md5ii(c, d, a, b, k[14], 15, -1416354905);
    d = md5ii(b, c, d, a, k[5], 21, -57434055);
    a = md5ii(a, b, c, d, k[12], 6, 1700485571);
    b = md5ii(d, a, b, c, k[3], 10, -1894986606);
    c = md5ii(c, d, a, b, k[10], 15, -1051523);
    d = md5ii(b, c, d, a, k[1], 21, -2054922799);
    a = md5ii(a, b, c, d, k[8], 6, 1873313359);
    b = md5ii(d, a, b, c, k[15], 10, -30611744);
    c = md5ii(c, d, a, b, k[6], 15, -1560198380);
    d = md5ii(b, c, d, a, k[13], 21, 1309151649);
    a = md5ii(a, b, c, d, k[4], 6, -145523070);
    b = md5ii(d, a, b, c, k[11], 10, -1120210379);
    c = md5ii(c, d, a, b, k[2], 15, 718787259);
    d = md5ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = safeAdd(a, x[0]);
    x[1] = safeAdd(b, x[1]);
    x[2] = safeAdd(c, x[2]);
    x[3] = safeAdd(d, x[3]);
  }
  function md51(s: string) {
    const n = s.length;
    const md5State = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) md5cycle(md5State, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    const tail = new Array(16).fill(0);
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(md5State, tail);
      tail.fill(0);
    }
    tail[14] = n * 8;
    md5cycle(md5State, tail);
    return md5State;
  }
  function hex(x: number[]) {
    const hexChr = '0123456789abcdef';
    let output = '';
    for (let i = 0; i < x.length; i++) {
      for (let j = 0; j < 4; j++) {
        output += hexChr[(x[i] >> (j * 8 + 4)) & 0x0f] + hexChr[(x[i] >> (j * 8)) & 0x0f];
      }
    }
    return output;
  }
  // 旧项目签名算法按 UTF-8 字符串计算 MD5，避免中文参数签名不一致。
  return hex(md51(unescape(encodeURIComponent(input))));
}

export function getServerSignedHeaders(payload: object = {}) {
  const timestamp = Date.now().toString();
  const nonce = Math.random().toString(36).slice(-8);
  const paramsToSign = Object.fromEntries(
    Object.entries(payload).filter(([, v]) => shouldSignValue(v)),
  );
  const sortedStr = Object.keys(paramsToSign)
    .sort()
    .reverse()
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join('&');
  const signSource = sortedStr + nonce + timestamp;

  return {
    'Content-Type': 'application/json',
    'x-sign': md5(signSource),
    'x-uuid': md5(signSource),
    'x-timestamp': timestamp,
    'x-nonce': nonce,
  };
}

async function requestJson<T>(url: string, data: object, headers?: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...getServerSignedHeaders(data),
        ...headers,
      },
      body: JSON.stringify(data),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`请求失败：${response.status}`);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function requestGetJson<T>(
  url: string,
  data: Record<string, any> = {},
  headers?: Record<string, string>,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const requestUrl = new URL(url, window.location.href);

  Object.entries(data).forEach(([key, value]) => {
    if (value === undefined) return;

    const stringValue = String(value ?? '');
    if (!stringValue) return;

    requestUrl.searchParams.set(key, stringValue);
  });

  try {
    const response = await fetch(requestUrl.toString(), {
      method: 'GET',
      headers: {
        ...getServerSignedHeaders(data),
        ...headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorMessage = response.status === 401 || response.status === 403
        ? '旧服务登录态已失效，请重新登录'
        : `请求失败，状态码 ${response.status}`;
      throw new Error(errorMessage);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function getServerUserId(user?: ServerUserInfo) {
  const userId = user?.ID ?? user?.id;
  return userId === undefined ? '' : String(userId);
}

function normalizeServerLingo(language: unknown) {
  if (typeof language !== 'string' && typeof language !== 'number') return undefined;

  const value = String(language).trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'zh' || value.startsWith('zh-hans') || value === 'zh-cn') return 'cn';
  if (value.startsWith('zh-hant') || value === 'zh-tw' || value === 'zh-hk') return 'tw';

  return value.split('-')[0] || value;
}

function applyServerLingo(language: unknown) {
  const normalizedLanguage = normalizeServerLingo(language);
  if (!normalizedLanguage) return;

  try {
    // 与 serverTools.ts 的本地设置键保持一致，避免在账号模块反向导入工具模块造成循环依赖。
    const settingsStorageKey = 'serverToolSettings';
    const currentSettings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}') as Record<string, any>;
    const nextSettings = {
      ...currentSettings,
      pageLanguage: normalizedLanguage,
    };
    localStorage.setItem(settingsStorageKey, JSON.stringify(nextSettings));
    window.dispatchEvent(new CustomEvent('server-tool-settings-updated', { detail: nextSettings }));
  } catch (err) {
    // 语言同步失败不影响业务 WebSocket 建连，工具页下次打开仍会使用默认语言。
  }
}

function handleServerAuthExpiredBeforeWs(message = '旧服务登录态已失效，请重新登录') {
  rejectPendingServerWsRequests(new Error(message));
  signOutServerAccount();
  dispatchServerWsDisconnected({
    message,
    canReconnect: false,
  });
}

async function checkServerLingoBeforeWs() {
  const baseApi = getServerBaseApi();
  if (!baseApi) {
    throw new Error('未配置 SERVER_BASE_API');
  }

  const currentState = getRequiredServerState();
  let response: ServerLingoResponse;
  try {
    response = await requestGetJson<ServerLingoResponse>(
      normalizeServerUrl(baseApi, '/user/getLingo'),
      {},
      {
        'x-token': currentState.token,
        'x-user-id': getServerUserId(currentState.user),
      },
    );
  } catch (err: any) {
    const message = err?.message || '旧服务登录态已失效，请重新登录';
    if (isServerAuthExpiredMessage(message)) {
      handleServerAuthExpiredBeforeWs('旧服务登录态已失效，请重新登录');
    }
    throw err;
  }

  const responseMessage = response.msg || '旧服务登录态已失效，请重新登录';
  if (response.data?.reload || (response.code !== undefined && response.code !== 0)) {
    if (response.data?.reload || isServerAuthExpiredMessage(responseMessage)) {
      handleServerAuthExpiredBeforeWs('旧服务登录态已失效，请重新登录');
      throw new Error('旧服务登录态已失效，请重新登录');
    }

    throw new Error(responseMessage);
  }

  applyServerLingo(response.data?.L ?? response.data?.language ?? response.data?.locale);
}

export async function loginServerAccount(username: string, password: string, token: string) {
  const baseApi = getServerBaseApi();
  if (!baseApi) {
    throw new Error('未配置 SERVER_BASE_API');
  }

  const data = { username, password, captchaId: '', captcha: '', token };
  const response = await requestJson<LoginResponse>(normalizeServerUrl(baseApi, '/base/login'), data);

  if (response.code !== 0 || !response.data?.token) {
    throw new Error(response.msg || '登录失败');
  }

  isServerWsReconnectBlocked = false;
  serverWsReconnectBlockedMessage = '';
  state = {
    token: response.data.token,
    user: response.data.user,
    accounts: [],
  };
  persistState();

  return state;
}

function buildWsUrl() {
  const currentState = getRequiredServerState();

  const configuredWs = getBaseWs();
  if (configuredWs) {
    if (configuredWs.includes('{token}')) {
      return configuredWs.replace('{token}', encodeURIComponent(currentState.token));
    }
    if (configuredWs.includes('token=')) {
      return `${configuredWs}${encodeURIComponent(currentState.token)}`;
    }
    // 旧项目 VITE_BASE_WS 是 token 前缀，这里保持相同拼接语义。
    return configuredWs;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 未显式配置 WS 时，按旧项目逻辑使用当前页面域名自动拼接，线上 HTTPS 会自动使用 wss。
  return `${protocol}//${window.location.host}/im/ws2?token=${encodeURIComponent(currentState.token)}`;
}

async function normalizeWsData(data: MessageEvent['data']) {
  if (typeof data === 'string') return data;

  if (data instanceof Blob) {
    const bytes = new Uint8Array(await data.arrayBuffer());
    // 兼容旧服务可能返回的 gzip 二进制包。
    return new TextDecoder().decode(gunzipSync(bytes));
  }

  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    return new TextDecoder().decode(gunzipSync(bytes));
  }

  return undefined;
}

function parseMessage(data: string): AccountListResponse | undefined {
  try {
    return JSON.parse(data);
  } catch (err) {
    return undefined;
  }
}

function blockServerWsReconnect(message: string) {
  isServerWsReconnectBlocked = true;
  serverWsReconnectBlockedMessage = message;

  const currentSocket = socket;
  if (currentSocket && currentSocket.readyState !== WebSocket.CLOSED) {
    silentClosingSockets.add(currentSocket);
    currentSocket.close();
  }
  socket = undefined;
  connectingPromise = undefined;
  rejectPendingServerWsRequests(new Error(message));
  dispatchServerWsDisconnected({
    message,
    canReconnect: false,
  });
}

function openServerWsConnection() {
  const wsUrl = buildWsUrl();
  const oldSocket = socket;
  if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
    silentClosingSockets.add(oldSocket);
    oldSocket.close();
  }

  const nextSocket = new WebSocket(wsUrl);
  socket = nextSocket;

  connectingPromise = new Promise<WebSocket>((resolve, reject) => {
    let isSettled = false;
    const timer = window.setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      connectingPromise = undefined;
      if (socket === nextSocket) {
        socket = undefined;
      }
      silentClosingSockets.add(nextSocket);
      nextSocket.close();
      reject(new Error(`业务 WebSocket 连接超时：${wsUrl}`));
    }, WS_CONNECT_TIMEOUT);

    nextSocket.onopen = () => {
      isSettled = true;
      connectingPromise = undefined;
      window.clearTimeout(timer);
      // 连接成功后立即提交前端版本信息，旧服务会按这个初始化业务状态。
      nextSocket.send(JSON.stringify({
        code: SERVER_SYSTEM_CODES.InitSystem,
        data: JSON.stringify({ info: { version: APP_VERSION } }),
      }));
      dispatchServerWsConnected();
      resolve(nextSocket);
    };

    nextSocket.onmessage = async (event) => {
      const data = await normalizeWsData(event.data);
      if (!data) return;
      const message = parseMessage(data);
      if (!message) return;
      if (message.uuid && pendingRequests.has(message.uuid)) {
        pendingRequests.get(message.uuid)?.(message);
        pendingRequests.delete(message.uuid);
        return;
      }

      // 没有 uuid 的消息属于服务端主动推送，交给外层 Shell 统一处理。
      if (message.code === SERVER_SYSTEM_CODES.PushSystemOffline) {
        const messageData = message.data as any;
        const offlineMessage = typeof messageData === 'string'
          ? messageData
          : messageData?.content || messageData?.msg || messageData?.message || message.msg || '当前后台账号已在其他地方登录，请重新登录';
        dispatchServerSystemMessage(message);
        blockServerWsReconnect(offlineMessage);
        return;
      }

      dispatchServerSystemMessage(message);
    };

    nextSocket.onerror = () => {
      if (isSettled) return;
      isSettled = true;
      connectingPromise = undefined;
      window.clearTimeout(timer);
      reject(new Error(`业务 WebSocket 连接失败：${wsUrl}`));
    };

    nextSocket.onclose = (event) => {
      const isSilentClose = silentClosingSockets.has(nextSocket);
      const isCurrentSocket = socket === nextSocket;
      const message = `业务 WebSocket 已断开：${event.code || '未知'} ${event.reason || ''}`.trim();
      window.clearTimeout(timer);

      if (!isCurrentSocket) {
        return;
      }

      if (isCurrentSocket) {
        socket = undefined;
        connectingPromise = undefined;
      }
      rejectPendingServerWsRequests(new Error(message));

      if (!isSettled) {
        isSettled = true;
        reject(new Error(message));
        return;
      }

      if (isSilentClose) return;

      dispatchServerWsDisconnected({
        code: event.code || undefined,
        reason: event.reason || undefined,
        message,
      });
    };
  });

  return connectingPromise;
}

function connectServerWs() {
  if (isServerAccountFrame()) {
    return Promise.reject(new Error('原生页面不直接连接业务 WebSocket，请通过外层页面转发请求'));
  }

  if (isServerWsReconnectBlocked) {
    return Promise.reject(new Error(serverWsReconnectBlockedMessage || '业务 WebSocket 已停止重连'));
  }

  if (socket?.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }
  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = checkServerLingoBeforeWs()
    .then(() => openServerWsConnection())
    .catch((err) => {
      connectingPromise = undefined;
      throw err;
    });

  return connectingPromise;
}

export function sendServerWsMessage<T = AccountListResponse>(message: Record<string, any>): Promise<T> {
  return new Promise((resolve, reject) => {
    const uuid = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      pendingRequests.delete(uuid);
      reject(new Error('业务 WebSocket 请求超时'));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(uuid, (value) => {
      window.clearTimeout(timer);
      resolve(value as T);
    });

    socket!.send(JSON.stringify({
      ...message,
      uuid,
    }));
  });
}

export async function sendServerWsMessageNowait(message: Record<string, any>) {
  await connectServerWs();
  socket!.send(JSON.stringify(message));
}

export async function cleanServerSelectedState() {
  // 旧项目在清理本地选中状态时同步通知后端，防止旧服务继续按旧选择范围推送。
  await sendServerWsMessageNowait({
    code: SERVER_SYSTEM_CODES.SystemCleanSelected,
  });
}

export async function saveServerBrowserLog(data: Record<string, any>) {
  await sendServerWsMessageNowait({
    code: SERVER_SYSTEM_CODES.SaveBrowserLog,
    data: JSON.stringify(data),
  });
}

export function setupServerBrowserLogReporter() {
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isServerAccountFrame() || !restoreState()?.token) return;

    const reason = formatBrowserLogReason(event.reason);
    void saveServerBrowserLog({
      version: APP_VERSION,
      source: 'unhandledrejection',
      ...reason,
    }).catch(() => undefined);
  };

  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  return () => {
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  };
}

function requestServerWsViaShell<T = AccountListResponse>(message: Record<string, any>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.parent || window.parent === window) {
      reject(new Error('未找到外层页面，无法转发业务 WebSocket 请求'));
      return;
    }

    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', handleMessage);
      reject(new Error('业务 WebSocket 转发请求超时'));
    }, REQUEST_TIMEOUT);

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as ServerAccountWsResponseMessage;
      if (data?.type !== SERVER_ACCOUNT_WS_RESPONSE_TYPE || data.requestId !== requestId) return;

      window.clearTimeout(timer);
      window.removeEventListener('message', handleMessage);
      if (data.error) {
        reject(new Error(data.error));
        return;
      }

      resolve(data.data as T);
    }

    window.addEventListener('message', handleMessage);
    window.parent.postMessage({
      type: SERVER_ACCOUNT_WS_REQUEST_TYPE,
      requestId,
      payload: message,
    } satisfies ServerAccountWsRequestMessage, window.location.origin);
  });
}

export function isServerAccountWsRequestMessage(data: unknown): data is ServerAccountWsRequestMessage {
  return Boolean(
    data
    && typeof data === 'object'
    && (data as { type?: string }).type === SERVER_ACCOUNT_WS_REQUEST_TYPE
    && typeof (data as { requestId?: unknown }).requestId === 'string'
    && typeof (data as { payload?: unknown }).payload === 'object',
  );
}

export async function handleServerAccountWsRequestMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin || !isServerAccountWsRequestMessage(event.data)) return;

  const { requestId, payload } = event.data;
  try {
    const data = await requestServerWs(payload);
    event.source?.postMessage({
      type: SERVER_ACCOUNT_WS_RESPONSE_TYPE,
      requestId,
      data,
    } satisfies ServerAccountWsResponseMessage, { targetOrigin: window.location.origin });
  } catch (err: any) {
    event.source?.postMessage({
      type: SERVER_ACCOUNT_WS_RESPONSE_TYPE,
      requestId,
      error: err?.message || '业务 WebSocket 请求失败',
    } satisfies ServerAccountWsResponseMessage, { targetOrigin: window.location.origin });
  }
}

export async function requestServerWs<T = AccountListResponse>(message: Record<string, any>): Promise<T> {
  if (isServerAccountFrame()) {
    return requestServerWsViaShell<T>(message);
  }

  await connectServerWs();
  return sendServerWsMessage<T>(message);
}

export async function reconnectServerWs() {
  if (isServerAccountFrame()) {
    throw new Error('原生页面不直接重连业务 WebSocket');
  }

  if (isServerWsReconnectBlocked) {
    throw new Error(serverWsReconnectBlockedMessage || '业务 WebSocket 已停止重连');
  }

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    silentClosingSockets.add(socket);
    socket.close();
  }
  socket = undefined;
  connectingPromise = undefined;
  await connectServerWs();
}

export function getServerUserInfo() {
  return restoreState()?.user;
}

export async function changeServerPassword(data: {
  username?: string;
  password: string;
  newPassword: string;
}) {
  const baseApi = getServerBaseApi();
  if (!baseApi) {
    throw new Error('未配置 SERVER_BASE_API');
  }

  const currentState = getRequiredServerState();
  const response = await requestJson<{ code?: number; msg?: string }>(
    normalizeServerUrl(baseApi, '/user/changePassword'),
    data,
    { 'x-token': currentState.token },
  );

  if (response.code !== 0) {
    throw new Error(response.msg || '修改密码失败');
  }

  return response;
}

export async function fetchServerAccounts(content = '', offset?: unknown, searchType: number | string = 3) {
  await connectServerWs();
  const currentState = getRequiredServerState();

  const response = await sendServerWsMessage<AccountListResponse>({
    aid: 0,
    code: ACCOUNT_LIST_CODE,
    data: JSON.stringify({
      type: searchType,
      content,
      offset,
      offline: true,
      pageSize: DEFAULT_PAGE_SIZE,
    }),
  });

  const responseData = response.data;
  if (!Array.isArray(responseData)) {
    if (responseData?.code) {
      const message = responseData.msg || response.msg || '获取账号列表失败';
      if (isServerAuthExpiredMessage(message)) {
        throw new Error('旧服务登录态已失效，请重新登录');
      }
      throw new Error(message);
    }
    if (isServerAuthExpiredMessage(response.msg)) {
      throw new Error('旧服务登录态已失效，请重新登录');
    }
    throw new Error(response.msg || '获取账号列表失败');
  }

  const accounts = responseData;
  state = {
    token: currentState.token,
    user: currentState.user,
    accounts: offset ? [...currentState.accounts, ...accounts] : accounts,
    offset: response.offset,
    hasMore: Boolean(response.offset),
  };
  persistState();

  return {
    accounts: state.accounts,
    offset: state.offset,
    hasMore: state.hasMore,
  };
}

export async function checkServerAccountOnline(accountId: string | number) {
  const aid = Number(accountId);
  if (!Number.isInteger(aid) || aid <= 0) {
    throw new Error('账号服务端 ID 无效，无法检测在线状态');
  }

  const response = await requestServerWs<AccountListResponse>({
    aid,
    code: ACCOUNT_GET_ONLINE_CODE,
  });

  const data = response.data as { code?: number; msg?: string } | undefined;
  const businessCode = typeof data?.code === 'number' ? data.code : 0;
  if (businessCode !== 0) {
    throw new Error(data?.msg || response.msg || '账号不在线，无法载入');
  }

  return response;
}

export async function fetchAllServerAccounts(content = '', searchType: number | string = 3) {
  let result = await fetchServerAccounts(content, undefined, searchType);

  while (result.hasMore) {
    result = await fetchServerAccounts(content, result.offset, searchType);
  }

  return result;
}

function normalizeAuthKey(authKey: string) {
  const value = authKey.trim().replace(/^"|"$/g, '');
  if (!value) return undefined;

  // 服务端通常下发 hex；如果下发 base64，这里转成 GramJS 需要的 hex。
  if (/^[a-f\d]+$/i.test(value)) return value.toLowerCase();

  try {
    const binary = atob(value);
    return Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch (err) {
    return value;
  }
}

function pickDcId(account: ServerAccount) {
  return Number(
    account.dcid ?? account.dcId ?? account.dcID ?? account.DCID ?? parseServerAccountCacheJson(account)?.dc,
  );
}

function pickAuthKey(account: ServerAccount, dcId: number) {
  return account.authKey
    ?? account.auth_key
    ?? account.authkey
    ?? account.auth
    ?? account.keys?.[dcId]
    ?? account.keys?.[String(dcId)]
    ?? parseServerAccountCacheJson(account)?.key;
}

function pickProxyIp(account: ServerAccount) {
  return String(
    account.proxyIp
    ?? account.ProxyIp
    ?? account.proxy_ip
    ?? account.proxy
    ?? account.proxyUrl
    ?? account.proxyURL
    ?? '',
  ).trim();
}

function pickServerAccountCache(account: ServerAccount) {
  return account.cache || account.Cache;
}

function parseServerAccountCacheJson(account: ServerAccount) {
  const cache = pickServerAccountCache(account);
  if (!cache) return undefined;

  try {
    return JSON.parse(cache);
  } catch (err) {
    return undefined;
  }
}

function normalizeServerDeviceMode(mode: unknown, apiId?: number): number | undefined {
  const numericMode = Number(mode);
  if ([1, 2, 3, 4].includes(numericMode)) return numericMode;

  // gotd 侧会根据 AppId 强制纠正设备类型，这里保持同样的兜底。
  if (apiId === 4) return 1;
  if (apiId === 8) return 2;
  if (apiId === 2040) return 3;

  return undefined;
}

function parseServerAccountCache(account: ServerAccount): ApiServerDeviceConfig | undefined {
  const parsed = parseServerAccountCacheJson(account);
  if (!parsed) return undefined;

  try {
    const info = parsed?.info || {};
    const apiId = Number(info.id);
    const mode = normalizeServerDeviceMode(info.mode ?? account.mode, Number.isFinite(apiId) ? apiId : undefined);
    const tzOffset = Number(info.tz_offset);
    const params: ApiServerDeviceConfig['params'] = {};

    if (mode === 1 || mode === 4) {
      if (info.device_token) params.device_token = String(info.device_token);
      if (info.data) params.data = String(info.data);
      if (info.installer) params.installer = String(info.installer);
      if (info.package_id) params.package_id = String(info.package_id);
      if (Number.isFinite(tzOffset)) params.tz_offset = tzOffset;
      params.perf_cat = 2;
    } else if (mode === 2) {
      if (info.device_token) params.device_token = String(info.device_token);
      if (info.bundleId) params.bundleId = String(info.bundleId);
      if (Number.isFinite(tzOffset)) params.tz_offset = tzOffset;
      params.device_token_type = 'apns';
      params.device_token_environment = 'production';
    } else if (mode === 3) {
      if (Number.isFinite(tzOffset)) params.tz_offset = tzOffset;
    }

    return {
      apiId: Number.isFinite(apiId) ? apiId : undefined,
      apiHash: info.hash ? String(info.hash) : undefined,
      deviceModel: info.dm ? String(info.dm) : undefined,
      systemVersion: info.sv ? String(info.sv) : undefined,
      appVersion: info.ver ? String(info.ver) : undefined,
      systemLangCode: info.sl ? String(info.sl) : undefined,
      langPack: info.lp ? String(info.lp) : undefined,
      langCode: info.lc ? String(info.lc) : undefined,
      mode,
      params: Object.keys(params).length ? params : undefined,
    };
  } catch (err) {
    return undefined;
  }
}

export function getAccountTitle(account: ServerAccount) {
  return account.nickName
    || [account.firstName, account.lastName].filter(Boolean).join(' ')
    || account.username
    || account.account
    || account.phone
    || account.remark
    || `账号 ${account.ID ?? account.id ?? ''}`.trim();
}

export function getServerAccountId(account: ServerAccount) {
  const id = account.ID ?? account.id ?? account.account ?? account.phone;
  return id === undefined ? undefined : String(id);
}

export function getServerAccountBackendId(account: ServerAccount) {
  const id = account.ID ?? account.id;
  return id === undefined ? undefined : String(id);
}

function getServerAccountUserId(account: ServerAccount) {
  const id = account.appId ?? account.userId ?? getServerAccountId(account);
  return id === undefined ? undefined : String(id);
}

function getSlotStorageKey(slot: number) {
  return `${SESSION_ACCOUNT_PREFIX}${slot || 1}`;
}

function getSlotValue(slot: number) {
  return slot === 1 ? undefined : slot;
}

function getStoredSlotNumbers() {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(SESSION_ACCOUNT_PREFIX))
    .map((key) => Number(key.slice(SESSION_ACCOUNT_PREFIX.length)))
    .filter((slot) => slot && !Number.isNaN(slot));
}

function getStoredServerAccountSlots() {
  const slots: Record<string, { slot: number; data: SharedSessionData }> = {};

  getStoredSlotNumbers()
    .forEach((slot) => {
      const data = loadSlotSession(slot);
      if (data?.serverAccountId) {
        slots[data.serverAccountId] = { slot, data };
      }
    });

  return slots;
}

function getSharedSessionAuthKey(data: SharedSessionData) {
  const dcId = data.dcId as 1 | 2 | 3 | 4 | 5;
  return data[`dc${dcId}_auth_key`];
}

function isSameServerSharedSession(current: SharedSessionData | undefined, next: SharedSessionData) {
  return current?.serverAccountId === next.serverAccountId
    && current?.dcId === next.dcId
    && getSharedSessionAuthKey(current) === getSharedSessionAuthKey(next)
    && current?.serverProxyIp === next.serverProxyIp
    && JSON.stringify(current?.serverDeviceConfig || {}) === JSON.stringify(next.serverDeviceConfig || {});
}

export function getSelectedServerAccountId() {
  return localStorage.getItem(getSelectedAccountStorageKey()) || undefined;
}

export function clearServerAccountState() {
  state = undefined;
  isServerWsReconnectBlocked = false;
  serverWsReconnectBlockedMessage = '';
  socket?.close();
  socket = undefined;
  pendingRequests.clear();
  localStorage.removeItem(SERVER_ACCOUNT_STATE_KEY);
  localStorage.removeItem(SERVER_ACCOUNT_SLOT_MAP_KEY);
  Object.keys(localStorage)
    .filter((key) => key.startsWith(SELECTED_SERVER_ACCOUNT_KEY_PREFIX))
    .forEach((key) => localStorage.removeItem(key));
  // 旧服务退出后不保留服务器下发的 auth key，只做本地清理，不调用 Telegram 官方退出。
  Object.keys(localStorage)
    .filter((key) => key.startsWith(SESSION_ACCOUNT_PREFIX))
    .forEach((key) => localStorage.removeItem(key));
}

export function signOutServerAccount() {
  clearServerAccountState();
  clearStoredSession(ACCOUNT_SLOT);
  window.location.hash = 'login';
}

export function buildSessionFromServerAccount(account: ServerAccount): ApiSessionData {
  const dcId = pickDcId(account);
  const authKey = pickAuthKey(account, dcId);
  const normalizedAuthKey = authKey ? normalizeAuthKey(authKey) : undefined;

  if (!dcId || Number.isNaN(dcId)) {
    throw new Error('账号缺少 dcid');
  }

  if (!normalizedAuthKey) {
    throw new Error('账号缺少 auth key');
  }

  return {
    mainDcId: dcId,
    keys: {
      [dcId]: normalizedAuthKey,
    },
  };
}

function buildSharedSessionFromServerAccount(account: ServerAccount): SharedSessionData {
  const sessionData = buildSessionFromServerAccount(account);
  const title = getAccountTitle(account);
  const serverAccountId = getServerAccountId(account);
  const serverDeviceConfig = parseServerAccountCache(account);
  const sharedSessionData: SharedSessionData = {
    dcId: sessionData.mainDcId,
    isTest: sessionData.isTest,
    userId: getServerAccountUserId(account),
    firstName: title,
    phone: account.phone || account.account,
    // 外部账号头像由账号列表直接展示，不能写入原生槽位，避免原生缓存逻辑跨域 fetch 旧服务图片。
    avatarUri: account.avatarUri,
    serverAccountId,
    serverAccountTitle: title,
    serverProxyIp: pickProxyIp(account) || undefined,
    serverDeviceConfig,
  };

  Object.keys(sessionData.keys).map(Number).forEach((dcId) => {
    sharedSessionData[`dc${dcId as 1 | 2 | 3 | 4 | 5}_auth_key`] = sessionData.keys[dcId];
  });

  return sharedSessionData;
}

export function importServerAccountSession(account: ServerAccount) {
  const sharedSessionData = buildSharedSessionFromServerAccount(account);
  const currentSlotData = loadSlotSession(ACCOUNT_SLOT);

  if (!isSameServerSharedSession(currentSlotData, sharedSessionData)) {
    clearStoredSession(ACCOUNT_SLOT);
    // 先写入账号基础展示数据；连接官方 apiws 后会用真实 Telegram 用户信息覆盖。
    writeSlotSession(ACCOUNT_SLOT, sharedSessionData);
  }
  if (sharedSessionData.serverAccountId) {
    localStorage.setItem(getSelectedAccountStorageKey(), sharedSessionData.serverAccountId);
  }

  return {
    mainDcId: sharedSessionData.dcId,
    keys: {
      [sharedSessionData.dcId]: sharedSessionData[`dc${sharedSessionData.dcId as 1 | 2 | 3 | 4 | 5}_auth_key`]!,
    },
    isTest: sharedSessionData.isTest,
    serverDeviceConfig: sharedSessionData.serverDeviceConfig,
  };
}

export function importServerAccountsIntoNativeSlots(accounts: ServerAccount[]) {
  // 服务端模式下账号列表由旧服务托管，这里同步为原生多账号槽位；已有相同账号不重复置入。
  const storedSlots = getStoredServerAccountSlots();
  const storedServerSlotNumbers = new Set(Object.values(storedSlots).map(({ slot }) => slot));
  const occupiedNativeSlots = new Set(getStoredSlotNumbers().filter((slot) => !storedServerSlotNumbers.has(slot)));
  const usedSlots = new Set<number>();
  const slotMap: Record<string, number> = {};

  function pickFreeSlot() {
    let slot = 1;
    while (usedSlots.has(slot) || occupiedNativeSlots.has(slot)) {
      slot += 1;
    }
    return slot;
  }

  accounts.forEach((account) => {
    const sharedSessionData = buildSharedSessionFromServerAccount(account);
    const storedSlot = sharedSessionData.serverAccountId ? storedSlots[sharedSessionData.serverAccountId] : undefined;
    const slot = storedSlot && !usedSlots.has(storedSlot.slot) ? storedSlot.slot : pickFreeSlot();
    const slotValue = getSlotValue(slot);

    if (!isSameServerSharedSession(storedSlot?.data, sharedSessionData)) {
      writeSlotSession(slotValue, sharedSessionData);
    }
    if (sharedSessionData.serverAccountId) {
      localStorage.setItem(getSelectedAccountStorageKeyBySlot(slotValue), sharedSessionData.serverAccountId);
      slotMap[sharedSessionData.serverAccountId] = slot;
    }
    usedSlots.add(slot);
  });

  Object.values(storedSlots).forEach(({ slot }) => {
    if (usedSlots.has(slot)) return;
    localStorage.removeItem(getSlotStorageKey(slot));
    localStorage.removeItem(getSelectedAccountStorageKeyBySlot(getSlotValue(slot)));
  });

  saveServerAccountSlotMap(slotMap);

  if (!accounts.length) {
    throw new Error('没有可用账号');
  }

  return getAccountSlotUrl(1);
}

export function importServerAccountIntoNativeSlot(account: ServerAccount) {
  const sharedSessionData = buildSharedSessionFromServerAccount(account);
  const serverAccountId = sharedSessionData.serverAccountId;
  if (!serverAccountId) {
    throw new Error('账号信息缺少服务端 ID，无法置入');
  }

  const storedSlots = getStoredServerAccountSlots();
  const storedSlot = storedSlots[serverAccountId];
  let slot = storedSlot?.slot;

  if (!slot) {
    // 新服务账号必须避开所有已存在槽位，避免覆盖 slot 1 后 iframe 仍展示旧账号状态。
    const occupiedSlots = new Set(getStoredSlotNumbers());

    slot = 1;
    while (occupiedSlots.has(slot)) {
      slot += 1;
    }
  }

  const slotValue = getSlotValue(slot);
  if (!isSameServerSharedSession(storedSlot?.data, sharedSessionData)) {
    writeSlotSession(slotValue, sharedSessionData);
  }

  localStorage.setItem(getSelectedAccountStorageKeyBySlot(slotValue), serverAccountId);
  saveServerAccountSlotMap({
    ...loadServerAccountSlotMap(),
    [serverAccountId]: slot,
  });

  return slot;
}

export function getServerAccountSlot(account: ServerAccount) {
  const accountId = getServerAccountId(account);
  if (!accountId) return undefined;

  const slot = loadServerAccountSlotMap()[accountId];
  return slot && !Number.isNaN(slot) ? slot : undefined;
}

export function hasImportedServerSession() {
  return hasStoredSession();
}

export function applyServerAccountDefaultLanguage<T extends GlobalState>(global: T): T {
  if (process.env.SERVER_ACCOUNT_LOGIN !== '1') return global;
  if (global.sharedState.settings.language !== FALLBACK_LANG_CODE) return global;

  return {
    ...global,
    sharedState: {
      ...global.sharedState,
      settings: {
        ...global.sharedState.settings,
        // 服务端账号模式默认内置 https://t.me/setlanguage/zh-hans-beta 对应的官方 weba 语言包。
        language: SERVER_ACCOUNT_DEFAULT_LANG_CODE,
      },
    },
  };
}
