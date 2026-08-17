# Cardano: variables de entorno y valores por ambiente

**Fecha:** 2026-08-16 (actualizado 2026-08-17)
**Motivo:** habilitar transferencias de ADA y de native assets en Cardano
**Depende de:** [los cambios de base de datos](./2026-08-16-cardano-config-entornos.md) — aplicar
primero, o el flag habilita una familia que no tiene dónde leer su red ni sus tokens

**Este archivo es la única fuente de valores de entorno de Cardano.** Si algo de esto aparece
repetido en otro documento, el que manda es éste.

---

## 1. Las 8 variables, con sus valores por ambiente

| # | Variable (runtime) | Substitution (Cloud Build) | local dev | dev / test (GCP) | producción |
|---|---|---|---|---|---|
| 1 | `CARDANO_ENABLED` | `_CARDANO_ENABLED` | `false` | `true` | `false` → `true` en un segundo deploy |
| 2 | `CARDANO_NETWORK` | `_CARDANO_NETWORK` | `preprod` | `preprod` | `mainnet` |
| 3 | `CARDANO_CHAIN_ID` | `_CARDANO_CHAIN_ID` | `900000000001` | `900000000001` | `900764824073` |
| 4 | `CARDANO_PROVIDER_URL` | `_CARDANO_PROVIDER_URL` | `https://preprod.koios.rest/api/v1` | `https://preprod.koios.rest/api/v1` | `https://api.koios.rest/api/v1` |
| 5 | `CARDANO_PROVIDER_TIMEOUT_MS` | `_CARDANO_PROVIDER_TIMEOUT_MS` | `20000` | `20000` | `20000` |
| 6 | `CARDANO_TTL_SLOTS` | `_CARDANO_TTL_SLOTS` | `900` | `900` | `900` |
| 7 | `CARDANO_DEPOSIT_CONFIRMATIONS` | `_CARDANO_DEPOSIT_CONFIRMATIONS` | `3` | `3` | `3` |
| 8 | `CARDANO_EXPLORER_URL` | `_CARDANO_EXPLORER_URL` | `https://preprod.cardanoscan.io/transaction/` | `https://preprod.cardanoscan.io/transaction/` | `https://cardanoscan.io/transaction/` |

**Ninguna es secreta.** No hay que tocar Secret Manager ni `availableSecrets`: son URL de provider,
red, timeouts y umbrales. Koios no pide API key y el tier pago no se va a usar, así que no existe una
variable de token.

### 1.1 Variables que no son de Cardano, pero de las que Cardano depende

| Variable | Ya existe | Por qué importa acá |
|---|---|---|
| `SEED_INTERNAL_SALT` | ✅ sí, en los tres ambientes | **Es de lo que deriva cada address.** Sin él la familia queda apagada aunque `CARDANO_ENABLED=true`. Derivar con un salt vacío produciría addresses bien formadas de las que puede gastar cualquiera que sepa el número de teléfono |
| `MONGO_URI` | ✅ sí | De ahí salen el documento de red y el catálogo de tokens de Cardano |

No hay que cambiarles el valor. Están listadas porque **el flag solo no alcanza**: `getCardanoConfig()`
devuelve `enabled: false` con el motivo en `disabledReason` si falta cualquiera de las tres piezas
(flag, provider URL, salt).

---

## 2. Para copiar y pegar

### 2.1 `.env` local (formato del `example_env`)

```bash
CARDANO_ENABLED='false'
CARDANO_NETWORK='preprod'
CARDANO_CHAIN_ID=900000000001
CARDANO_PROVIDER_URL='https://preprod.koios.rest/api/v1'
CARDANO_PROVIDER_TIMEOUT_MS=20000
CARDANO_TTL_SLOTS=900
CARDANO_DEPOSIT_CONFIRMATIONS=3
CARDANO_EXPLORER_URL='https://preprod.cardanoscan.io/transaction/'
```

Ya están en `example_env` con estos mismos valores. Poner `CARDANO_ENABLED='true'` para probar en
local.

