// Privileged (host-side) handlers for this artifact. Action code
// runs in the portable worker and may not read the host `process`
// global; the one host fact the AIS collector needs is the egress
// proxy configured for this process's network (its WebSocket
// client does not discover it by itself, unlike fetch). The proxy
// value stays server-side: it is returned only to the calling
// action, which uses it in the WebSocket constructor and never
// forwards it to the client.
import {
  definePrivilegedContracts,
  definePrivilegedHandlers,
  z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  getEgressProxy: {
    request: z.object({}),
    response: z.object({ proxy: z.string().nullable() }),
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  getEgressProxy() {
    const proxy =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      null;
    return { proxy };
  },
});
