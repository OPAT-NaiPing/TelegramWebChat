import type { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent } from 'react';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { ServerAccount } from '../../util/serverAccounts';
import type { ServerToolPage } from '../../util/serverTools';

import buildClassName from '../../util/buildClassName';
import {
  addServerSystemMessageListener,
  cleanServerSelectedState,
  fetchAllServerAccounts,
  fetchServerAccounts,
  getAccountTitle,
  getServerAccountFrameUrl,
  getServerAccountId,
  getServerAccountSlot,
  handleServerAccountWsRequestMessage,
  importServerAccountsIntoNativeSlots,
  SERVER_SYSTEM_CODES,
  setupServerBrowserLogReporter,
  signOutServerAccount,
} from '../../util/serverAccounts';
import { serverToolT } from '../../util/serverToolLocale';

import useFlag from '../../hooks/useFlag';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import DropdownMenu from '../ui/DropdownMenu';
import MenuItem from '../ui/MenuItem';
import ServerToolPanel from './ServerToolPanel';

import './ServerAccountShell.scss';

const SEARCH_TYPES = [
  { label: '手机号', value: 1 },
  { label: '用户名', value: 2 },
  { label: '昵称', value: 3 },
];

const DEFAULT_SEARCH_TYPE = 3;
const SIDEBAR_WIDTH_STORAGE_KEY = 'serverAccountSidebarWidth';
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const TOOL_PANEL_WIDTH = 22;

