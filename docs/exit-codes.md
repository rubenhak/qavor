# Exit codes

`qavor` follows a small, documented exit-code contract. Tools that integrate with `qavor` (CI scripts, shell wrappers) can branch on these codes without scraping log output.

| Code | Name           | Meaning                                                                 |
| ---- | -------------- | ----------------------------------------------------------------------- |
| `0`  | OK             | The command completed successfully.                                     |
| `1`  | User error     | Invalid arguments or misuse (e.g. unknown service, malformed `--env`).  |
| `2`  | Manifest error | YAML parse or schema validation failed. Output includes `file:line:column`. |
| `3`  | Runtime error  | A subprocess (`git`, language toolchain, supervised service) failed, or a filesystem operation failed unexpectedly. |
| `≥10` | Reserved      | Future use. Do not depend on these values.                              |

`--json` mode preserves these exit codes and emits structured payloads on `stdout`. Logs are always emitted on `stderr`.