### 2.2 Trigger de Cloud Build — dev / test (Preprod)

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

### 2.3 Trigger de Cloud Build — producción (mainnet)

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

**`_CARDANO_ENABLED=false` a propósito en el primer deploy de producción.** Ver §5.

---

## 3. Qué hay que hacer a mano, y qué ya está hecho

Ya está cableado en el repo, verificado en el diff:

| Dónde | Qué |
|---|---|
| `example_env` | las 8, con valores de Preprod y comentarios |
| `Dockerfile` | 8 `ARG` + 8 `ENV CARDANO_X $CARDANO_X` |
| `cloudbuild.yaml`, step `CreateEnv` | 8 líneas `CARDANO_X=${_CARDANO_X}` |
| `cloudbuild.yaml`, step `Build` | 8 `--build-arg=CARDANO_X=${_CARDANO_X}` |

Mismo patrón que `POLYMARKET_*` y `LIFI_*`.

**Lo único que falta hacer a mano es dar de alta las 8 _substitutions_ en el trigger de Cloud
Build**, en cada ambiente. Este `cloudbuild.yaml` no declara bloque `substitutions:`: las toma del
trigger, igual que `_POLYMARKET_ENABLED`.

La cadena completa, para poder debuggear dónde se corta:

```
trigger (_CARDANO_X)  →  cloudbuild CreateEnv (CARDANO_X=${_CARDANO_X})
                      →  cloudbuild Build (--build-arg CARDANO_X=...)
                      →  Dockerfile ARG CARDANO_X → ENV CARDANO_X
                      →  getCardanoConfig() en runtime
```

---

## 4. Qué pasa si falta cada una

`getCardanoConfig()` (`src/config/cardanoConfig.ts`) tiene default para todo. Una substitution que no
se da de alta resuelve a **vacío**, no a error, así que conviene saber qué queda:

| Variable | ¿Obligatoria? | Si falta o está vacía |
|---|---|---|
| `CARDANO_ENABLED` | **sí** | `false` → familia apagada. Default seguro: nada se rompe, pero Cardano no funciona y el motivo no salta en los logs |
| `CARDANO_NETWORK` | **sí en producción** | cae en `testnet`. Ver §4.1 |
| `CARDANO_CHAIN_ID` | recomendada | default según la red (`900000000001` / `900764824073`). Tiene que coincidir con lo sembrado en la base |
| `CARDANO_PROVIDER_URL` | no | default de Koios según la red |
| `CARDANO_PROVIDER_TIMEOUT_MS` | no | `20000`. Un valor no numérico o ≤ 0 también cae al default |
| `CARDANO_TTL_SLOTS` | no | `900` |
| `CARDANO_DEPOSIT_CONFIRMATIONS` | no | `3` |
| `CARDANO_EXPLORER_URL` | no | default de Cardanoscan según la red |

`CARDANO_ENABLED` se lee sin distinguir mayúsculas: `true`, `TRUE` y `True` valen lo mismo. Cualquier
otra cosa —`1`, `yes`, vacío— es `false`.

### 4.1 `CARDANO_NETWORK`: cómo se interpreta

**Las mayúsculas y los espacios no importan.** Estos valores son todos equivalentes:

| Se escribe | Resuelve a |
|---|---|
| `mainnet`, `Mainnet`, `MAINNET`, `MainNet`, `  mainnet  ` | **mainnet** |
| `preprod`, `Preprod`, `PREPROD`, `testnet`, `TestNet` | **testnet** |
| ausente, vacío, sólo espacios | **testnet** (o sea: "no configurado") |
| cualquier otra cosa (`mainet`, `prod`, `preview`…) | ⛔ **la familia queda apagada** |

Las dos últimas filas son distintas a propósito:

- **Ausente o vacío es "no configurado"**, y testnet es el default seguro para eso. Es también lo que
  pasa con una substitution que no se dio de alta en el trigger.
