import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ClaudeQuota,
  type CodexQuota,
  type Contact,
  type ContactStatus,
  type GrokQuota,
  type ModelCatalog,
  type Usage,
} from '../../api';

export function useUsagePoll(contact: Contact, status: ContactStatus) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [quota, setQuota] = useState<ClaudeQuota | null>(null);
  const [codexQuota, setCodexQuota] = useState<CodexQuota | null>(null);
  const [grokQuota, setGrokQuota] = useState<GrokQuota | null>(null);

  const refresh = useCallback(() => {
    void api.usage(contact.id).then(setUsage).catch(() => {});
    if (contact.backend === 'claude-cli') void api.claudeQuota().then(setQuota).catch(() => {});
    else if (contact.backend === 'codex') void api.codexQuota().then(setCodexQuota).catch(() => {});
    else if (contact.backend === 'grok-cli') void api.grokQuota().then(setGrokQuota).catch(() => {});
  }, [contact.backend, contact.id]);

  useEffect(() => {
    setUsage(null);
    setQuota(null);
    setCodexQuota(null);
    setGrokQuota(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (status.state === 'idle') refresh();
  }, [refresh, status.state]);

  return { usage, quota, codexQuota, grokQuota };
}

export function useModelCatalog(contact: Contact, isRoom: boolean, onError: (message: string) => void) {
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);

  useEffect(() => {
    setModelCatalog(null);
    if (isRoom) return;
    void api.models(contact.id).then(setModelCatalog).catch(() => {});
  }, [contact.backend, contact.config.effort, contact.config.model, contact.id, isRoom]);

  const switchValue = async (kind: 'model' | 'effort', value: string) => {
    setSwitchingModel(true);
    try {
      if (kind === 'model') await api.switchModel(contact.id, value);
      else await api.switchEffort(contact.id, value);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSwitchingModel(false);
    }
  };

  return {
    modelCatalog,
    switchingModel,
    switchModel: (model: string) => switchValue('model', model),
    switchEffort: (effort: string) => switchValue('effort', effort),
  };
}
