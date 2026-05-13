import type { ChangeEvent, FormEvent } from 'react';
import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { ServerAccount } from '../../util/serverAccounts';

import buildClassName from '../../util/buildClassName';
import {
  fetchServerAccounts,
  getAccountTitle,
  hasImportedServerSession,
  importServerAccountSession,
  loginServerAccount,
} from '../../util/serverAccounts';

import Button from '../ui/Button';
import InputText from '../ui/InputText';

type Step = 'login' | 'accounts';

const TURNSTILE_SCRIPT_ID = 'server-account-turnstile-script';
const TURNSTILE_CALLBACK_NAME = 'onServerAccountTurnstileSuccess';
const TURNSTILE_EXPIRED_CALLBACK_NAME = 'onServerAccountTurnstileExpired';
const TURNSTILE_ERROR_CALLBACK_NAME = 'onServerAccountTurnstileError';
const TURNSTILE_SCRIPT_BASE_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_SCRIPT_URL = `${TURNSTILE_SCRIPT_BASE_URL}?render=implicit`;
const TURNSTILE_SITE_KEY = process.env.SERVER_TURNSTILE_SITE_KEY || '0x4AAAAAAA9uFUJZhOJ9F_kt';
const IS_TURNSTILE_REQUIRED = process.env.APP_ENV !== 'development' && process.env.SERVER_SKIP_TURNSTILE !== '1';

declare global {
  interface Window {
    onServerAccountTurnstileSuccess?: (token: string) => void;
    onServerAccountTurnstileExpired?: () => void;
    onServerAccountTurnstileError?: () => void;
    turnstile?: {
      reset: (widgetId?: string) => void;
    };
  }
}

const ServerAccountLogin = () => {
  const { initApi } = getActions();
  const [step, setStep] = useState<Step>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [accounts, setAccounts] = useState<ServerAccount[]>([]);
  const [nextOffset, setNextOffset] = useState<unknown>();
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (hasImportedServerSession()) {
      initApi();
    }
  }, []);

  useEffect(() => {
    if (step !== 'login' || !IS_TURNSTILE_REQUIRED) return;

    window.onServerAccountTurnstileSuccess = (token: string) => {
      setError(undefined);
      setTurnstileToken(token);
    };
    window.onServerAccountTurnstileExpired = () => setTurnstileToken('');
    window.onServerAccountTurnstileError = () => {
      setTurnstileToken('');
      setError('人机验证失败，请刷新验证后重试');
    };

    // 旧项目登录接口要求提交 Turnstile token，这里加载官方脚本并由容器自动渲染。
    loadTurnstileScript().catch(() => {
      setError('人机验证加载失败，请检查网络后刷新页面');
    });
  }, [step]);

  function setInputValue(setter: (value: string) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setError(undefined);
      setter(event.target.value);
    };
  }

  async function loadAccounts(offset?: unknown) {
    const result = await fetchServerAccounts('', offset);
    setAccounts(result.accounts);
    setNextOffset(result.offset);
    setHasMore(Boolean(result.hasMore));
    setStep('accounts');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoading) return;
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    if (IS_TURNSTILE_REQUIRED && !turnstileToken) {
      setError('请先完成人机验证');
      return;
    }

    setIsLoading(true);
    setError(undefined);
    try {
      await loginServerAccount(username, password, IS_TURNSTILE_REQUIRED ? turnstileToken : '');
      await loadAccounts();
    } catch (err: any) {
      setError(err?.message || '登录失败');
      setTurnstileToken('');
      resetTurnstile();
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRefresh() {
    setIsLoading(true);
    setError(undefined);
    try {
      await loadAccounts();
    } catch (err: any) {
      setError(err?.message || '获取账号列表失败');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLoadMore() {
    if (!hasMore || isLoading) return;
    setIsLoading(true);
    setError(undefined);
    try {
      await loadAccounts(nextOffset);
    } catch (err: any) {
      setError(err?.message || '加载更多账号失败');
    } finally {
      setIsLoading(false);
    }
  }

  function handleAccountClick(account: ServerAccount) {
    try {
      importServerAccountSession(account);
      initApi();
    } catch (err: any) {
      setError(err?.message || '导入账号失败');
    }
  }

  function renderAccount(account: ServerAccount) {
    const dcId = account.dcid ?? account.dcId ?? account.dcID ?? account.DCID;
    const key = String(account.ID ?? account.id ?? `${dcId}-${getAccountTitle(account)}`);
    const title = getAccountTitle(account);
    const phone = account.phone || account.account || account.username;
    const subtitle = `${phone ? `${phone} · ` : ''}DC ${dcId || '-'}`;

    return (
      <button
        type="button"
        className="server-account-item"
        key={key}
        onClick={() => handleAccountClick(account)}
      >
        <span className="server-account-avatar">
          {(title || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="server-account-info">
          <span className="server-account-title">{title}</span>
          <span className="server-account-meta">{subtitle}</span>
        </span>
      </button>
    );
  }

  return (
    <div id="auth-server-account-form" className="custom-scroll">
      <div className={buildClassName('auth-form', 'server-account-form')}>
        <div id="logo" />
        <h1>选择服务器账号</h1>
        <p className="note">账号由服务器下发，选择后会使用 dcid 和 auth key 连接 Telegram 官方 apiws。</p>

        {step === 'login' ? (
          <form className="form" action="" onSubmit={handleSubmit}>
            <InputText
              id="server-login-username"
              label="用户名"
              value={username}
              disabled={isLoading}
              onChange={setInputValue(setUsername)}
            />
            <InputText
              id="server-login-password"
              className="server-password-input"
              label="密码"
              value={password}
              disabled={isLoading}
              onChange={setInputValue(setPassword)}
            />
            {IS_TURNSTILE_REQUIRED && (
              <div
                className="server-turnstile cf-turnstile"
                data-sitekey={TURNSTILE_SITE_KEY}
                data-callback={TURNSTILE_CALLBACK_NAME}
                data-expired-callback={TURNSTILE_EXPIRED_CALLBACK_NAME}
                data-error-callback={TURNSTILE_ERROR_CALLBACK_NAME}
              />
            )}
            {error && <p className="server-account-error">{error}</p>}
            <Button className="auth-button" type="submit" ripple isLoading={isLoading}>
              登录并获取账号
            </Button>
          </form>
        ) : (
          <div className="server-account-list">
            <div className="server-account-toolbar">
              <span>{accounts.length ? `共 ${accounts.length} 个账号` : '暂无账号'}</span>
              <Button isText ripple size="smaller" isLoading={isLoading} onClick={handleRefresh}>
                刷新
              </Button>
            </div>
            {error && <p className="server-account-error">{error}</p>}
            <div className="server-account-scroll">
              {accounts.map(renderAccount)}
            </div>
            {hasMore && (
              <Button isText ripple isLoading={isLoading} onClick={handleLoadMore}>
                加载更多
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const existingScript = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | undefined;
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject();
    document.head.appendChild(script);
  });
}

function resetTurnstile() {
  if (window.turnstile) {
    window.turnstile.reset();
  }
}

export default memo(ServerAccountLogin);
