import type { ChangeEvent, FormEvent } from 'react';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import type {
  ServerMaterial,
  ServerMaterialData,
  ServerMaterialGroup,
  ServerToolPage,
  ServerToolSettings,
  ServerTranslateConfig,
} from '../../util/serverTools';

import buildClassName from '../../util/buildClassName';
import { changeServerPassword, getServerUserInfo, signOutServerAccount } from '../../util/serverAccounts';
import { serverToolT } from '../../util/serverToolLocale';
import {
  clearServerMaterialCache,
  clearServerMaterialGroup,
  createServerMaterial,
  createServerMaterialGroup,
  deleteServerMaterial,
  deleteServerMaterialGroup,
  fetchServerMaterialGroups,
  fetchServerMaterials,
  fetchServerTranslateConfig,
  loadServerToolSettings,
  mergeServerTranslateConfigToSettings,
  postServerToolMessageToFrame,
  saveServerToolSettings,
  saveServerTranslateConfig,
  SERVER_TOOL_LANGUAGES,
  SERVER_TOOL_TRANSLATE_CHANNELS,
  translateServerText,
  updateServerMaterial,
  updateServerMaterialGroup,
  uploadServerToolMaterialFile,
} from '../../util/serverTools';

import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';

import './ServerToolPanel.scss';

type OwnProps = {
  activePage?: ServerToolPage;
  frame?: HTMLIFrameElement;
  onClose: NoneToVoidFunction;
};

type GroupFormState = {
  ID?: number;
  name: string;
};

type MaterialFormState = {
  ID?: number;
  gid?: number;
  name: string;
  materialType: number;
  content: string;
  media: NonNullable<ServerMaterialData['media']>;
};

const DEFAULT_GROUP_FORM = { name: '' };
const DEFAULT_MATERIAL_FORM: Omit<MaterialFormState, 'gid'> = {
  name: '',
  materialType: 1,
  content: '',
  media: {},
};
const SERVER_TOOL_MATERIAL_TYPES = [
  { value: 1, labelKey: 'text', icon: 'message' },
  { value: 2, labelKey: 'photo', icon: 'photo' },
  { value: 3, labelKey: 'voice', icon: 'microphone-alt' },
] as const;

function getMaterialText(material: ServerMaterial) {
  return material.data.content || material.name || '';
}

function getMaterialMediaUrl(material: ServerMaterial) {
  return material.data.media?.Url || '';
}

function canSendMaterial(material: ServerMaterial) {
  if (material.data.type === 2 || material.data.type === 3) {
    return Boolean(getMaterialMediaUrl(material));
  }

  return Boolean(getMaterialText(material));
}

function getMaterialIcon(material: ServerMaterial) {
  if (material.data.type === 2) return 'photo';
  if (material.data.type === 3) return 'microphone-alt';

  return 'message';
}

function getMaterialFormFromMaterial(material: ServerMaterial, groupId: number): MaterialFormState {
  return {
    ID: material.ID,
    gid: material.gid || groupId,
    name: material.name,
    materialType: material.data.type || 1,
    content: material.data.content || '',
    media: material.data.media || {},
  };
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="server-tool-toggle">
      <input
        className="server-tool-toggle-input"
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="server-tool-toggle-label">{label}</span>
    </label>
  );
}