function getServerSystemText(data: any, fallback: string) {
  if (!data) return fallback;
  if (typeof data === 'string') return data;

  return data.content || data.msg || data.message || fallback;
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function loadSidebarWidth() {
  try {
    const width = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return width ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
  } catch (err) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function getAccountPhone(account: ServerAccount) {
  return account.phone || account.account || account.username || '';
}

function getAccountDcId(account: ServerAccount) {
  return account.dcid ?? account.dcId ?? account.dcID ?? account.DCID;
}

function getOnlineText(online?: number) {
  if (online === 2) return '在线';
  if (online === 1) return '登录中';
  return '离线';
}

function getStatusText(status?: number) {
  const texts: Record<number, string> = {
    1: '登录成功',
    2: '登录超时',
    3: '登录失败',
    4: '已禁用',
    6: '异常',
  };

  return status ? texts[status] || `状态 ${status}` : '未知状态';
}

const ServerAccountShell = () => {
  const rootRef = useRef<HTMLDivElement>();
  const frameRef = useRef<HTMLIFrameElement>();
  const [searchType, setSearchType] = useState<number | string>(DEFAULT_SEARCH_TYPE);
  const [searchContent, setSearchContent] = useState('');
  const [accounts, setAccounts] = useState<ServerAccount[]>([]);
  const [frameUrl, setFrameUrl] = useState<string | undefined>();
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [activeToolPage, setActiveToolPage] = useState<ServerToolPage | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [systemDialog, setSystemDialog] = useState<{
    title: string;
    text: string;
    action: 'signOut' | 'reload';
  } | undefined>();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSignOutDialogOpen, openSignOutDialog, closeSignOutDialog] = useFlag(false);
  const selectedAccount = accounts.find((account) => getServerAccountId(account) === selectedAccountId);
  const { showNotification } = getActions();

  useEffect(() => {
    if (!isResizingSidebar) return undefined;

    function handleMouseMove(event: MouseEvent) {
      const shellLeft = rootRef.current?.getBoundingClientRect().left || 0;
      setSidebarWidth(clampSidebarWidth(event.clientX - shellLeft));
    }

    function handleMouseUp() {
      setIsResizingSidebar(false);
    }

    document.body.classList.add('server-account-shell-is-resizing');
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.body.classList.remove('server-account-shell-is-resizing');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.addEventListener('message', handleServerAccountWsRequestMessage);
    return () => {
      window.removeEventListener('message', handleServerAccountWsRequestMessage);
    };
  }, []);

  useEffect(() => {
    return setupServerBrowserLogReporter();
  }, []);

  useEffect(() => {
    return addServerSystemMessageListener((message) => {
      const data = message.data as any;

      switch (message.code) {
        case SERVER_SYSTEM_CODES.PushSystemOffline: {
          setSystemDialog({
            title: '下线通知',
            text: getServerSystemText(data, message.msg || '当前后台账号已在其他地方登录，请重新登录'),
            action: 'signOut',
          });
          break;
        }

        case SERVER_SYSTEM_CODES.PushSystemErr: {
          showNotification({
            message: getServerSystemText(data, message.msg || '系统错误'),
            icon: 'warning',
          });
          break;
        }

        case SERVER_SYSTEM_CODES.PushSystemTip: {
          showNotification({
            title: data?.title,
            message: getServerSystemText(data, message.msg || '系统提示'),
          });
          break;
        }

        case SERVER_SYSTEM_CODES.PushSystemUpdate: {
          setSystemDialog({
            title: '更新提示',
            text: getServerSystemText(data, message.msg || '系统已更新，请刷新页面'),
            action: 'reload',
          });
          break;
        }
      }
    });
  }, [showNotification]);

  const syncAccounts = useLastCallback(async () => {
    setIsLoading(true);
    setError(undefined);

    try {
      const result = await fetchAllServerAccounts('');
      if (!result.accounts.length) {
        throw new Error('没有可用账号');
      }

      importServerAccountsIntoNativeSlots(result.accounts);
      setAccounts(result.accounts);
      const selectedAccountAfterSync = result.accounts.find((account) => {
        return getServerAccountId(account) === selectedAccountId;
      });
      if (!selectedAccountAfterSync) {
        setSelectedAccountId(undefined);
        setFrameUrl(undefined);
      }
    } catch (err: any) {
      const message = err?.message || '获取账号列表失败';
      if (message.includes('旧服务登录态已失效')) {
        signOutServerAccount();
        window.location.reload();
        return;
      }

      setError(message);
    } finally {
      setIsLoading(false);
    }
  });

  useEffect(() => {
    void syncAccounts();
  }, [syncAccounts]);

  function updateSearchContent(event: ChangeEvent<HTMLInputElement>) {
    setSearchContent(event.target.value);
    setError(undefined);
  }

  function updateSearchType(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    setSearchType(Number(value) || value);
  }

  async function handleSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setIsLoading(true);
    setError(undefined);

    try {
      const result = searchContent.trim()
        ? await fetchServerAccounts(searchContent.trim(), undefined, searchType)
        : await fetchAllServerAccounts('', searchType);
      setAccounts(result.accounts);
    } catch (err: any) {
      setError(err?.message || '搜索账号失败');
    } finally {
      setIsLoading(false);
    }
  }

  function handleResetSearch() {
    setSearchContent('');
    void syncAccounts();
  }

  function handleAccountClick(account: ServerAccount) {
    const slot = getServerAccountSlot(account);
    if (!slot) return;

    void cleanServerSelectedState().catch(() => undefined);
    setSelectedAccountId(getServerAccountId(account));
    setFrameUrl(getServerAccountFrameUrl(slot));
  }

  function handleSignOut() {
    closeSignOutDialog();
    signOutServerAccount();
    window.location.reload();
  }

  function handleSystemDialogConfirm() {
    const action = systemDialog?.action;
    setSystemDialog(undefined);

    if (action === 'signOut') {
      signOutServerAccount();
      window.location.reload();
      return;
    }

    if (action === 'reload') {
      window.location.reload();
    }
  }

  function handleResizeStart(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsResizingSidebar(true);
  }

  function openToolPage(page: ServerToolPage) {
    setActiveToolPage((current) => (current === page ? undefined : page));
  }

  function renderRailAvatar() {
    const title = selectedAccount ? getAccountTitle(selectedAccount) : '未选择账号';
    const phone = selectedAccount ? getAccountPhone(selectedAccount) : '暂无账号';
    const dcId = selectedAccount ? getAccountDcId(selectedAccount) : '-';
    const onlineText = selectedAccount ? getOnlineText(Number(selectedAccount.online)) : '未知状态';
    const statusText = selectedAccount ? getStatusText(Number(selectedAccount.accountStatus)) : '未知状态';
    const image = selectedAccount?.avatarUri || selectedAccount?.headimg;

    return (
      <button
        type="button"
        className="server-account-shell-rail-account"
        aria-label="呼出账号列表"
        onClick={() => setIsSidebarCollapsed(false)}
      >
        <span className="server-account-shell-rail-avatar">
          {image ? (
            <img className="server-account-shell-image" src={image} alt="" />
          ) : (
            <span>{(title || '?').slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="server-account-shell-rail-card">
          <strong className="server-account-shell-rail-title">{title}</strong>
          <span className="server-account-shell-rail-text">{phone}</span>
          <span className="server-account-shell-rail-text">
            {'DC '}
            {dcId}
            {' · '}
            {onlineText}
          </span>
          <span className="server-account-shell-rail-text">{statusText}</span>
        </span>
      </button>
    );
  }

  function SettingsMenuButton({ onTrigger, isOpen }: { onTrigger: NoneToVoidFunction; isOpen?: boolean }) {
    return (
      <Button
        round
        size="tiny"
        color="translucent"
        className={isOpen ? 'active' : ''}
        iconName="settings"
        ariaLabel="设置"
        onClick={onTrigger}
      />
    );
  }

  function renderAccount(account: ServerAccount) {
    const accountId = getServerAccountId(account);
    const title = getAccountTitle(account);
    const phone = getAccountPhone(account);
    const dcId = getAccountDcId(account);
    const isSelected = Boolean(accountId && accountId === selectedAccountId);

    return (
      <button
        type="button"
        key={accountId || `${dcId}-${title}-${phone}`}
        className={buildClassName('server-account-shell-item', isSelected && 'selected')}
        onClick={() => handleAccountClick(account)}
      >
        <span className="server-account-shell-avatar">
          {account.headimg || account.avatarUri ? (
            <img className="server-account-shell-image" src={account.avatarUri || account.headimg} alt="" />
          ) : (
            <span>{(title || '?').slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="server-account-shell-info">
          <span className="server-account-shell-title">{title}</span>
          <span className="server-account-shell-meta">
            {phone || '未返回账号'}
            {' · DC '}
            {dcId || '-'}
          </span>
          <span className="server-account-shell-status">
            <span className={buildClassName('server-account-shell-dot', Number(account.online) === 2 && 'online')} />
            {getOnlineText(Number(account.online))}
            {' · '}
            {getStatusText(Number(account.accountStatus))}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div
      ref={rootRef}
      id="ServerAccountShell"
      className={buildClassName(
        isSidebarCollapsed && 'is-sidebar-collapsed',
        isResizingSidebar && 'is-resizing-sidebar',
        activeToolPage && 'with-tool-panel',
      )}
      style={`--server-account-sidebar-width: ${sidebarWidth}px; --server-tool-panel-width: ${TOOL_PANEL_WIDTH}rem`}
    >
      <aside className="server-account-shell-sidebar">
        <div className="server-account-shell-header">
          <strong className="server-account-shell-heading">账号列表</strong>
          <div className="server-account-shell-actions">
            <Button
              round
              size="tiny"
              color="translucent"
              iconName="arrow-left"
              ariaLabel="收起账号列表"
              onClick={() => setIsSidebarCollapsed(true)}
            />
            <Button
              round
              size="tiny"
              color="translucent"
              iconName="reload"
              ariaLabel="刷新账号列表"
              disabled={isLoading}
              onClick={syncAccounts}
            />
          </div>
        </div>

        <form className="server-account-shell-search" onSubmit={handleSearch}>
          <select
            className="server-account-shell-select"
            value={searchType}
            onChange={updateSearchType}
            aria-label="搜索条件"
          >
            {SEARCH_TYPES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <div className="server-account-shell-search-input">
            <i className="icon icon-search" />
            <input
              className="server-account-shell-input"
              type="text"
              value={searchContent}
              placeholder="搜索账号"
              onChange={updateSearchContent}
            />
            {searchContent && (
              <button
                type="button"
                className="server-account-shell-clear"
                aria-label="清空搜索"
                onClick={handleResetSearch}
              >
                <i className="icon icon-close" />
              </button>
            )}
          </div>
        </form>

        <div className="server-account-shell-summary">
          {accounts.length ? `共 ${accounts.length} 个账号` : '暂无账号'}
        </div>

        {error && <div className="server-account-shell-error">{error}</div>}

        <div className="server-account-shell-list custom-scroll">
          {accounts.map(renderAccount)}
          {!accounts.length && !isLoading && !error && (
            <div className="server-account-shell-empty">暂无账号</div>
          )}
        </div>
        <button
          type="button"
          className="server-account-shell-resizer"
          aria-label="调整账号列表宽度"
          onMouseDown={handleResizeStart}
        />
      </aside>

      <nav className="server-account-shell-rail" aria-label="账号快捷栏">
        <div className="server-account-shell-rail-top">
          {renderRailAvatar()}
        </div>
        <div className="server-account-shell-rail-bottom">
          <DropdownMenu
            className="server-account-shell-settings-menu"
            trigger={SettingsMenuButton}
            positionX="left"
            positionY="bottom"
          >
            <MenuItem icon="message" onClick={() => openToolPage('speech')}>{serverToolT('sucai')}</MenuItem>
            <MenuItem icon="language" onClick={() => openToolPage('translate')}>{serverToolT('fanyi')}</MenuItem>
            <MenuItem icon="settings" onClick={() => openToolPage('settings')}>{serverToolT('setting')}</MenuItem>
            <MenuItem icon="logout" destructive onClick={openSignOutDialog}>{serverToolT('loginout')}</MenuItem>
          </DropdownMenu>
        </div>
      </nav>

      <main className="server-account-shell-frame-wrap">
        {frameUrl ? (
          <iframe
            ref={frameRef}
            className="server-account-shell-frame"
            title="Telegram 原生界面"
            src={frameUrl}
          />
        ) : (
          <div className="server-account-shell-placeholder">
            <i className="icon icon-user" />
            <strong className="server-account-shell-placeholder-title">请选择账号</strong>
            <span className="server-account-shell-placeholder-text">
              请注意选择账号前,请确保当前账号在控中不是在线状态!
            </span>
          </div>
        )}
      </main>

      <nav className="server-account-shell-tools" aria-label="工具菜单栏">
        <button
          type="button"
          className={buildClassName('server-account-shell-tool-button', activeToolPage === 'speech' && 'active')}
          onClick={() => openToolPage('speech')}
          aria-label="话术"
        >
          <i className="icon icon-message" />
        </button>
        <button
          type="button"
          className={buildClassName('server-account-shell-tool-button', activeToolPage === 'translate' && 'active')}
          onClick={() => openToolPage('translate')}
          aria-label="翻译"
        >
          <i className="icon icon-language" />
        </button>
        <button
          type="button"
          className={buildClassName('server-account-shell-tool-button', activeToolPage === 'settings' && 'active')}
          onClick={() => openToolPage('settings')}
          aria-label="设置"
        >
          <i className="icon icon-settings" />
        </button>
      </nav>

      {activeToolPage && (
        <ServerToolPanel
          activePage={activeToolPage}
          frame={frameRef.current}
          onClose={() => setActiveToolPage(undefined)}
        />
      )}

      <ConfirmDialog
        isOpen={isSignOutDialogOpen}
        title="退出登录"
        text="确定要退出旧服务登录并返回登录界面吗？"
        confirmLabel="退出登录"
        confirmHandler={handleSignOut}
        confirmIsDestructive
        onClose={closeSignOutDialog}
      />

      <ConfirmDialog
        isOpen={Boolean(systemDialog)}
        title={systemDialog?.title}
        text={systemDialog?.text}
        confirmLabel={systemDialog?.action === 'reload' ? '刷新页面' : '重新登录'}
        confirmHandler={handleSystemDialogConfirm}
        isOnlyConfirm
        onClose={handleSystemDialogConfirm}
      />
    </div>
  );
};

export default memo(ServerAccountShell);