- **Un valor puesto y no reconocido es un error de tipeo**, y se refuza en vez de defaultear.
  `mainet` no es un pedido de testnet. `getCardanoConfig()` devuelve `enabled: false` con
  `disabledReason` nombrando el valor recibido y las opciones válidas, así que aparece en la
  respuesta de la API y en los logs en vez de quedar en silencio.

> ⚠️ **Por qué esto importa tanto.** `CARDANO_NETWORK` decide el header byte de cada address que se
> emite (CIP-19). Un deployment de producción que la lea como testnet emitiría **addresses de
> testnet**: perfectamente bien formadas, y de las que nadie puede gastar en mainnet. Ningún chequeo
> posterior lo detecta — por eso la verificación de §6 mira **el prefijo de la address emitida**, no
> la variable.
>
> Cubierto por `test/config/cardanoConfig.test.ts`.

---

## 5. Orden de deploy

1. Aplicar los [cambios de base de datos](./2026-08-16-cardano-config-entornos.md) — schema, seeds e
   índices.
2. Dar de alta las 8 substitutions en el trigger, **con `_CARDANO_ENABLED=false`**.
3. Deployar. Nada cambia de comportamiento: la familia está apagada.
4. Verificar que el servicio levanta y que las transferencias EVM siguen normales.
5. Recién ahí poner `_CARDANO_ENABLED=true` y volver a deployar.

Separar los pasos 3 y 5 es lo que permite distinguir "el deploy rompió algo" de "Cardano rompió
algo". Si van juntos, una regresión tiene dos causas candidatas.

---

## 6. Cómo verificar que quedó bien

```bash
# 1. Con CARDANO_ENABLED=false, un transfer de ADA responde 200 con el motivo explícito:
#    "Cardano is not available right now (CARDANO_ENABLED is not true)"
#    Con true, responde el mensaje de operación en curso.

# 2. La red correcta: pedir la wallet de un usuario y mirar el prefijo de la address de Cardano.
#    mainnet -> addr1q...    Preprod -> addr_test1q...
#    Un addr_test1 en producción es CARDANO_NETWORK mal configurada.

# 3. La familia responde: una address bech32 devuelve la forma de balance habitual.
curl -H "Origin: https://<dominio>" "https://<host>/balance/addr1q..."
```

```js
// 4. El chain id del runtime coincide con el de la base
db.blockchains.findOne({ chainId: 900764824073 })   // prod
db.blockchains.findOne({ chainId: 900000000001 })   // dev/test
```

---

## 7. Qué hace cada una, y por qué el valor es ése

**`CARDANO_ENABLED`** — interruptor de la familia. En `false`, el backend se comporta exactamente
como hoy. No alcanza por sí solo: la familia también exige `SEED_INTERNAL_SALT` y un provider URL, y
si falta alguno queda apagada con el motivo explícito en `disabledReason`. Media configuración es
peor que ninguna — un transfer que llega a construirse y después no puede enviarse ya consumió el
lock de operación del usuario y una notificación.

**`CARDANO_NETWORK`** — `preprod` o `mainnet`, sin importar mayúsculas. **Decide el header byte de
cada address que se emite** (CIP-19). Ver §4.1.

**`CARDANO_CHAIN_ID`** — id interno, no EIP-155 (`9e11 + network magic`; magic de Preprod = 1, de
mainnet = 764824073). No colisiona con EIP-155 (< 1e9) ni con los ids sintéticos de Li.Fi (Bitcoin
2e13, Solana 1.15e15). **Queda congelado una vez que se escribe cualquier dato**: una wallet, una
transacción o un token que lo lleve es una fila que nadie puede reinterpretar después. Tiene que
coincidir con lo que se sembró en la base.

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

## 8. Rollback

Poner `_CARDANO_ENABLED=false` y deployar. El resto de las variables puede quedarse: sin el flag no
se lee ninguna. No hace falta revertir la base — todo lo que se agregó ahí es opcional o aditivo.
