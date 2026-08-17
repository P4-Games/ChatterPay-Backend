# `__to_deploy__`

Todo lo que un deploy necesita y **el repo no aplica solo**: cambios de base de datos, variables de
entorno nuevas, y cualquier paso manual en GCP.

El repo describe el código, no el estado de los entornos. MongoDB no tiene migraciones versionadas
acá —el schema vive en `src/models/` y los datos se cargan con scripts de `scripts/`—, y las
substitutions de Cloud Build viven en el trigger, no en `cloudbuild.yaml`. En ninguno de los dos
casos se puede reconstruir desde el repo **qué se corrió, dónde y cuándo**. Esta carpeta es ese
registro.

## Convención

- Un archivo por cambio: `AAAA-MM-DD-descripcion-corta.md`.
- Documentar **lo que quedó realmente aplicado**, no lo que el script pretendía hacer. Si hay
  diferencia entre las dos cosas, esa diferencia es justamente lo que hay que anotar.
- Toda entrada incluye: entornos aplicados, verificación y rollback.
- Los entornos donde el cambio **todavía no** se aplicó se listan explícitamente. Un cambio aplicado
  a medias es lo que rompe un deploy tres semanas después.

## Índice

| Fecha | Cambio | Tipo | Entornos aplicados |
|---|---|---|---|
| 2026-08-16 | [Cardano: red, token ADA e índices](./2026-08-16-cardano-preprod.md) | base de datos | `local dev` |
| 2026-08-16 | [Cardano: variables de entorno para GCP](./2026-08-16-cardano-env-vars.md) | entorno / Cloud Build | ⛔ ninguno |
| 2026-08-16 | [Cardano: configuración por ambiente (dev/test y prod)](./2026-08-16-cardano-config-entornos.md) | base de datos + entorno | ⛔ ninguno |
| 2026-08-16 | [Cardano en chatizalo: tools, templates y prompt](./2026-08-16-cardano-chatizalo.md) | base de datos (chatizalo + templates) | ⛔ ninguno |

> El orden entre los cuatro no es opcional:
>
> 1. **base del backend** (`blockchains`, `tokens`, índices) — sin esto la familia no tiene dónde
>    leer su red ni sus tokens;
> 2. **variables de entorno** — habilitan el código que consulta esa base;
> 3. **chatizalo** (`chat_functions`, prompt) — recién tiene sentido ofrecer la funcionalidad cuando
>    el backend la responde. Al revés, el bot ofrece una operación que devuelve error.
>
> Los dos primeros archivos son el registro de lo que se aplicó en local; los dos últimos son lo que
> falta aplicar, con los valores listos para copiar.
