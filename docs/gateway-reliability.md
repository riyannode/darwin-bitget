# Gateway reliability

## Error semantics

The worker preserves the distinction between transport failures and provider
responses. `ExecutionResult.status` remains `unknown` whenever provider acceptance
cannot be excluded; gateway classification is diagnostic metadata only.

Supported classifications are:

- `GATEWAY_HTTP_502`
- `GATEWAY_TIMEOUT`
- `GATEWAY_UNREACHABLE`
- `GATEWAY_INVALID_RESPONSE`
- `GATEWAY_INTERNAL_ERROR`
- `PROVIDER_REJECTED`
- `PROVIDER_NOT_FOUND`

The gateway returns provider-not-found responses with HTTP `424` and a structured
JSON envelope. This avoids Cloudflare Tunnel replacing an origin HTTP `502` body
with the generic `error code: 502` response. Other provider failures retain their
existing HTTP behavior.

## Correlation logging

Every authenticated private operation emits bounded JSON records:

```json
{"event":"GATEWAY_REQUEST_START","requestId":"...","operation":"getOrderDetails","symbol":"ACCOUNT","startedAt":"..."}
{"event":"GATEWAY_REQUEST_END","requestId":"...","operation":"getOrderDetails","symbol":"ACCOUNT","status":"PROVIDER_NOT_FOUND","httpStatus":424,"durationMs":123,"providerCode":"400","providerMessage":"Order does not exist"}
```

Logs never contain request bodies, request headers, API credentials, bearer tokens,
signatures, or passphrases. Request IDs supplied by callers are accepted only when
bounded to `[A-Za-z0-9._:-]{1,80}`; otherwise the gateway generates a UUID.

## Evidence semantics

Proven by the production diagnosis:

- public tunnel private success responses reached the gateway and Bitget;
- the public `getOrderDetails` provider-error path returned generic Cloudflare 502;
- the localhost gateway and direct Bitget SDK returned structured provider errors;
- the original KORU client order ID was absent from order details, order history,
  open orders, and positions at readback time.

Not proven by the diagnosis:

- whether the historical KORU `placeOrder` reached the gateway;
- whether the historical KORU `placeOrder` reached Bitget.

No retry, replacement order, cancellation, position modification, or execution
state conversion is performed by this reliability boundary.
