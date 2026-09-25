# contracts

The API's public surface, consumed by `recruit-crm-web` (and any future client).

| Path | What it is |
| --- | --- |
| `models.ts` | Plain TypeScript model types and enums, generated from `prisma/schema.prisma` by `npm run db:generate`. Do not edit. |
| `http.ts` | Wire-level types: the error envelope, `MessageResult`, route definition shape. |
| `routes/*.ts` | One file per domain declaring its endpoints as `"METHOD /path/{param}": { params, query, body, response }`. |
| `shared/*.ts` | Dependency-free domain logic both sides need: role predicates, stage graph, field registry, labels, date/phone formatting. |
| `index.ts` | Re-exports everything and composes the `ApiRoutes` map. |

## Rules

- **No dependencies.** Files here may only import each other by relative path. ESLint enforces this.
- **The API is checked against it.** Every JSON endpoint is registered through `route(app, "METHOD /path", …)` in `src/http/route.ts`, which type-checks the handler's input schemas and return value against `ApiRoutes`.
- **Dates are `Date` in the types and ISO-8601 strings on the wire.** The web client revives them.
- **Changing a contract is an API change.** Bump the web copy with `npm run contracts:sync` in `recruit-crm-web` in the same change set.
