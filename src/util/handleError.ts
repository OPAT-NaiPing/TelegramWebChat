import { DEBUG, DEBUG_ALERT_MSG } from '../config';
import { isCurrentTabMaster } from './establishMultitabRole';
import { throttle } from './schedulers';

let showError = true;
let error: unknown;

window.addEventListener('error', handleErrorEvent);
window.addEventListener('unhandledrejection', handleErrorEvent);

if (DEBUG) {
  window.addEventListener('focus', () => {
    if (!isCurrentTabMaster()) {
      return;
    }
    showError = true;
    if (error) {
      window.alert(getErrorMessage(error));
      error = undefined;
    }
  });
  window.addEventListener('blur', () => {
    if (!isCurrentTabMaster()) {
      return;
    }
    showError = false;
  });
}

const throttleError = throttle((err) => {
  if (showError) {
    window.alert(getErrorMessage(err));
  } else {
    error = err;
  }
}, 1500);

export function handleError(err: unknown) {
  // eslint-disable-next-line no-console
  console.error(err);
  if (DEBUG) {
    throttleError(err);
  }
}

function handleErrorEvent(e: ErrorEvent | PromiseRejectionEvent) {
  if (e instanceof ErrorEvent) {
    // https://stackoverflow.com/questions/49384120/resizeobserver-loop-limit-exceeded
    if (e.message === 'ResizeObserver loop limit exceeded') {
      return;
    }

    // Flood wait errors
    if (e.message.includes('A wait of')) {
      return;
    }
  }

  e.preventDefault();
  handleError(e instanceof ErrorEvent ? (e.error || e.message) : e.reason);
}

function getErrorMessage(err: unknown) {
  if (err instanceof Error) {
    return `${DEBUG_ALERT_MSG}\n\n${err.message || err}\n${err.stack || ''}`;
  }

  return `${DEBUG_ALERT_MSG}\n\n${formatUnknownError(err)}`;
}

function formatUnknownError(err: unknown) {
  if (typeof err === 'string' && err) return err;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);

  return '未知错误';
}
