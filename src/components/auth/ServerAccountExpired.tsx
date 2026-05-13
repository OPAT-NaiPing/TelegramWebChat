import { memo } from '../../lib/teact/teact';

const ServerAccountExpired = () => {
  return (
    <div id="auth-server-account-expired" className="custom-scroll">
      <div className="auth-form server-account-expired">
        <div id="logo" />
        <h1>账号已失效</h1>
        <p className="note">
          当前账号的 dcid 或 auth key 已无法继续连接 Telegram 官方接口，请在左侧账号列表切换其他账号，或联系管理员重新登录该账号。
        </p>
      </div>
    </div>
  );
};

export default memo(ServerAccountExpired);
