# Variables de entorno de Cardano — alta en GCP

**Fecha:** 2026-08-16
**Motivo:** habilitar transferencias de ADA y stablecoins nativas en Cardano
**Depende de:** [los cambios de base de datos](./2026-08-16-cardano-preprod.md) (aplicar primero)

---

## Resumen

Son **8 variables**. Ya están cableadas en el repo — `example_env`, `Dockerfile` (`ARG` + `ENV`) y
`cloudbuild.yaml` (env del step `CreateEnv` + `--build-arg` del step `Build`) — con el mismo patrón
que `POLYMARKET_*` y `LIFI_*`.

**Lo único que falta hacer a mano es darlas de alta como _substitutions_ en el trigger de Cloud
Build.** Este `cloudbuild.yaml` no declara bloque `substitutions:`: las toma del trigger, igual que
`_POLYMARKET_ENABLED`.

> Si no se dan de alta, `${_CARDANO_ENABLED}` resuelve a vacío y la familia queda **apagada**. Es un
> default seguro —nada se rompe— pero Cardano no funciona y el motivo no es evidente en los logs.

**Ninguna es secreta.** No hay que tocar Secret Manager ni `availableSecrets`: son URL de provider,
red, timeouts y umbrales. (El tier pago de Koios no se va a usar, así que no existe una variable de
token.)

---

## Valores por entorno

| Substitution | dev / staging (Preprod) | producción (mainnet) |
|---|---|---|
| `_CARDANO_ENABLED` | `true` | `false` hasta el go-live |
| `_CARDANO_NETWORK` | `preprod` | `mainnet` |
| `_CARDANO_CHAIN_ID` | `900000000001` | `900764824073` |
| `_CARDANO_PROVIDER_URL` | `https://preprod.koios.rest/api/v1` | `https://api.koios.rest/api/v1` |
| `_CARDANO_PROVIDER_TIMEOUT_MS` | `20000` | `20000` |
| `_CARDANO_TTL_SLOTS` | `900` | `900` |
| `_CARDANO_DEPOSIT_CONFIRMATIONS` | `3` | `3` |
| `_CARDANO_EXPLORER_URL` | `https://preprod.cardanoscan.io/transaction/` | `https://cardanoscan.io/transaction/` |

### Para copiar y pegar — Preprod

```
_CARDANO_ENABLED=true
_CARDANO_NETWORK=preprod
_CARDANO_CHAIN_ID=900000000001
_CARDANO_PROVIDER_URL=https://preprod.koios.rest/api/v1
_CARDANO_PROVIDER_TIMEOUT_MS=20000
_CARDANO_TTL_SLOTS=900
_CARDANO_DEPOSIT_CONFIRMATIONS=3
_CARDANO_EXPLORER_URL=https://preprod.cardanoscan.io/transaction/
```

### Para copiar y pegar — mainnet

```
_CARDANO_ENABLED=false
_CARDANO_NETWORK=mainnet
_CARDANO_CHAIN_ID=900764824073
_CARDANO_PROVIDER_URL=https://api.koios.rest/api/v1
_CARDANO_PROVIDER_TIMEOUT_MS=20000
_CARDANO_TTL_SLOTS=900
_CARDANO_DEPOSIT_CONFIRMATIONS=3
_CARDANO_EXPLORER_URL=https://cardanoscan.io/transaction/
```

---

## Qué hace cada una

**`CARDANO_ENABLED`** — interruptor de la familia. En `false`, el backend se comporta exactamente
como hoy. No alcanza por sí solo: la familia también exige `SEED_INTERNAL_SALT` y un provider URL, y
si falta alguno queda apagada con el motivo explícito en `disabledReason`. Media configuración es
peor que ninguna — un transfer que llega a construirse y después no puede enviarse ya consumió el
lock de operación del usuario y una notificación.

**`CARDANO_NETWORK`** — `preprod` o `mainnet`. **Decide el header byte de cada address que se emite**
(CIP-19). Apuntar mal esta variable produce addresses perfectamente bien formadas de las que nadie
puede gastar, y ningún chequeo posterior lo detecta.

**`CARDANO_CHAIN_ID`** — id interno, no EIP-155 (`9e11 + network magic`). **Queda congelado una vez
que se escribe cualquier dato**: una wallet, una transacción o un token que lo lleve es una fila que
nadie puede reinterpretar después. Tiene que coincidir con lo que se sembró en la base.

**`CARDANO_PROVIDER_URL`** — raíz de Koios. La red vive en la URL: apuntar un deployment de Preprod
al root de mainnet leería y enviaría contra una cadena cuyas addresses este deployment no puede
derivar. Koios no necesita API key; el tier gratuito tiene rate limit, así que **un 429 sostenido en
producción es la señal para revisar la elección de provider**, no para subir el timeout.

**`CARDANO_PROVIDER_TIMEOUT_MS`** — techo por llamada. Ojo con bajarlo: un submit que timeoutea tiene
resultado **indeterminado** (puede haber llegado a la cadena), y el backend lo resuelve consultando
el tx id en vez de reenviar. Un timeout agresivo multiplica esos casos.

**`CARDANO_TTL_SLOTS`** — validez de la transacción, contada desde el tip. Un slot es un segundo, así
que 900 son quince minutos. Cardano **no tiene replace-by-fee ni nonce**: el TTL es el único
mecanismo que vuelve resoluble una transacción trabada — pasado ese punto, los inputs quedan
provablemente libres otra vez.

**`CARDANO_DEPOSIT_CONFIRMATIONS`** — bloques exigidos antes de gastar un output. **No es finalidad**:
la garantía de Cardano es probabilística y la finalidad plena está a miles de bloques, que ningún
producto espera. Tres bloques es la respuesta declarada a la pregunta del rollback.

**`CARDANO_EXPLORER_URL`** — base del link que se manda en las notificaciones. Termina en
`/transaction/`, **no en `/tx/`**: Cardanoscan usa otra ruta que todos los exploradores EVM.

---

## Orden de deploy

1. Aplicar los [cambios de base de datos](./2026-08-16-cardano-preprod.md) — schema, seeds e índices.
2. Dar de alta las 8 substitutions en el trigger, con `_CARDANO_ENABLED=false`.
3. Deployar. Nada cambia de comportamiento: la familia está apagada.
4. Verificar que el servicio levanta y que las transferencias EVM siguen normales.
5. Recién ahí poner `_CARDANO_ENABLED=true` y volver a deployar.

Separar los pasos 3 y 5 es lo que permite distinguir "el deploy rompió algo" de "Cardano rompió
algo". Si van juntos, una regresión tiene dos causas candidatas.

## Cómo verificar que quedó bien

```bash
# La familia responde: una address bech32 devuelve la forma de balance habitual.
curl -H "Origin: https://<dominio>" \
  "https://<host>/balance/addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal"

# Con CARDANO_ENABLED=false, un transfer de ADA responde 200 con
# "Cardano is not available right now (CARDANO_ENABLED is not true)".
# Con true, responde el mensaje de operación en curso.
```

## Rollback

Poner `_CARDANO_ENABLED=false` y deployar. El resto de las variables puede quedarse: sin el flag no
se lee ninguna. No hace falta revertir la base — todo lo que se agregó ahí es opcional o aditivo.
