import { Mutex } from 'async-mutex';

const mutex = new Mutex();

const closeError = new Error('WebSocket was closed');
const CONNECTION_TIMEOUT = 3000;
const RELAY_CONNECTION_TIMEOUT = 15000;
const MAX_TIMEOUT = 30000;

type ServerRelayConfig = {
  enabled?: boolean;
  accountId?: string;
  deviceMode?: number;
  proxyIp?: string;
  relayUrl?: string;
};

function getServerRelayConfig(): ServerRelayConfig | undefined {
  return (globalThis as any).__serverTelegramRelay;
}

function buildServerRelayUrl(relayUrl?: string) {
  const fallbackProtocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const fallbackUrl = `${fallbackProtocol}//${globalThis.location.host}/tgws`;
  const url = new URL(relayUrl || fallbackUrl, fallbackUrl);

  // 开发环境只配置到主机时，自动补齐 Relay 默认入口。
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/tgws';
  }

  return url;
}

function getWebSocketErrorContext(website?: string, client?: WebSocket, relayConfig?: ServerRelayConfig) {
  return {
    url: website,
    readyState: client?.readyState,
    protocol: client?.protocol,
    relayEnabled: Boolean(relayConfig?.enabled),
    relayUrl: relayConfig?.relayUrl,
    accountId: relayConfig?.accountId,
    deviceMode: relayConfig?.deviceMode,
    hasProxyIp: Boolean(relayConfig?.proxyIp),
  };
}

function shouldLogCloseAsError(event: CloseEvent, closedByClient: boolean) {
  if (closedByClient) return false;
  if (event.code === 1000) return false;
  if (event.code === 1005 && event.wasClean) return false;

  return true;
}

export default class PromisedWebSockets {
  private closed: boolean;

  private timeout: number;

  private stream: Buffer;

  private canRead?: boolean | Promise<boolean>;

  private resolveRead: ((value?: any) => void) | undefined;

  private client: WebSocket | undefined;

  private website?: string;

  private disconnectedCallback: () => void;

  private connectedAt?: number;

  private closedByClient = false;

  constructor(disconnectedCallback: () => void) {
    this.client = undefined;
    this.closed = true;
    this.stream = Buffer.alloc(0);
    this.disconnectedCallback = disconnectedCallback;
    this.timeout = CONNECTION_TIMEOUT;
  }

  async readExactly(number: number) {
    let readData = Buffer.alloc(0);

    while (true) {
      const thisTime = await this.read(number);
      readData = Buffer.concat([readData, thisTime]);
      number -= thisTime.length;
      if (!number) {
        return readData;
      }
    }
  }

  async read(number: number) {
    if (this.closed) {
      throw closeError;
    }
    await this.canRead;
    if (this.closed) {
      throw closeError;
    }
    const toReturn = this.stream.slice(0, number);
    this.stream = this.stream.slice(number);
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }

    return toReturn;
  }

  async readAll() {
    if (this.closed || !await this.canRead) {
      throw closeError;
    }
    const toReturn = this.stream;
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });

    return toReturn;
  }

  getWebSocketLink(ip: string, port: number, isTestServer?: boolean, isPremium?: boolean, dcId?: number) {
    const relayConfig = getServerRelayConfig();
    if (relayConfig?.enabled && relayConfig.accountId && !isTestServer) {
      const url = buildServerRelayUrl(relayConfig.relayUrl);
      url.searchParams.set('aid', relayConfig.accountId);
      url.searchParams.set('target', ip);
      url.searchParams.set('port', String(port));
      if (dcId) url.searchParams.set('dc', String(dcId));
      if (relayConfig.deviceMode) url.searchParams.set('mode', String(relayConfig.deviceMode));
      if (relayConfig.proxyIp) url.searchParams.set('proxyIp', relayConfig.proxyIp);
      if (isPremium) url.searchParams.set('premium', '1');
      return url.toString();
    }

    if (port === 443) {
      return `wss://${ip}:${port}/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
    } else {
      return `ws://${ip}:${port}/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
    }
  }

  connect(port: number, ip: string, isTestServer = false, isPremium = false, dcId?: number) {
    const relayConfig = getServerRelayConfig();
    const connectionTimeout = relayConfig?.enabled
      ? Math.max(this.timeout, RELAY_CONNECTION_TIMEOUT)
      : this.timeout;

    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    this.closed = false;
    this.closedByClient = false;
    this.connectedAt = undefined;
    this.website = this.getWebSocketLink(ip, port, isTestServer, isPremium, dcId);
    this.client = new WebSocket(this.website, 'binary');
    return new Promise((resolve, reject) => {
      if (!this.client) return;
      let hasResolved = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      this.client.onopen = () => {
        this.connectedAt = Date.now();
        this.receive();
        resolve(this);
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };
      this.client.onerror = (error) => {
        // eslint-disable-next-line no-console
        console.error('WebSocket error', getWebSocketErrorContext(this.website, this.client, relayConfig), error);
        reject(new Error(`WebSocket connection failed: ${this.website}`));
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };
      this.client.onclose = (event) => {
        const { code, reason, wasClean } = event;
        const logContext = {
          ...getWebSocketErrorContext(this.website, this.client, relayConfig),
          closedByClient: this.closedByClient,
          durationMs: this.connectedAt ? Date.now() - this.connectedAt : undefined,
        };
        const logMessage = `Socket ${ip} closed. Code: ${code}, reason: ${reason}, was clean: ${wasClean}`;
        if (shouldLogCloseAsError(event, this.closedByClient)) {
          // eslint-disable-next-line no-console
          console.error(logMessage, logContext);
        } else if (relayConfig?.enabled) {
          // eslint-disable-next-line no-console
          console.debug(logMessage, logContext);
        }

        this.resolveRead?.(false);
        this.closed = true;
        if (this.disconnectedCallback) {
          this.disconnectedCallback();
        }
        if (!hasResolved) {
          reject(new Error(`WebSocket was closed before connection completed. Code: ${code}, reason: ${reason}`));
        }
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };

      timeout = setTimeout(() => {
        if (hasResolved) return;

        reject(new Error('WebSocket connection timeout'));
        this.resolveRead?.(false);
        this.closed = true;
        if (this.disconnectedCallback) {
          this.disconnectedCallback();
        }
        this.client?.close(4000, 'WebSocket connection timeout');
        this.timeout *= 2;
        this.timeout = Math.min(this.timeout, MAX_TIMEOUT);
        timeout = undefined;
      }, connectionTimeout);

      // CONTEST
      // Seems to not be working, at least in a web worker

      self.addEventListener('offline', () => {
        this.close();
        this.resolveRead?.(false);
      });
    });
  }

  write(data: Buffer<ArrayBuffer>) {
    if (this.closed) {
      throw closeError;
    }
    this.client?.send(data);
  }

  close() {
    this.closedByClient = true;
    this.client?.close();
    this.closed = true;
  }

  receive() {
    if (!this.client) return;
    this.client.onmessage = async (message) => {
      await mutex.runExclusive(async () => {
        const data = message.data instanceof ArrayBuffer
          ? Buffer.from(message.data)
          : Buffer.from(await new Response(message.data).arrayBuffer());
        this.stream = Buffer.concat([this.stream, data]);
        this.resolveRead?.(true);
      });
    };
  }
}
