/**
 * The one thing the device tools need from the companion heartbeat: whether
 * this contact's heartbeat is running right now. The heartbeat service
 * satisfies it structurally; the gateway root hands it in.
 */
export interface HeartbeatActivity {
  isActive(contactId: string): boolean;
}
