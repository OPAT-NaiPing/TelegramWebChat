import { gunzipSync } from 'fflate';

import type { ApiSessionData } from '../api/types';
import type { SharedSessionData } from '../types';

import { ACCOUNT_SLOT, writeSlotSession } from './multiaccount';
import {
  clearStoredSession,
  hasStoredSession,
  loadSlotSession,
  storeSession,
} from './sessions';

const ACCOUNT_LIST_CODE = 0x1001;
const INIT_SYSTEM_CODE = 0x0007;
const DEFAULT_PAGE_SIZE = 50;
const REQUEST_TIMEOUT = 30000;
const WS_CONNECT_TIMEOUT = 15000;

type LoginResponse = {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    user?: ServerUserInfo;
  };
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

type ServerAccountState = {
  token: string;
  user?: ServerUserInfo;
  accounts: ServerAccount[];
  offset?: unknown;
  hasMore?: boolean;
};

let state: ServerAccountState | undefined;
let socket: WebSocket | undefined;
const pendingRequests = new Map<string, (value: AccountListResponse) => void>();

function getBaseApi() {
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

function normalizeUrl(base: string, path: string) {
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

function getSignedHeaders(payload: object = {}) {
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
        ...getSignedHeaders(data),
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

export async function loginServerAccount(username: string, password: string, token: string) {
  const baseApi = getBaseApi();
  if (!baseApi) {
    throw new Error('未配置 SERVER_BASE_API');
  }

  const data = { username, password, captchaId: '', captcha: '', token };
  const response = await requestJson<LoginResponse>(normalizeUrl(baseApi, '/base/login'), data);

  if (response.code !== 0 || !response.data?.token) {
    throw new Error(response.msg || '登录失败');
  }

  state = {
    token: response.data.token,
    user: response.data.user,
    accounts: [],
  };

  return state;
}

function buildWsUrl() {
  if (!state?.token) {
    throw new Error('未登录旧服务');
  }

  const configuredWs = getBaseWs();
  if (configuredWs) {
    if (configuredWs.includes('{token}')) {
      return configuredWs.replace('{token}', encodeURIComponent(state.token));
    }
    if (configuredWs.includes('token=')) {
      return `${configuredWs}${encodeURIComponent(state.token)}`;
    }
    // 旧项目 VITE_BASE_WS 是 token 前缀，这里保持相同拼接语义。
    return configuredWs;
  }

  const baseApi = getBaseApi();
  if (!baseApi) {
    throw new Error('未配置 SERVER_BASE_WS');
  }

  const apiUrl = new URL(baseApi, window.location.href);
  const protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${apiUrl.host}/im/ws2?token=${encodeURIComponent(state.token)}`;
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

function connectServerWs() {
  if (socket?.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }

  socket?.close();
  const wsUrl = buildWsUrl();
  socket = new WebSocket(wsUrl);

  return new Promise<WebSocket>((resolve, reject) => {
    let isSettled = false;
    const timer = window.setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      reject(new Error(`业务 WebSocket 连接超时：${wsUrl}`));
    }, WS_CONNECT_TIMEOUT);

    socket!.onopen = () => {
      isSettled = true;
      window.clearTimeout(timer);
      // 旧项目连接成功后会上报版本初始化包，保持服务端原有握手语义。
      socket!.send(JSON.stringify({
        code: INIT_SYSTEM_CODE,
        data: JSON.stringify({ info: { version: APP_VERSION } }),
      }));
      resolve(socket!);
    };

    socket!.onmessage = async (event) => {
      const data = await normalizeWsData(event.data);
      if (!data) return;
      const message = parseMessage(data);
      if (!message?.uuid) return;
      pendingRequests.get(message.uuid)?.(message);
      pendingRequests.delete(message.uuid);
    };

    socket!.onerror = () => {
      if (isSettled) return;
      isSettled = true;
      window.clearTimeout(timer);
      reject(new Error(`业务 WebSocket 连接失败：${wsUrl}`));
    };

    socket!.onclose = (event) => {
      if (isSettled) return;
      isSettled = true;
      window.clearTimeout(timer);
      reject(new Error(`业务 WebSocket 已关闭：${event.code || '无状态码'} ${event.reason || ''}`.trim()));
    };
  });
}

function sendServerWsMessage<T = AccountListResponse>(message: Record<string, any>): Promise<T> {
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

export async function fetchServerAccounts(content = '', offset?: unknown) {
  await connectServerWs();

  const response = await sendServerWsMessage<AccountListResponse>({
    aid: 0,
    code: ACCOUNT_LIST_CODE,
    data: JSON.stringify({
      type: 3,
      content,
      offset,
      pageSize: DEFAULT_PAGE_SIZE,
    }),
  });

  const responseData = response.data;
  if (!Array.isArray(responseData)) {
    if (responseData?.code) {
      throw new Error(responseData.msg || response.msg || '获取账号列表失败');
    }
    throw new Error(response.msg || '获取账号列表失败');
  }

  const accounts = responseData;
  state = {
    token: state!.token,
    user: state!.user,
    accounts: offset ? [...state!.accounts, ...accounts] : accounts,
    offset: response.offset,
    hasMore: Boolean(response.offset),
  };

  return {
    accounts: state.accounts,
    offset: state.offset,
    hasMore: state.hasMore,
  };
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
  return Number(account.dcid ?? account.dcId ?? account.dcID ?? account.DCID);
}

function pickAuthKey(account: ServerAccount, dcId: number) {
  return account.authKey
    ?? account.auth_key
    ?? account.authkey
    ?? account.auth
    ?? account.keys?.[dcId]
    ?? account.keys?.[String(dcId)];
}

export function getAccountTitle(account: ServerAccount) {
  return account.remark
    || account.nickName
    || [account.firstName, account.lastName].filter(Boolean).join(' ')
    || account.username
    || account.account
    || account.phone
    || `账号 ${account.ID ?? account.id ?? ''}`.trim();
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

export function importServerAccountSession(account: ServerAccount) {
  const sessionData = buildSessionFromServerAccount(account);
  clearStoredSession(ACCOUNT_SLOT);
  storeSession(sessionData);

  const title = getAccountTitle(account);
  const slotSession = loadSlotSession(ACCOUNT_SLOT);
  const sharedSessionData: SharedSessionData = {
    ...slotSession!,
    firstName: title,
    phone: account.phone || account.account,
    avatarUri: account.avatarUri || account.headimg,
  };

  // 先写入账号基础展示数据；连接官方 apiws 后会用真实 Telegram 用户信息覆盖。
  writeSlotSession(ACCOUNT_SLOT, sharedSessionData);

  return sessionData;
}

export function hasImportedServerSession() {
  return hasStoredSession();
}
