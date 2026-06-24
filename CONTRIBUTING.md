# Contributing

Thanks for helping improve Cana Walkie-Talkie! 🎉

## Ground rules

- **Keep the wire protocol backward-compatible.** Changes to frames in
  `PROTOCOL.md` must be additive (new optional fields / frame types). Bump
  `policyVersion` / a protocol version when behaviour changes.
- **No native dependencies.** The core stays installable with a plain
  `npm install` (Express + `ws` + Zod, SQLite via built-in `node:sqlite`).
- **Single-node scope.** Multi-node fan-out, RBAC, audit, push, etc. live in the
  hosted product. Contributions that re-add those belong behind the existing
  `broadcaster` / `auth` interfaces as optional adapters, not in the core path.

## Dev workflow

```bash
npm install
npm run dev        # tsx watch
npm run typecheck  # tsc --noEmit
npm test           # end-to-end smoke test
```

## Pull requests

1. Fork and branch from `main`.
2. Keep PRs focused; update `README.md` / `PROTOCOL.md` when behaviour changes.
3. Make sure `npm run typecheck` and `npm test` pass.
4. Describe the change and the motivation.

## Security

Please report vulnerabilities privately to **security@colate.io** instead of
opening a public issue.