const ServerToolPanel = ({
  activePage,
  frame,
  onClose,
}: OwnProps) => {
  const [settings, setSettings] = useState<ServerToolSettings>(loadServerToolSettings);
  const [groups, setGroups] = useState<ServerMaterialGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<number>();
  const [materials, setMaterials] = useState<Record<number, ServerMaterial[]>>({});
  const [materialOffsets, setMaterialOffsets] = useState<Record<number, unknown>>({});
  const [groupForm, setGroupForm] = useState<GroupFormState>();
  const [materialForm, setMaterialForm] = useState<MaterialFormState>();
  const [translateConfig, setTranslateConfig] = useState<ServerTranslateConfig>();
  const [passwordForm, setPasswordForm] = useState({ password: '', newPassword: '', confirmPassword: '' });
  const [isPasswordFormOpen, setIsPasswordFormOpen] = useState(false);
  const [message, setMessage] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [isUploadingMaterial, setIsUploadingMaterial] = useState(false);
  const [loadedSpeech, setLoadedSpeech] = useState(false);
  const [loadedTranslateConfig, setLoadedTranslateConfig] = useState(false);
  const materialFileInputRef = useRef<HTMLInputElement>();
  const sendAutoTypeRef = useRef<HTMLSelectElement>();
  const sendAutoLanguageRef = useRef<HTMLSelectElement>();
  const receiveAutoTypeRef = useRef<HTMLSelectElement>();
  const receiveAutoLanguageRef = useRef<HTMLSelectElement>();
  const pageLanguageRef = useRef<HTMLSelectElement>();
  const user = getServerUserInfo();

  function updateSettings(patch: Partial<ServerToolSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveServerToolSettings(next);
    if (patch.receiveAutoLanguage) {
      getActions().setSettingOption({ translationLanguage: patch.receiveAutoLanguage });
    }
    postServerToolMessageToFrame(frame, { type: 'server-tool-settings-updated', settings: next });
  }

  function upsertMaterial(groupId: number, material: ServerMaterial, isNew: boolean) {
    setMaterials((current) => {
      const list = current[groupId] || [];
      if (isNew) return { ...current, [groupId]: [material, ...list] };

      return {
        ...current,
        [groupId]: list.map((item) => (item.ID === material.ID ? material : item)),
      };
    });
  }

  const loadMaterials = useLastCallback(async (groupId: number, options?: { force?: boolean; append?: boolean }) => {
    if (!options?.force && !options?.append && materials[groupId]) return;

    setIsLoading(true);
    try {
      const result = await fetchServerMaterials(groupId, options?.append ? materialOffsets[groupId] : undefined);
      setMaterials((current) => ({
        ...current,
        [groupId]: options?.append ? [...(current[groupId] || []), ...result.list] : result.list,
      }));
      setMaterialOffsets((current) => ({ ...current, [groupId]: result.offset }));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolFetchMaterialsFailed'));
    } finally {
      setIsLoading(false);
    }
  });

  const loadGroups = useLastCallback(async () => {
    setIsLoading(true);
    try {
      const list = await fetchServerMaterialGroups();
      setGroups(list);
      setLoadedSpeech(true);
      const nextGroupId = activeGroupId && list.some((group) => group.ID === activeGroupId)
        ? activeGroupId : list[0]?.ID;
      setActiveGroupId(nextGroupId);
      if (nextGroupId) {
        await loadMaterials(nextGroupId, { force: true });
      }
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolFetchGroupsFailed'));
    } finally {
      setIsLoading(false);
    }
  });

  const loadTranslateConfig = useLastCallback(async () => {
    setIsLoading(true);
    try {
      const config = await fetchServerTranslateConfig(0);
      const savedSettings = loadServerToolSettings();
      const nextSettings = mergeServerTranslateConfigToSettings(config, savedSettings);

      setTranslateConfig(config);
      setLoadedTranslateConfig(true);
      setSettings(nextSettings);
      saveServerToolSettings(nextSettings);
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolFetchTranslateConfigFailed'));
    } finally {
      setIsLoading(false);
    }
  });

  useEffect(() => {
    if (!activePage) return;

    setMessage(undefined);
    if (activePage === 'speech' && !loadedSpeech) {
      void loadGroups();
    }
    if ((activePage === 'translate' || activePage === 'settings') && !loadedTranslateConfig) {
      void loadTranslateConfig();
    }
  }, [activePage, loadedSpeech, loadedTranslateConfig, loadGroups, loadTranslateConfig]);

  useEffect(() => {
    // Teact 创建 select 时会先写 value 再渲染 option，配置异步加载后需要主动同步原生控件。
    if (sendAutoTypeRef.current) sendAutoTypeRef.current.value = String(settings.sendAutoType);
    if (sendAutoLanguageRef.current) sendAutoLanguageRef.current.value = settings.sendAutoLanguage;
    if (receiveAutoTypeRef.current) receiveAutoTypeRef.current.value = String(settings.receiveAutoType);
    if (receiveAutoLanguageRef.current) receiveAutoLanguageRef.current.value = settings.receiveAutoLanguage;
    if (pageLanguageRef.current) pageLanguageRef.current.value = settings.pageLanguage;
  }, [settings]);

  async function handleSaveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = groupForm?.name.trim();
    if (!name) {
      setMessage(serverToolT('serverToolValidateGroupName'));
      return;
    }

    setIsLoading(true);
    try {
      const savedGroup = groupForm?.ID
        ? await updateServerMaterialGroup(groupForm.ID, name)
        : await createServerMaterialGroup(name);
      if (savedGroup) {
        setGroups((current) => (groupForm?.ID
          ? current.map((group) => (group.ID === groupForm.ID ? savedGroup : group))
          : [savedGroup, ...current]));
        setActiveGroupId(savedGroup.ID);
      } else {
        await loadGroups();
      }
      setGroupForm(undefined);
      setMessage(serverToolT('saveSuccess'));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolFetchGroupsFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteGroup(group: ServerMaterialGroup) {
    if (!window.confirm(serverToolT('deleteFzsxTips'))) return;

    setIsLoading(true);
    try {
      await deleteServerMaterialGroup(group.ID);
      setGroups((current) => current.filter((item) => item.ID !== group.ID));
      setMaterials((current) => {
        const next = { ...current };
        delete next[group.ID];
        return next;
      });
      setActiveGroupId((current) => (current === group.ID ? undefined : current));
      setMessage(serverToolT('success'));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('deletehuashuGroup'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleClearGroup(group: ServerMaterialGroup) {
    if (!window.confirm(serverToolT('deleteSucaiAll'))) return;

    setIsLoading(true);
    try {
      await clearServerMaterialGroup(group.ID);
      setMaterials((current) => ({ ...current, [group.ID]: [] }));
      setMaterialOffsets((current) => ({ ...current, [group.ID]: undefined }));
      setMessage(serverToolT('success'));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('clearsucai'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSaveMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const gid = materialForm?.gid;
    const name = materialForm?.name.trim();
    const materialType = materialForm?.materialType || 1;
    const content = materialForm?.content.trim() || '';
    const media = materialForm?.media || {};
    if (!gid || !name || (materialType === 1 && !content) || (materialType !== 1 && !media.Url)) {
      setMessage(serverToolT('serverToolValidateMaterial'));
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        ID: materialForm?.ID,
        gid,
        name,
        type: materialType,
        data: {
          type: materialType,
          content,
          media: materialType === 1 ? {} : media,
        },
      };
      const savedMaterial = materialForm?.ID
        ? await updateServerMaterial(payload)
        : await createServerMaterial(payload);
      if (savedMaterial) {
        upsertMaterial(gid, savedMaterial, !materialForm?.ID);
      } else {
        await loadMaterials(gid, { force: true });
      }
      setMaterialForm(undefined);
      setMessage(serverToolT('saveSuccess'));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolEditMaterial'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUploadMaterialFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file || !materialForm) return;

    setIsUploadingMaterial(true);
    try {
      const result = await uploadServerToolMaterialFile(file, materialForm.materialType);
      setMaterialForm({
        ...materialForm,
        media: {
          Url: result.url,
          Name: result.name,
          Size: result.size,
        },
      });
      setMessage(serverToolT('serverToolUploadDone'));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolUploadFailed'));
    } finally {
      setIsUploadingMaterial(false);
      if (event.currentTarget) event.currentTarget.value = '';
    }
  }

  async function handleDeleteMaterial(material: ServerMaterial) {
    if (!window.confirm(serverToolT('deleteSucai'))) return;

    setIsLoading(true);
    try {
      await deleteServerMaterial(material.ID);
      setMaterials((current) => ({
        ...current,
        [material.gid!]: (current[material.gid!] || []).filter((item) => item.ID !== material.ID),
      }));
      setMaterialForm(undefined);
      setMessage(serverToolT('success'));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('deleteSucai'));
    } finally {
      setIsLoading(false);
    }
  }

  async function sendMaterial(material: ServerMaterial) {
    let text = material.data.type === 1 ? getMaterialText(material) : material.data.content || '';
    const mediaUrl = getMaterialMediaUrl(material);
    if (!text && !mediaUrl) {
      setMessage(serverToolT('serverToolNoMaterialText'));
      return;
    }

    if (text && settings.autoTranslation) {
      setIsLoading(true);
      try {
        text = await translateServerText(text, {
          targetLang: settings.sendAutoLanguage,
          type: settings.sendAutoType,
        });
      } catch (err: any) {
        setMessage(err?.message || serverToolT('serverToolSpeechTranslateFailed'));
        setIsLoading(false);
        return;
      }
      setIsLoading(false);
    }

    if (material.data.type === 2 || material.data.type === 3) {
      postServerToolMessageToFrame(frame, {
        type: 'server-tool-send-material',
        material: {
          ...material,
          data: {
            ...material.data,
            content: text,
          },
        },
      });
    } else {
      postServerToolMessageToFrame(frame, { type: 'server-tool-send-text', text });
    }
    setMessage(serverToolT('serverToolSendToChatDone'));
  }

  async function handleSaveTranslateConfig() {
    const config = {
      ...translateConfig,
      cid: 0,
      sendAuto: settings.sendAuto,
      sendAutoType: settings.sendAutoType,
      sendAutoLanguage: settings.sendAutoLanguage,
      receiveAuto: settings.receiveAuto,
      receiveAutoType: settings.receiveAutoType,
      receiveAutoLanguage: settings.receiveAutoLanguage,
      imgAuto: Boolean(translateConfig?.imgAuto),
      voiceAuto: Boolean(translateConfig?.voiceAuto),
    };

    setIsLoading(true);
    try {
      const savedConfig = await saveServerTranslateConfig(config);
      const nextSettings = {
        ...settings,
        sendAuto: Boolean(savedConfig.sendAuto),
        sendAutoType: savedConfig.sendAutoType ?? settings.sendAutoType,
        sendAutoLanguage: savedConfig.sendAutoLanguage || settings.sendAutoLanguage,
        receiveAuto: Boolean(savedConfig.receiveAuto),
        receiveAutoType: savedConfig.receiveAutoType ?? settings.receiveAutoType,
        receiveAutoLanguage: savedConfig.receiveAutoLanguage || settings.receiveAutoLanguage,
      };
      setTranslateConfig(savedConfig);
      setSettings(nextSettings);
      saveServerToolSettings(nextSettings);
      postServerToolMessageToFrame(frame, { type: 'server-tool-settings-updated', settings: nextSettings });
      setMessage(serverToolT('serverToolTranslateSaved'));
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolSaveTranslateFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordForm.password || !passwordForm.newPassword) {
      setMessage(serverToolT('serverToolValidateOldAndNewPassword'));
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setMessage(serverToolT('passwordNotMatch'));
      return;
    }

    setIsLoading(true);
    try {
      await changeServerPassword({
        username: user?.userName || user?.username,
        password: passwordForm.password,
        newPassword: passwordForm.newPassword,
      });
      setMessage(serverToolT('passwordEditSuccess'));
      setIsPasswordFormOpen(false);
      setPasswordForm({ password: '', newPassword: '', confirmPassword: '' });
      signOutServerAccount();
      window.location.reload();
    } catch (err: any) {
      setMessage(err?.message || serverToolT('serverToolUpdatePasswordFailed'));
    } finally {
      setIsLoading(false);
    }
  }

  function renderSelectOptions<T extends string | number>(
    items: { value: T; label: string }[],
    selectedValue?: string | number,
  ) {
    const currentValue = selectedValue === undefined ? undefined : String(selectedValue);

    return items.map((item) => (
      <option
        key={item.value}
        value={String(item.value)}
        selected={currentValue === String(item.value)}
      >
        {item.label}
      </option>
    ));
  }

  function renderGroupForm() {
    if (!groupForm) return undefined;

    return (
      <form className="server-tool-inline-form" onSubmit={handleSaveGroup}>
        <label className="server-tool-field">
          <span className="server-tool-field-label">{serverToolT('fenzuname')}</span>
          <input
            className="server-tool-control"
            value={groupForm.name}
            maxLength={10}
            placeholder={serverToolT('serverToolGroupNamePlaceholder')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setGroupForm({
              ...groupForm,
              name: event.currentTarget.value,
            })}
          />
        </label>
        <div className="server-tool-actions">
          <Button type="submit" size="smaller" color="primary" disabled={isLoading}>{serverToolT('save')}</Button>
          <Button type="button" size="smaller" color="translucent" onClick={() => setGroupForm(undefined)}>
            {serverToolT('cancel')}
          </Button>
        </div>
      </form>
    );
  }

  function renderMaterialForm() {
    if (!materialForm) return undefined;

    const isTextMaterial = materialForm.materialType === 1;
    const isImageMaterial = materialForm.materialType === 2;
    const isVoiceMaterial = materialForm.materialType === 3;

    return (
      <form className="server-tool-inline-form" onSubmit={handleSaveMaterial}>
        <div className="server-tool-material-form-row">
          <label className="server-tool-field">
            <span className="server-tool-field-label">{serverToolT('beizhu')}</span>
            <input
              className="server-tool-control"
              value={materialForm.name}
              maxLength={10}
              placeholder={serverToolT('serverToolMaterialNamePlaceholder')}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setMaterialForm({
                ...materialForm,
                name: event.currentTarget.value,
              })}
            />
          </label>
          <label className="server-tool-field">
            <span className="server-tool-field-label">{serverToolT('type')}</span>
            <select
              className="server-tool-control"
              value={materialForm.materialType}
              onChange={(event) => setMaterialForm({
                ...materialForm,
                materialType: Number(event.currentTarget.value),
                content: '',
                media: {},
              })}
            >
              {SERVER_TOOL_MATERIAL_TYPES.map((item) => (
                <option key={item.value} value={item.value}>{serverToolT(item.labelKey)}</option>
              ))}
            </select>
          </label>
        </div>
        {isTextMaterial && (
          <label className="server-tool-field">
            <span className="server-tool-field-label">{serverToolT('content')}</span>
            <textarea
              className="server-tool-control"
              value={materialForm.content}
              rows={4}
              placeholder={serverToolT('serverToolMaterialContentPlaceholder')}
              onChange={(event) => setMaterialForm({
                ...materialForm,
                content: event.currentTarget.value,
              })}
            />
          </label>
        )}
        {(isImageMaterial || isVoiceMaterial) && (
          <>
            <label className="server-tool-field">
              <span className="server-tool-field-label">
                {isImageMaterial ? serverToolT('photo') : serverToolT('voice')}
              </span>
              <input
                ref={materialFileInputRef}
                className="server-tool-file-input"
                type="file"
                accept={isImageMaterial ? '.jpg,.jpeg,.png,.gif,.webp' : '.ogg,.mp3,.wav,.m4a,.aac,.flac'}
                onChange={handleUploadMaterialFile}
              />
              {isImageMaterial && materialForm.media.Url && (
                <img
                  className="server-tool-material-preview-image"
                  src={materialForm.media.Url}
                  alt={materialForm.media.Name || serverToolT('photo')}
                />
              )}
              {isVoiceMaterial && materialForm.media.Url && (
                <div className="server-tool-material-preview-file">
                  <span className="icon icon-microphone-alt" />
                  <span className="server-tool-material-preview-name">
                    {materialForm.media.Name || materialForm.media.Url}
                  </span>
                </div>
              )}
              <div className="server-tool-material-upload-actions">
                <Button
                  type="button"
                  size="smaller"
                  color="translucent"
                  disabled={isUploadingMaterial}
                  onClick={() => materialFileInputRef.current?.click()}
                >
                  {isUploadingMaterial
                    ? serverToolT('serverToolUploading')
                    : isImageMaterial ? serverToolT('xzphoto') : serverToolT('xzyuyin')}
                </Button>
                {Boolean(materialForm.media.Url) && (
                  <Button
                    type="button"
                    size="smaller"
                    color="danger"
                    disabled={isUploadingMaterial}
                    onClick={() => setMaterialForm({ ...materialForm, media: {} })}
                  >
                    {serverToolT('clear')}
                  </Button>
                )}
              </div>
            </label>
            {isImageMaterial && (
              <label className="server-tool-field">
                <span className="server-tool-field-label">{serverToolT('content')}</span>
                <textarea
                  className="server-tool-control"
                  value={materialForm.content}
                  rows={2}
                  placeholder={serverToolT('AdditionalContent')}
                  onChange={(event) => setMaterialForm({
                    ...materialForm,
                    content: event.currentTarget.value,
                  })}
                />
              </label>
            )}
          </>
        )}
        <div className="server-tool-actions">
          <Button type="submit" size="smaller" color="primary" disabled={isLoading || isUploadingMaterial}>
            {serverToolT('save')}
          </Button>
          {Boolean(materialForm.ID) && (
            <Button
              type="button"
              size="smaller"
              color="danger"
              disabled={isLoading}
              onClick={() => {
                const material = materials[materialForm.gid!]?.find((item) => item.ID === materialForm.ID);
                if (material) void handleDeleteMaterial(material);
              }}
            >
              {serverToolT('delete')}
            </Button>
          )}
          <Button type="button" size="smaller" color="translucent" onClick={() => setMaterialForm(undefined)}>
            {serverToolT('cancel')}
          </Button>
        </div>
      </form>
    );
  }

  function renderSpeech() {
    return (
      <>
        <div className="server-tool-speech-head">
          <div className="server-tool-tabs" role="tablist">
            <button type="button" className="server-tool-tab active">{serverToolT('gerenmaterial')}</button>
            <button type="button" className="server-tool-tab" disabled>{serverToolT('gongongmaterial')}</button>
          </div>
          <div className="server-tool-speech-actions">
            <Button
              round
              size="tiny"
              color={settings.autoTranslation ? 'primary' : 'translucent'}
              iconName="language"
              ariaLabel={serverToolT('translationAutomatic')}
              onClick={() => updateSettings({ autoTranslation: !settings.autoTranslation })}
            />
            <Button
              round
              size="tiny"
              color="translucent"
              iconName="add"
              ariaLabel={serverToolT('createhuashuGroup')}
              onClick={() => setGroupForm(DEFAULT_GROUP_FORM)}
            />
            <Button
              round
              size="tiny"
              color="translucent"
              iconName="reload"
              ariaLabel={serverToolT('serverToolRefreshSpeech')}
              onClick={loadGroups}
            />
          </div>
        </div>
        {renderGroupForm()}
        {renderMaterialForm()}
        <div className="server-tool-collapse">
          {groups.map((group) => {
            const isOpen = group.ID === activeGroupId;
            const currentMaterials = materials[group.ID] || [];
            const currentOffset = materialOffsets[group.ID];

            return (
              <section key={group.ID} className={buildClassName('server-tool-collapse-item', isOpen && 'open')}>
                <button
                  type="button"
                  className="server-tool-collapse-title"
                  onClick={() => {
                    const nextGroupId = isOpen ? undefined : group.ID;
                    setActiveGroupId(nextGroupId);
                    if (nextGroupId) void loadMaterials(nextGroupId);
                  }}
                >
                  <span className={buildClassName('icon', isOpen ? 'icon-up' : 'icon-down')} />
                  <span className="server-tool-collapse-name">{group.name}</span>
                </button>
                {isOpen && (
                  <div className="server-tool-collapse-body">
                    <div className="server-tool-group-actions">
                      <Button
                        round
                        size="tiny"
                        color="danger"
                        iconName="delete"
                        ariaLabel={serverToolT('deletehuashuGroup')}
                        onClick={() => void handleDeleteGroup(group)}
                      />
                      <Button
                        round
                        size="tiny"
                        color="translucent"
                        iconName="delete"
                        ariaLabel={serverToolT('clearsucai')}
                        onClick={() => void handleClearGroup(group)}
                      />
                      <Button
                        round
                        size="tiny"
                        color="translucent"
                        iconName="edit"
                        ariaLabel={serverToolT('edithuashuGroup')}
                        onClick={() => setGroupForm({ ID: group.ID, name: group.name })}
                      />
                      <Button
                        round
                        size="tiny"
                        color="green"
                        iconName="add"
                        ariaLabel={serverToolT('addsucai')}
                        onClick={() => setMaterialForm({ ...DEFAULT_MATERIAL_FORM, gid: group.ID })}
                      />
                    </div>
                    <div className="server-tool-material-list">
                      {currentMaterials.map((material) => (
                        <div key={material.ID} className="server-tool-material">
                          <button
                            type="button"
                            className="server-tool-material-main"
                            onClick={() => setMaterialForm(getMaterialFormFromMaterial(material, group.ID))}
                          >
                            <span className="server-tool-material-type">
                              <span className={`icon icon-${getMaterialIcon(material)}`} />
                            </span>
                            <span className="server-tool-material-name">{material.name}</span>
                          </button>
                          <Button
                            round
                            size="tiny"
                            color="green"
                            iconName="send"
                            ariaLabel={serverToolT('serverToolSendMaterial')}
                            disabled={!canSendMaterial(material)}
                            onClick={() => sendMaterial(material)}
                          />
                        </div>
                      ))}
                      {!currentMaterials.length && (
                        <div className="server-tool-empty compact">{serverToolT('serverToolNoMaterials')}</div>
                      )}
                    </div>
                    {Boolean(currentOffset) && (
                      <button
                        type="button"
                        className="server-tool-load-more"
                        disabled={isLoading}
                        onClick={() => loadMaterials(group.ID, { append: true })}
                      >
                        {serverToolT('serverToolLoadMore')}
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {!groups.length && <div className="server-tool-empty">{serverToolT('serverToolNoMaterials')}</div>}
        </div>
      </>
    );
  }

  function renderTranslate() {
    const translateFormKey = [
      settings.sendAutoType,
      settings.sendAutoLanguage,
      settings.receiveAutoType,
      settings.receiveAutoLanguage,
    ].join(':');

    return (
      <div key={translateFormKey} className="server-tool-form">
        <section className="server-tool-section">
          <strong className="server-tool-section-title">{serverToolT('sendAutoTranslate')}</strong>
          <Toggle
            checked={settings.sendAuto}
            label={serverToolT('sendAutoTranslate')}
            onChange={(checked) => updateSettings({ sendAuto: checked })}
          />
          <Toggle
            checked={settings.previewTranslation}
            label={serverToolT('previewTranslation')}
            onChange={(checked) => updateSettings({ previewTranslation: checked })}
          />
          <label className="server-tool-field">
            <span className="server-tool-field-label">{serverToolT('translateChannel')}</span>
            <select
              ref={sendAutoTypeRef}
              className="server-tool-control"
              value={String(settings.sendAutoType)}
              onChange={(event) => updateSettings({ sendAutoType: Number(event.currentTarget.value) })}
            >
              {renderSelectOptions(SERVER_TOOL_TRANSLATE_CHANNELS, settings.sendAutoType)}
            </select>
          </label>
          <label className="server-tool-field">
            <span className="server-tool-field-label">{serverToolT('targetLanguage')}</span>
            <select
              ref={sendAutoLanguageRef}
              className="server-tool-control"
              value={String(settings.sendAutoLanguage)}
              onChange={(event) => updateSettings({ sendAutoLanguage: event.currentTarget.value })}
            >
              {renderSelectOptions(SERVER_TOOL_LANGUAGES, settings.sendAutoLanguage)}
            </select>
          </label>
        </section>

        <section className="server-tool-section">
          <strong className="server-tool-section-title">{serverToolT('receiveAutoTranslate')}</strong>
          <Toggle
            checked={settings.receiveAuto}
            label={serverToolT('receiveAutoTranslate')}
            onChange={(checked) => updateSettings({ receiveAuto: checked })}
          />
          <label className="server-tool-field">
            <span className="server-tool-field-label">{serverToolT('translateChannel')}</span>
            <select
              ref={receiveAutoTypeRef}
              className="server-tool-control"
              value={String(settings.receiveAutoType)}
              onChange={(event) => updateSettings({ receiveAutoType: Number(event.currentTarget.value) })}
            >
              {renderSelectOptions(SERVER_TOOL_TRANSLATE_CHANNELS, settings.receiveAutoType)}
            </select>
          </label>
          <label className="server-tool-field">
            <span className="server-tool-field-label">{serverToolT('targetLanguage')}</span>
            <select
              ref={receiveAutoLanguageRef}
              className="server-tool-control"
              value={String(settings.receiveAutoLanguage)}
              onChange={(event) => updateSettings({ receiveAutoLanguage: event.currentTarget.value })}
            >
              {renderSelectOptions(SERVER_TOOL_LANGUAGES, settings.receiveAutoLanguage)}
            </select>
          </label>
        </section>

        <div className="server-tool-actions">
          <Button type="button" size="smaller" color="translucent" onClick={handleSaveTranslateConfig}>
            {serverToolT('save')}
          </Button>
        </div>
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="server-tool-settings">
        <div className="server-tool-profile">
          <div className="server-tool-profile-row">
            <span className="server-tool-profile-label">{serverToolT('userName')}</span>
            <strong className="server-tool-profile-value">{user?.userName || user?.username || '-'}</strong>
          </div>
          <div className="server-tool-profile-row">
            <span className="server-tool-profile-label">{serverToolT('nickName')}</span>
            <strong className="server-tool-profile-value">{user?.nickName || '-'}</strong>
          </div>
        </div>
        <Toggle
          checked={settings.autoTranslation}
          label={serverToolT('translationAutomatic')}
          onChange={(checked) => updateSettings({ autoTranslation: checked })}
        />
        <label className="server-tool-field">
          <span className="server-tool-field-label">{serverToolT('viewInterface')}</span>
          <select
            ref={pageLanguageRef}
            className="server-tool-control"
            value={String(settings.pageLanguage)}
            onChange={(event) => updateSettings({ pageLanguage: event.currentTarget.value })}
          >
            {renderSelectOptions(SERVER_TOOL_LANGUAGES, settings.pageLanguage)}
          </select>
        </label>
        <Button
          type="button"
          size="smaller"
          color="translucent"
          onClick={() => {
            clearServerMaterialCache();
            setMaterials({});
            setMaterialOffsets({});
            setMessage(serverToolT('serverToolClearCacheDone'));
          }}
        >
          {serverToolT('synhuashuGroup')}
        </Button>
        {!isPasswordFormOpen ? (
          <Button
            type="button"
            size="smaller"
            color="translucent"
            onClick={() => setIsPasswordFormOpen(true)}
          >
            {serverToolT('editPassword')}
          </Button>
        ) : (
          <form className="server-tool-inline-form compact" onSubmit={handleChangePassword}>
            <label className="server-tool-field">
              <span className="server-tool-field-label">{serverToolT('oldPassword')}</span>
              <input
                className="server-tool-control"
                type="password"
                value={passwordForm.password}
                placeholder={serverToolT('pleaseEnterOldPassword')}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setPasswordForm({
                  ...passwordForm,
                  password: event.currentTarget.value,
                })}
              />
            </label>
            <label className="server-tool-field">
              <span className="server-tool-field-label">{serverToolT('newPassword')}</span>
              <input
                className="server-tool-control"
                type="password"
                value={passwordForm.newPassword}
                placeholder={serverToolT('pleaseEnterNewPassword')}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setPasswordForm({
                  ...passwordForm,
                  newPassword: event.currentTarget.value,
                })}
              />
            </label>
            <label className="server-tool-field">
              <span className="server-tool-field-label">{serverToolT('confirmNewPassword')}</span>
              <input
                className="server-tool-control"
                type="password"
                value={passwordForm.confirmPassword}
                placeholder={serverToolT('pleaseConfirmPassword')}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setPasswordForm({
                  ...passwordForm,
                  confirmPassword: event.currentTarget.value,
                })}
              />
            </label>
            <div className="server-tool-actions">
              <Button type="submit" size="smaller" color="primary" disabled={isLoading}>
                {serverToolT('save')}
              </Button>
              <Button
                type="button"
                size="smaller"
                color="translucent"
                onClick={() => {
                  setIsPasswordFormOpen(false);
                  setPasswordForm({ password: '', newPassword: '', confirmPassword: '' });
                }}
              >
                {serverToolT('cancel')}
              </Button>
            </div>
          </form>
        )}
        <Button
          type="button"
          size="smaller"
          color="danger"
          onClick={() => {
            signOutServerAccount();
            window.location.reload();
          }}
        >
          {serverToolT('loginout')}
        </Button>
      </div>
    );
  }

  if (!activePage) return undefined;

  const titleMap = {
    speech: serverToolT('sucai'),
    translate: serverToolT('fanyi'),
    settings: serverToolT('setting'),
  };

  return (
    <section className="server-tool-panel">
      <header className="server-tool-header">
        <strong>{titleMap[activePage]}</strong>
        <Button
          round
          size="tiny"
          color="translucent"
          iconName="close"
          ariaLabel={serverToolT('serverToolClosePanel')}
          onClick={onClose}
        />
      </header>
      {message && <div className="server-tool-message">{message}</div>}
      {isLoading && <div className="server-tool-loading">{serverToolT('serverToolLoading')}</div>}
      <div className="server-tool-content custom-scroll">
        {activePage === 'speech' && renderSpeech()}
        {activePage === 'translate' && renderTranslate()}
        {activePage === 'settings' && renderSettings()}
      </div>
    </section>
  );
};

export default memo(ServerToolPanel);
