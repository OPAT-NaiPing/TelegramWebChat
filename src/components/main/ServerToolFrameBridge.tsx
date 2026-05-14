import {
  memo, useEffect,
} from '../../lib/teact/teact';
import { getActions, getGlobal } from '../../global';

import type { ApiAttachment } from '../../api/types';
import type { ServerMaterial } from '../../util/serverTools';

import { SUPPORTED_AUDIO_CONTENT_TYPES, SUPPORTED_PHOTO_CONTENT_TYPES } from '../../config';
import { selectCurrentMessageList } from '../../global/selectors';
import { generateWaveform } from '../../util/generateWaveform';
import { serverToolT } from '../../util/serverToolLocale';
import { isServerToolMessage } from '../../util/serverTools';
import buildAttachment from '../middle/composer/helpers/buildAttachment';

const IMAGE_EXTENSION_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

const AUDIO_EXTENSION_MIME_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

function getFilenameFromUrl(url: string, fallback: string) {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    const name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    return name || fallback;
  } catch (err) {
    return fallback;
  }
}

function getFileExtension(filename: string) {
  return filename.split('.').pop()?.toLowerCase() || '';
}

function getMimeType(filename: string, blob: Blob, materialType: number) {
  const extension = getFileExtension(filename);
  if (materialType === 2) {
    if (SUPPORTED_PHOTO_CONTENT_TYPES.has(blob.type)) return blob.type;
    return IMAGE_EXTENSION_MIME_MAP[extension] || blob.type || 'image/jpeg';
  }
  if (materialType === 3) {
    if (SUPPORTED_AUDIO_CONTENT_TYPES.has(blob.type)) return blob.type;
    return AUDIO_EXTENSION_MIME_MAP[extension] || blob.type || 'audio/ogg';
  }

  return blob.type || 'application/octet-stream';
}

function normalizeBlobType(blob: Blob, mimeType: string) {
  return blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
}

function getFallbackFilename(material: ServerMaterial) {
  const extension = material.data.type === 2 ? 'jpg' : 'ogg';
  return `${material.name || 'server-material'}.${extension}`;
}

function getAudioDuration(blobUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      audio.removeAttribute('src');
      audio.load();
      resolve(duration);
    };
    audio.onerror = () => resolve(0);
    audio.src = blobUrl;
  });
}

async function downloadMaterialBlob(material: ServerMaterial) {
  const url = material.data.media?.Url;
  if (!url) throw new Error(serverToolT('serverToolNoMaterialMedia'));

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${serverToolT('serverToolDownloadMaterialFailed')}：${response.status}`);

  const filename = material.data.media?.Name || getFilenameFromUrl(url, getFallbackFilename(material));
  const blob = await response.blob();
  return {
    filename,
    blob: normalizeBlobType(blob, getMimeType(filename, blob, material.data.type)),
  };
}

async function buildMaterialAttachment(material: ServerMaterial): Promise<ApiAttachment> {
  const { filename, blob } = await downloadMaterialBlob(material);

  if (material.data.type === 2 && !SUPPORTED_PHOTO_CONTENT_TYPES.has(blob.type)) {
    throw new Error(serverToolT('serverToolUnsupportedImageMaterial'));
  }

  if (material.data.type === 3 && !SUPPORTED_AUDIO_CONTENT_TYPES.has(blob.type)) {
    throw new Error(serverToolT('serverToolUnsupportedVoiceMaterial'));
  }

  const attachment = await buildAttachment(filename, blob);
  if (material.data.type !== 3) return attachment;

  const duration = attachment.audio?.duration || await getAudioDuration(attachment.blobUrl);
  return {
    ...attachment,
    audio: undefined,
    voice: {
      duration,
      waveform: generateWaveform(duration || 1),
    },
  };
}

async function sendMaterial(material: ServerMaterial) {
  const global = getGlobal();
  const messageList = selectCurrentMessageList(global);
  if (!messageList) {
    getActions().showNotification({ message: serverToolT('serverToolNoSelectedChat') });
    return;
  }

  const text = material.data.content || undefined;
  if (material.data.type === 1) {
    getActions().sendMessage({ messageList, text });
    return;
  }

  if (material.data.type !== 2 && material.data.type !== 3) {
    getActions().showNotification({ message: serverToolT('serverToolUnsupportedMaterial') });
    return;
  }

  try {
    const attachment = await buildMaterialAttachment(material);
    getActions().sendMessage({
      messageList,
      text,
      attachments: [attachment],
    });
  } catch (err: any) {
    getActions().showNotification({ message: err?.message || serverToolT('serverToolSendMaterialFileFailed') });
  }
}

const ServerToolFrameBridge = () => {
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || !isServerToolMessage(event.data)) return;

      if (event.data.type === 'server-tool-settings-updated') {
        window.dispatchEvent(new CustomEvent('server-tool-settings-updated', { detail: event.data.settings }));
        return;
      }

      if (event.data.type === 'server-tool-send-material') {
        void sendMaterial(event.data.material);
        return;
      }

      if (event.data.type !== 'server-tool-send-text') return;

      const global = getGlobal();
      const messageList = selectCurrentMessageList(global);
      if (!messageList) {
        getActions().showNotification({ message: serverToolT('serverToolNoSelectedChat') });
        return;
      }

      getActions().sendMessage({
        messageList,
        text: event.data.text,
      });
    }

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return undefined;
};

export default memo(ServerToolFrameBridge);
