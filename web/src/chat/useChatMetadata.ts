import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type Contact,
  type ContactStatus,
  type ModelCatalog,
  type Usage,
} from '../platform/api';

export function useUsagePoll(contact: Contact, status: ContactStatus) {
  const [usage, setUsage] = useState<Usage | null>(null);

  const refresh = useCallback(() => {
    void api.usage(contact.id).then(setUsage).catch(() => {});
  }, [contact.id]);

  useEffect(() => {
    setUsage(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (status.state === 'idle') refresh();
  }, [refresh, status.state]);

  return { usage };
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
