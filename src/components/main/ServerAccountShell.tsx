import type { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent } from 'react';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';

import type { ServerAccount } from '../../util/serverAccounts';

import buildClassName from '../../util/buildClassName';
import {
  fetchAllServerAccounts,
  fetchServerAccounts,
  getAccountTitle,
  getServerAccountFrameUrl,
  getServerAccountId,
  getServerAccountSlot,
  importServerAccountsIntoNativeSlots,
  signOutServerAccount,
} from '../../util/serverAccounts';

import useFlag from '../../hooks/useFlag';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import DropdownMenu from '../ui/DropdownMenu';
import MenuItem from '../ui/MenuItem';

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
  const [searchType, setSearchType] = useState<number | string>(DEFAULT_SEARCH_TYPE);
  const [searchContent, setSearchContent] = useState('');
  const [accounts, setAccounts] = useState<ServerAccount[]>([]);
  const [frameUrl, setFrameUrl] = useState(() => getServerAccountFrameUrl(1));
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSignOutDialogOpen, openSignOutDialog, closeSignOutDialog] = useFlag(false);
  const selectedAccount = accounts.find((account) => getServerAccountId(account) === selectedAccountId);

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
      setSelectedAccountId(getServerAccountId(result.accounts[0]));
      setFrameUrl(getServerAccountFrameUrl(getServerAccountSlot(result.accounts[0]) || 1));
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

    setSelectedAccountId(getServerAccountId(account));
    setFrameUrl(getServerAccountFrameUrl(slot));
  }

  function handleSignOut() {
    closeSignOutDialog();
    signOutServerAccount();
    window.location.reload();
  }

  function handleResizeStart(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsResizingSidebar(true);
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
      )}
      style={`--server-account-sidebar-width: ${sidebarWidth}px`}
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
            <MenuItem icon="logout" destructive onClick={openSignOutDialog}>退出登录</MenuItem>
          </DropdownMenu>
        </div>
      </nav>

      <iframe
        className="server-account-shell-frame"
        title="Telegram 原生界面"
        src={frameUrl}
      />

      <ConfirmDialog
        isOpen={isSignOutDialogOpen}
        title="退出登录"
        text="确定要退出旧服务登录并返回登录界面吗？"
        confirmLabel="退出登录"
        confirmHandler={handleSignOut}
        confirmIsDestructive
        onClose={closeSignOutDialog}
      />
    </div>
  );
};

export default memo(ServerAccountShell);
