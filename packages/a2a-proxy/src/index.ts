/**
 * @acp/a2a-proxy — a thin proxy adapter over @acp/agent-sdk. It serves a
 * registered proxy agent's task queue and forwards each capability to a remote
 * A2A endpoint using the adapter's OWN credential. The platform's broker
 * delegated token never egresses to the remote, and every remote reply is
 * treated as untrusted (schema-validated by the SDK, provenance stripped/tagged
 * here).
 */

export {
  A2AClient,
  A2ATimeoutError,
  A2ATransportError,
  TERMINAL_STATES,
  type A2AClientOptions,
  type A2ASendRequest,
  type A2ATaskView,
} from './client.js';
export {
  registerProxyCapabilities,
  sanitizeRemoteOutput,
  type ProxyOptions,
} from './proxy.js';
