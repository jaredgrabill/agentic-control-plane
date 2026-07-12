import { subjects, type AgentCard } from '@acp/protocol';
import { KillSwitchControl, openKv, type Logger } from '@acp/service-kit';
import type { KV, NatsConnection } from 'nats';
import type { RegistryAnnouncer } from './app.js';

export const REGISTRY_BUCKET = 'acp_registry';
/** Versioned KV key (debt #3): one snapshot per (agent_id, version). */
export const cardKey = (agentId: string, version: string): string => `agent.${agentId}.${version}`;

/**
 * Publishes registry announcements on acp.platform.registry.<id>.<verb>
 * and keeps the KV snapshot fresh for cold-starting caches. The bus event
 * is the notification; Postgres remains the authoritative read.
 */
export class NatsRegistryAnnouncer implements RegistryAnnouncer {
  private constructor(
    private readonly nc: NatsConnection,
    private readonly kv: KV,
    private readonly killSwitch: KillSwitchControl,
    private readonly logger: Logger,
  ) {}

  static async connect(nc: NatsConnection, logger: Logger): Promise<NatsRegistryAnnouncer> {
    const kv = await openKv(nc, REGISTRY_BUCKET);
    const killSwitch = await KillSwitchControl.open(nc);
    return new NatsRegistryAnnouncer(nc, kv, killSwitch, logger);
  }

  async announce(verb: 'registered' | 'updated', card: AgentCard): Promise<void> {
    await this.kv.put(cardKey(card.manifest.id, card.version), JSON.stringify(card));
    this.nc.publish(subjects.registry(card.manifest.id, verb), JSON.stringify(card));
    this.logger.info(
      { agent_id: card.manifest.id, verb, state: card.lifecycle_state },
      'registry announcement published',
    );
  }

  async setSuspended(
    agentId: string,
    suspended: boolean,
    reason: string,
    by: string,
  ): Promise<void> {
    if (suspended) {
      await this.killSwitch.suspendAgent(agentId, reason, by);
    } else {
      await this.killSwitch.reinstateAgent(agentId);
    }
  }
}
