import type { Contact, WorkflowAgent, WorkflowModuleBinding, WorkflowModuleId } from '../platform/api';

export const WORKFLOW_MAIN: WorkflowModuleId[] = ['plan', 'execute', 'review', 'merge', 'deploy'];
export const WORKFLOW_SUPPORT: WorkflowModuleId[] = ['arbitration', 'maintenance'];

export function isWorkflowRoom(contact: Pick<Contact, 'kind' | 'config'>): boolean {
  if (contact.kind !== 'room') return false;
  const cfg = contact.config as Record<string, unknown>;
  return cfg.workflowEnabled === true || (cfg.workflowEnabled !== false
    && !!cfg.coordination && typeof cfg.coordination === 'object');
}

export function sameModuleBinding(a: WorkflowModuleBinding, b: WorkflowModuleBinding): boolean {
  return a.contactId === b.contactId && a.runner === b.runner && a.model === b.model && a.reasoning === b.reasoning;
}

/** An explicit agent/model selection chooses only an advertised effort. The
 * saved binding is never rewritten merely because a catalog refresh arrives. */
export function bindingForAgent(agent: WorkflowAgent, previous: WorkflowModuleBinding): WorkflowModuleBinding {
  const model = agent.models.find((item) => item.id === previous.model) ?? agent.models[0];
  return {
    contactId: agent.contactId,
    runner: agent.runner,
    model: model?.id ?? '',
    reasoning: chooseEffort(model?.efforts ?? [], previous.reasoning),
  };
}

export function chooseEffort(efforts: string[], previous: string): string {
  return efforts.includes(previous) ? previous : efforts.includes('high') ? 'high' : efforts[0] ?? '';
}

export function validModuleBinding(id: WorkflowModuleId, binding: WorkflowModuleBinding, agents: WorkflowAgent[]): boolean {
  const agent = agents.find((item) => item.contactId === binding.contactId);
  const model = agent?.models.find((item) => item.id === binding.model);
  return !!agent && agent.runner === binding.runner && agent.compatibleModules.includes(id)
    && !!model && model.efforts.includes(binding.reasoning);
}
