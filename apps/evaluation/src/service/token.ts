/** Mints a short-lived acp:llm token (scope llm:invoke) for the calibrate CLI. */
export async function mintLlmToken(params: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const doFetch = params.fetchImpl ?? fetch;
  const res = await doFetch(`${params.tokenUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: params.clientId,
      client_secret: params.clientSecret,
      audience: 'acp:llm',
      scope: 'llm:invoke',
    }),
  });
  if (!res.ok) {
    throw new Error(`token service refused acp:llm: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}
