# Cardano: configuración de base y entorno, por ambiente

**Fecha:** 2026-08-16
**Motivo:** dejar en un solo lugar todo lo que hay que cargar a mano para Cardano, en dev/test
(Preprod) y en producción (mainnet)
**Relacionado:** [DB Preprod](./2026-08-16-cardano-preprod.md) · [variables de entorno](./2026-08-16-cardano-env-vars.md) · [chatizalo](./2026-08-16-cardano-chatizalo.md)

Este archivo es la **referencia copiable**: los documentos exactos de `blockchains` y `tokens`, las
variables de entorno y los comandos, para los dos ambientes. Los otros dos archivos cuentan el
*porqué* de cada decisión; acá está el *qué* hay que pegar.

## Estado

| Ambiente | Red | Base backend | Estado |
|---|---|---|---|
| dev / test | Cardano Preprod | `chatterpay-dev` | ✅ aplicado en local (2026-08-16) |
| dev / test (GCP) | Cardano Preprod | base de dev | ⛔ **no aplicado** |
| producción | Cardano mainnet | base de prod | ⛔ **no aplicado** |

> **Orden obligatorio, en cualquier ambiente:** código con los cambios de schema → índices →
> `blockchains` → `tokens` → recién ahí `CARDANO_ENABLED=true`. Media configuración es peor que
> ninguna: un transfer que llega a construirse y después no puede enviarse ya consumió el lock de
> operación del usuario y una notificación.

---

# Parte 1 — dev / test (Cardano Preprod)

## 1.1 `blockchains` — 1 documento

```json
{
  "chainId": 900000000001,
  "name": "Cardano Preprod",
  "family": "cardano",
  "environment": "TEST",
  "explorer": "https://preprod.cardanoscan.io/transaction/",
  "logo": "https://cryptofonts.com/img/SVG/ada.svg",
  "cardano": {
    "network": "testnet",
    "providerUrl": "https://preprod.koios.rest/api/v1",
    "ttlSlots": 900,
    "depositConfirmations": 3
  },
  "limits": {
    "transfer": { "L1": { "D": 14 }, "L2": { "D": 100 } }
  }
}
```

`limits.transfer[nivel].D` es **cantidad diaria de operaciones**, no un monto — la misma forma que
usan las filas EVM. Con cualquier otra clave el límite no falla: `userReachedOperationLimit` lee
`['D']`, obtiene `undefined`, y `count >= undefined` es siempre `false`. **El límite deja de
aplicarse en silencio.**

> El seed escribe `logo: ''`. Si querés el ícono de ADA en el dashboard, actualizalo a mano después
> de correrlo (la URL de arriba responde 200 y es la misma familia de íconos que usan Scroll y
> Arbitrum).

## 1.2 `tokens` — 1 documento (ADA)

```json
{
  "address": "cardano:testnet:lovelace",
  "chain_id": 900000000001,
  "name": "Cardano ADA",
  "symbol": "ADA",
  "display_symbol": "ADA",
  "decimals": 6,
  "display_decimals": 2,
  "type": "variable",
  "ramp_enabled": false,
  "logo": "https://cryptofonts.com/img/SVG/ada.svg",
  "operations_limits": {
    "transfer": { "L1": { "min": 1, "max": 100 }, "L2": { "min": 1, "max": 500 } },
    "swap":     { "L1": { "min": 0, "max": 0 },   "L2": { "min": 0, "max": 0 } }
  }
}
```

> **Corrección respecto de [2026-08-16-cardano-preprod.md](./2026-08-16-cardano-preprod.md) §2:** ahí
> el documento figura con `"type": "native"`. Lo que el seed escribe —y lo que quedó en
> `chatterpay-dev`— es **`"type": "variable"`**, y es lo correcto: `type` es `stable` | `variable` y
> alimenta el pricing (`swapService` decide slippage con `type === 'stable'`). ADA es volátil.

`address` es un centinela, no un contrato: ADA no tiene minting policy, pero `tokens.address` es
`unique`. Todo lo demás del catálogo de Cardano lleva un *unit* real (`policyId + assetNameHex`), y
el prefijo `cardano:` es lo que separa las dos cosas.

## 1.3 Native assets en Preprod

**No hay ninguno para dar de alta.** USDCx, USDM y USDA son activos de **mainnet**: en Preprod no
existen. Si se quiere ejercitar el camino de CNT contra la red real antes de producción, hay que
mintear un asset propio en Preprod y registrarlo con `cardano-add-token.ts` usando su policy id.

Mientras tanto, el camino de tokens está cubierto por tests (`test/services/cardano/`) y por el
fake provider (`test/helpers/fakeCardanoProvider.ts`), no por la red.

## 1.4 Variables de entorno — dev / test

Las 8 substitutions, sus valores y qué pasa si falta cada una viven en un solo lugar:
**[variables de entorno §1 y §2.2](./2026-08-16-cardano-env-vars.md)**. No se repiten acá para que no
haya dos fuentes que puedan divergir.

En resumen: `_CARDANO_ENABLED=true`, `_CARDANO_NETWORK=preprod`, `_CARDANO_CHAIN_ID=900000000001`, y
el provider y el explorer apuntando a Preprod. Ninguna es secreta. La familia **además** exige
`SEED_INTERNAL_SALT`, que ya existe.

## 1.5 Comandos — dev / test

```bash
# dry-run primero, siempre
MONGO_URI='mongodb://<host>:27017/<base-dev>' \
CARDANO_NETWORK=preprod \
  bun run scripts/cardano-seed-db.ts --dry-run

MONGO_URI='mongodb://<host>:27017/<base-dev>' \
CARDANO_NETWORK=preprod \
  bun run scripts/cardano-seed-db.ts
```

El script es idempotente: una segunda corrida no toca nada. `--force` sobrescribe.

---

# Parte 2 — producción (Cardano mainnet)

## 2.1 `blockchains` — 1 documento

```json
{
  "chainId": 900764824073,
  "name": "Cardano",
  "family": "cardano",
  "environment": "PROD",
  "explorer": "https://cardanoscan.io/transaction/",
  "logo": "https://cryptofonts.com/img/SVG/ada.svg",
  "cardano": {
    "network": "mainnet",
    "providerUrl": "https://api.koios.rest/api/v1",
    "ttlSlots": 900,
    "depositConfirmations": 3
  },
  "limits": {
    "transfer": { "L1": { "D": 14 }, "L2": { "D": 100 } }
  }
}
```

`chainId = 900764824073` es `9e11 + network magic` (magic de mainnet = 764824073). **Queda congelado
apenas se escribe el primer dato**: una wallet, una transacción o un token que lo lleve es una fila
que nadie puede reinterpretar después. Tiene que coincidir exactamente con `_CARDANO_CHAIN_ID`.

`limits.transfer` arriba está copiado de dev. **Es política de producto y hay que decidirlo antes del
go-live**, no heredarlo.

## 2.2 `tokens` — ADA

```json
{
  "address": "cardano:mainnet:lovelace",
  "chain_id": 900764824073,
  "name": "Cardano ADA",
  "symbol": "ADA",
  "display_symbol": "ADA",
  "decimals": 6,
  "display_decimals": 2,
  "type": "variable",
  "ramp_enabled": false,
  "logo": "https://cryptofonts.com/img/SVG/ada.svg",
  "operations_limits": {
    "transfer": { "L1": { "min": 1, "max": 100 }, "L2": { "min": 1, "max": 500 } },
    "swap":     { "L1": { "min": 0, "max": 0 },   "L2": { "min": 0, "max": 0 } }
  }
}
```

`transfer.min = 1` no es arbitrario: el min-ADA de un output en mainnet ronda 0.86 ADA
(`coinsPerUtxoByte = 4310`). Por debajo de ese piso el ledger no rechaza el pago: rechaza **la
transacción entera**. 1 ADA deja margen.

## 2.3 `tokens` — stablecoins canónicas de mainnet

Los tres valores de abajo están **verificados contra el Cardano Token Registry** (consultado vía
Koios el 2026-08-16, endpoint `asset_token_registry`), con el fingerprint CIP-14 como cruce
independiente. Cada uno se puede volver a chequear en `https://cardanoscan.io/token/<unit>`.

| Ticker | Emisor | Policy id | Asset name (hex) | Decimales | Fingerprint | Supply verificado |
|---|---|---|---|---|---|---|
| **USDCx** | Circle / xReserve | `1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34` | `5553444378` | 6 | `asset1e7eewpjw8ua3f2gpfx7y34ww9vjl63hayn80kl` | ~44.0 M |
| **USDM** | Moneta | `c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad` | `0014df105553444d` | 6 | `asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed` | ~9.6 M |
| **USDA** | Anzens (Emurgo) | `fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456` | `55534441` | 6 | `asset16fq594uun90f2jajmecjcdt4jnsnq7r3jdqsw5` | ~4.45 M |

Los `address` que quedan en la colección (policy id + asset name, en minúsculas — es la "unit", como
la nombran Koios y Blockfrost, y es contra ese string que `cardanoBalanceService` matchea el UTxO):

```
USDCx  1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378
USDM   c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d
USDA   fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae45655534441
```

> ⚠️ **USDM no se puede dar de alta con `--asset-name-ascii USDM`.** Su asset name es
> `0014df105553444d`: los primeros 4 bytes son la etiqueta CIP-67 `333` (token fungible de un par
> CIP-68), y recién después viene `5553444d` = `"USDM"`. El ejemplo de la cabecera de
> `scripts/cardano-add-token.ts` usa `--asset-name-ascii USDM` y **produciría una unit inexistente**.
> Va con `--asset-name` (hex), como en los comandos de §2.5.
>
> Es exactamente el modo de falla que el script existe para evitar: una unit equivocada no da error,
> da un balance que siempre lee 0 y una transferencia que nunca encuentra el activo.

### Qué es cada una

- **USDCx** — emitida por Circle sobre Cardano vía xReserve, redimible 1:1 por USDC nativo. Es la
  representación canónica de USDC en Cardano. Si el producto quiere mostrar "USDC" al usuario, el
  camino es `display_symbol: "USDC"` con `symbol: "USDCx"` — ver la advertencia de §2.4.
- **USDM** — stablecoin nativa respaldada por fiat, de Moneta (moneta.global).
- **USDA** — stablecoin respaldada por fiat de Anzens, la empresa de Emurgo (anzens.com).

### USDT en Cardano: existe, pero no como uno espera

**No hay USDT emitida por Tether en Cardano** — no hay contrato nativo ni despliegue de USDT0 (la
USDT omnichain de Tether/LayerZero) en esa cadena. Lo que sí existe son **tokens de mapeo de
puentes**, y sólo uno está vivo:

| Lo que figura | Policy id + asset name | Decimales | Supply real |
|---|---|---|---|
| **USDT (Wanchain)** ✅ vivo | `25c5de5f…428ff935` + `55534454` | **8** | ~99.292 USDT |
| "USDT on Arbitrum One" (Wanchain) | `d0c7fa0d…0be56ab` + *(vacío)* | 6 | **0** |
| "USDT on Polygon PoS" (Wanchain) | `78e0032a…fe78b086` + *(vacío)* | 6 | **0** |
| "USDT bridged by Multichain" | `986f0548…5a7f4b7` + `55534454` | 6 | 80.220 — **Multichain caído desde 2023** |
| "USDT (Nomad)" / madUSDT | `25ff9715…b57e4713` + `55534454` | 6 | puente hackeado en 2022 |
| CUSDT / dUSDT | varios | 6 / 8 | ~2.100 / ~1.495 — emisores no identificados |
| qUSDT | `7a4d45e6…97c4eeec` | 8 | recibo de depósito de Liqwid, **no es una stablecoin** |

El único candidato real, con sus datos verificados:

```
USDT (Wanchain)
  policy id   25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff935
  asset name  55534454            ("USDT")
  unit        25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff93555534454
  decimales   8                    <-- NO 6
  fingerprint asset1yd4qrkavvvmwnptkh73ds9v8jrvm7ghjvjjp89
  registry    name "USDT", ticker VACÍO, "The Mapping token of USDT by WanChain"
  supply      ~99.292 USDT
```

El mismo policy id emite también la USDC de Wanchain (`55534443`, 8 decimales, ~475.012 USDC), que
es la que usa el mercado de Liqwid.

> ⚠️ **Tres cosas que hacen a esto una decisión de producto y no un renglón más en la tabla.**
>
> 1. **8 decimales, no 6.** Todas las demás stablecoins de la lista tienen 6. Cargarla con
>    `decimals: 6` no da error: multiplica cada monto por 100 en silencio.
> 2. **~99 mil USDT de supply total en toda la cadena.** USDCx tiene 44 M. La liquidez es de otro
>    orden de magnitud, y un usuario que quiera salir puede no encontrar contraparte.
> 3. **Riesgo de puente, no riesgo de emisor.** No es un pasivo de Tether: es un pasivo de Wanchain
>    contra USDT bloqueada en otra cadena. Las otras cuatro filas de la tabla son exactamente lo que
>    pasa cuando ese riesgo se materializa.
>
> Si se decide listarla igual, va con `symbol: "USDT"` sólo si **no existe un USDT en la red EVM
> activa** — si existe, el backend deja la transferencia en EVM (regla 3 de `isCardanoTransferRequest`)
> y el usuario nunca llega a Cardano. En ese caso el ticker tiene que ser otro, p. ej. `USDTw`.

**Recomendación: no listarla en el V1.** USDCx cubre el caso de uso "dólar en Cardano" con 440× más
liquidez, respaldo de Circle y 6 decimales como todo el resto del catálogo.

**iUSD (Indigo) y DJED también quedaron afuera:** son stablecoins sobrecolateralizadas /
algorítmicas, no respaldadas por fiat. Distinta clase de riesgo, y el producto hoy trata todos los
`type: "stable"` como si valieran 1 USD.

## 2.4 Prerrequisitos de código antes de listar las stablecoins

Dos cosas que hay que resolver **antes** de que estos tokens aparezcan en producción:

1. **El precio va a dar 0.** `getTokenPrices` (`src/services/balanceService.ts:142`) tiene una lista
   fija de stables que valen 1 (`USDC`, `USDT`, `DAI`, `USDQ`, `USX`, …) y para el resto consulta
   Binance (`<SYMBOL>USDT`). No existen los pares `USDCXUSDT`, `USDMUSDT` ni `USDAUSDT`. El fallback
   a DefiLlama necesita el mapa `tokenAddresses`, y el camino de Cardano llama
   `getTokenPrices(catalogue)` **sin** ese mapa (`balanceController.ts`, `cardanoBalanceService.ts`).
   Resultado: balance en 0 USD.

   Arreglo: agregar `USDCX`, `USDM` y `USDA` al `Set` `STABLES`. Es una línea, pero es un cambio de
   código y va en el mismo deploy.

2. **`display_symbol` vs `symbol`.** La resolución de una transferencia se hace por `symbol`
   (`isCardanoTransferRequest`, `userWithinTokenOperationLimits`), y el script rechaza dos tickers
   iguales en la misma red. Si se quiere que el usuario vea "USDC", va en `display_symbol`; `symbol`
   tiene que seguir siendo `USDCx`, o el bot y el catálogo dejan de coincidir.

3. **Una transferencia de CNT también mueve ADA.** Cardano exige min-ADA en todo output que lleve un
   native asset: ~1.2–1.4 ADA se van con el pago, además del fee. Un usuario con USDM y **sin ADA**
   no puede transferir. Vale la pena que la notificación de fondos insuficientes lo diga.

## 2.5 Variables de entorno — producción

Valores completos en **[variables de entorno §1 y §2.3](./2026-08-16-cardano-env-vars.md)**.

Los tres que cambian respecto de dev: `_CARDANO_NETWORK=mainnet`,
`_CARDANO_CHAIN_ID=900764824073`, y el provider/explorer de mainnet. Y uno que **no** es el de dev:

**`_CARDANO_ENABLED=false` en el primer deploy, a propósito.** Se dan de alta las 8, se deploya con
la familia apagada, se verifica que el servicio levanta y que EVM sigue normal, y recién ahí se pone
`true` en un deploy aparte. Separar los dos pasos es lo que permite distinguir "el deploy rompió
algo" de "Cardano rompió algo"; juntos, una regresión tiene dos causas candidatas.

> ⚠️ **`CARDANO_NETWORK` decide el header byte de cada address emitida.** Las mayúsculas no importan
> (`Mainnet` vale), y un valor no reconocido apaga la familia con el motivo explícito en vez de
> defaultear en silencio. Pero una substitution que **no se dio de alta** llega vacía, y eso sí
> resuelve a `testnet`: un deployment de producción emitiría addresses de testnet, bien formadas y de
> las que nadie puede gastar. Detalle en
> [env-vars §4.1](./2026-08-16-cardano-env-vars.md).

## 2.6 Comandos — producción

```bash
export MONGO_URI='mongodb+srv://.../<base-prod>'
export CARDANO_NETWORK=mainnet

# 1. red + ADA + índices (dry-run primero)
bun run scripts/cardano-seed-db.ts --dry-run
bun run scripts/cardano-seed-db.ts

# 2. las tres stablecoins, una por una.
#    OJO: --asset-name es HEX. USDM NO va con --asset-name-ascii (ver §2.3).
bun run scripts/cardano-add-token.ts \
  --symbol USDCx \
  --policy-id 1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34 \
  --asset-name 5553444378 \
  --decimals 6 --token-type stable --min 1 --max 1000 --dry-run

bun run scripts/cardano-add-token.ts \
  --symbol USDM \
  --policy-id c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad \
  --asset-name 0014df105553444d \
  --decimals 6 --token-type stable --min 1 --max 1000 --dry-run

bun run scripts/cardano-add-token.ts \
  --symbol USDA \
  --policy-id fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456 \
  --asset-name 55534441 \
  --decimals 6 --token-type stable --min 1 --max 1000 --dry-run

# 3. repetir los tres sin --dry-run
```

El script imprime la unit y el link de Cardanoscan antes de escribir. **Abrirlo y confirmar que el
token que muestra es el que se quiere listar** — es el único control que queda entre un policy id
mal copiado y una transferencia válida del activo equivocado.

## 2.7 Verificación

```js
// Red
db.blockchains.findOne({ chainId: 900764824073 })

// Los 4 tokens de Cardano y nada más
db.tokens.find({ chain_id: 900764824073 }, { symbol: 1, address: 1, decimals: 1, type: 1, _id: 0 })
// -> ADA    cardano:mainnet:lovelace                    6  variable
//    USDCx  1f3aec…5553444378                           6  stable
//    USDM   c48cbb…0014df105553444d                     6  stable
//    USDA   fe7c78…55534441                             6  stable

// Índices
db.users.getIndexes()   // -> _id_, wallets_proxy, wallets_chain_proxy

// Ningún documento EVM cambió
db.blockchains.countDocuments()
db.tokens.countDocuments()
```

Y contra la red, con la familia ya encendida:

```bash
# Un balance de una address bech32 de mainnet devuelve la forma habitual
curl -H "Origin: https://<dominio>" "https://<host>/balance/addr1..."
```

## 2.8 Rollback

```js
db.tokens.deleteMany({ chain_id: 900764824073 })
db.blockchains.deleteOne({ chainId: 900764824073 })
db.users.dropIndex('wallets_proxy')
db.users.dropIndex('wallets_chain_proxy')
```

Antes de eso, lo barato: `_CARDANO_ENABLED=false` y deployar. Sin el flag no se lee nada de esto.

**Las wallets de Cardano en `users.wallets[]` no necesitan rollback**: las addresses se derivan
determinísticamente del teléfono, así que borrarlas y volver a derivarlas da el mismo resultado. No
hay estado que perder.

---

# Parte 3 — wallets de usuarios existentes, y qué cuesta

**No hace falta backfill, y no cuesta nada.** La address de Cardano es una función pura del teléfono
(`SEED_INTERNAL_SALT` → clave Ed25519 → hash blake2b-224 → bech32, CIP-19): existe y puede recibir
fondos antes de que se escriba nada, en ningún lado. Los usuarios existentes la obtienen sola, por
tres caminos distintos:

| Camino | Qué hace | ¿Escribe en `users.wallets[]`? |
|---|---|---|
| `POST /create_wallet` ("¿cuál es mi wallet?") | `provisionCardanoWallet` → `ensureCardanoWalletForUser` | ✅ sí, si falta |
| `POST /make_transaction` (emisor) | `ensureCardanoWalletForUser(fromUser)` | ✅ sí, si falta |
| `POST /make_transaction` (destinatario por teléfono) | `getOrCreateCardanoWallet` — **crea el usuario** si el teléfono no está registrado, con wallet de Cardano **y sin wallet EVM** | ✅ sí |
| `GET /balance…` | `deriveCardanoAccount` — deriva y muestra | ❌ **no escribe** |

Todo es idempotente: la derivación es la fuente de verdad y la base es un caché de ella. Si la fila
guardada no coincide con lo que las claves derivan, el código **corta** con
`CARDANO_ADDRESS_MISMATCH` en vez de seguir — significaría que la semilla cambió y que los fondos
están en una address que este deployment no puede firmar.

**Costo para ChatterPay: cero on-chain.** No hay deploy de contrato, no hay registro de cuenta, no
hay gas, no hay depósito mínimo ni rent. Una address de Cardano no necesita existir en la cadena para
recibir: aparece cuando le llega el primer UTxO. El costo total de provisionar es **una escritura en
Mongo**.

Es la diferencia con el lado EVM, donde la address es contrafáctica pero el proxy ERC-4337 se
despliega en la primera operación (gas que absorbe el paymaster) y además se registra en Alchemy.

Tres consecuencias que conviene tener presentes:

- **Un destinatario que nunca usó Cardano igual tiene address**, así que transferir a un teléfono
  funciona la primera vez sin pedirle nada. Pero si ese teléfono no era usuario, queda creado un
  `users` **sin wallet EVM** — no pasa por `createUserWithWallet` a propósito, para no darle de alta
  una cuenta en una red que nunca pidió. Ese usuario tiene que llamar `create_wallet` para tener la
  parte EVM.
- **La address es base (tipo 0), con la stake credential sin registrar:** hoy no delega ni cobra
  rewards, pero habilitarlo después es una transacción y no una migración. Ver §3.1.
- **El pedido de balance no persiste nada.** Si a alguien le hace falta que la fila exista (por
  ejemplo para un query por `wallets.wallet_proxy`), el disparador es `create_wallet` o una
  transferencia, no el balance.

## 3.1 Addresses base con stake credential sin registrar

Una address de Cardano no es el hash de una clave con un prefijo pegado: es un **byte de cabecera**
que dice *qué tipo de address es y de qué red*, seguido de una o dos credenciales, todo en bech32
(CIP-19). Las dos credenciales son cosas distintas:

- **payment credential** — quién puede gastar;
- **stake credential** — a qué cuenta de staking suma ese saldo.

| Tipo | Forma | Contiene | Largo aprox. |
|---|---|---|---|
| **0** | **base**, `addr1q…` | payment + stake | ~103 chars |
| 1–3 | base con scripts | variantes | ~103 chars |
| 6 | enterprise, `addr1v…` | sólo payment | ~58 chars |
| 4–5 | pointer | deprecadas en Conway | — |

**ChatterPay emite tipo 0** (`BASE_KEY_HASH_TYPE` en `cardanoAddressService.ts`), con la stake
credential **escrita en la address y registrada en ninguna parte**. Lo único que cambia entre Preprod
y mainnet es el nibble bajo del header (`0` / `1`) y el HRP (`addr_test` / `addr`): el tipo de
address es el mismo en las dos redes.

### Por qué base y no enterprise

Una address base con la stake key sin registrar **se comporta exactamente igual que una enterprise**:
recibe, gasta y maneja native assets sin diferencia. No hay certificado, ni depósito, ni delegación,
ni costo — la credencial simplemente está ahí, sin usar.

La diferencia aparece el día que se quiera staking: con base, registrar y delegar es **una
transacción**; con enterprise, es **otra address**, o sea mover los fondos de todos los usuarios.
Esa migración sólo se pone más cara con cada wallet fondeada, y el costo de evitarla hoy es
básicamente cero.

> **Decisión tomada el 2026-08-17** (implementada en este mismo cambio): base, con **una stake key
> por usuario** — no una compartida por todo ChatterPay. Una credencial única para todos habría
> costado un solo depósito de 2 ADA en total, pero deja **todas las wallets del producto agrupadas y
> enumerables on-chain** por esa credencial compartida, y obliga a repartir los rewards del agregado
> por contabilidad off-chain. Con una por usuario, la address sigue siendo función pura de las claves
> de ese usuario y las wallets no quedan vinculadas entre sí.

### Qué cambió en el código

| Archivo | Cambio |
|---|---|
| `cardanoAddressService.ts` | `baseAddress(payment, stake, network)` — tipo 0. `enterpriseAddress` queda, ya no se emite. `decodeCardanoAddress` ahora devuelve `stakeCredentialHex` |
| `cardanoSignerService.ts` | segunda derivación HKDF con `info = 'ed25519:stake:v1:<chainId>'`. La payment key **no cambió** (`ed25519:v1:<chainId>`) |
| `cardanoType.ts` | `CardanoAccount.stakePublicKey`, `DecodedCardanoAddress.stakeCredentialHex` |
| `userModel.ts` | `address_type: 'evm_aa' \| 'cardano_base'`, nuevo `cardano_stake_public_key` |
| `cardanoWalletService.ts` | la entrada de `wallets[]` guarda ambas claves |

**La stake key no firma nada.** Una transferencia se autoriza con la payment key sola; la de staking
existe porque va *dentro de la address*, que es lo único que no se puede cambiar después sin mover la
plata de todos.

**Migración: ninguna.** Se verificó antes de tocar el código —`users` con wallet de Cardano: **0**;
transacciones en la red de Cardano: **0**— así que no hay una sola address emitida que haya que
sostener. Por eso se hizo ahora y no después.

**El costo real de emitir base:** la address pasa de 29 a 57 bytes, y el min-ADA de cada output sube
en proporción (`(overhead + bytes) × coinsPerUtxoByte`, con `coinsPerUtxoByte = 4310`): unos **+0,12
ADA por UTxO**. Con ADA a USD 0,177 son ~2 centavos. El builder ya calcula el min-ADA dinámicamente,
así que no hubo que tocar nada ahí.

### Lo que todavía no hace: registrar y delegar

Sigue pendiente, y ahora es una decisión de producto que se puede tomar cuando se quiera:

- **2 ADA por usuario de depósito** (`key_deposit = 2000000` lovelace, verificado contra los
  parámetros de la época 649), **reembolsables** al des-registrar → ~USD 0,35 inmovilizados por
  usuario.
- **~0,2 ADA de fee por usuario**, no reembolsables → ~USD 0,04.
- Los rewards empiezan a las ~2 épocas (~10 días) y se acreditan cada 5 días en una cuenta aparte que
  hay que **retirar explícitamente** con otra transacción.
- En la era Conway, para poder retirarlos la stake credential además tiene que estar delegada a un
  **DRep** (alcanza con `abstain`), así que el certificado de delegación va acompañado.
- Código que no existe: armado y firma de certificados (necesita una firma con la stake key, que hoy
  el signer deliberadamente no expone), elección de pool, manejo de épocas y retiro de rewards.

> ⚠️ **Cuando se haga, la pregunta no es cuánto le cuesta a ChatterPay sino de dónde salen esos
> 2 ADA.** El depósito se descuenta del saldo de la wallet: alguien con 10 ADA vería el 20% de su
> plata inmovilizada para ganar centavos. Si los pone ChatterPay son ~USD 0,35 por usuario,
> recuperables. Por eso conviene que sea opt-in, o que dependa de un saldo mínimo.

---

# Parte 4 — bridges: Li.Fi no llega a Cardano

**Li.Fi no soporta Cardano, y no hay configuración ni cambio de código que lo habilite.** Verificado
contra `https://li.quest/v1/chains?chainTypes=EVM,SVM,UTXO` —los mismos parámetros que usa
`getLifiChains` en `src/services/lifi/lifiService.ts:462`—: **73 redes, ninguna es Cardano**. Las
únicas no-EVM son Solana, Bitcoin y Sui. Tampoco aparece en Layerswap (63 redes), que es el partner
al que hoy apunta el CTA de "Depósito rápido".

No es una limitación del backend: la cadena no está en la red de esos agregadores. Agregar un chain
id o un token al catálogo no cambia nada, porque el quote sale de la API de Li.Fi.

**Entonces, hoy:**

- Las transferencias de Cardano son **same-chain**: de una address de Cardano a otra. No hay puente
  entre la wallet EVM del usuario y su wallet de Cardano dentro del producto.
- Para meter fondos, el usuario manda ADA desde afuera **a su address de Cardano, por la red
  Cardano**. Nada de Layerswap para eso.
- El CTA de "Depósito rápido" **no debe ofrecerse** para ADA — el prompt lo prohíbe explícitamente
  ([chatizalo](./2026-08-16-cardano-chatizalo.md) §4.1).

**Si en algún momento se quiere un puente EVM ↔ Cardano**, los que sí operan sobre Cardano son
Wanchain (es de donde vienen la USDC y la USDT bridgeadas de §2.3) y Rosen Bridge. Ninguno de los dos
está integrado, ninguno tiene la forma de API de Li.Fi, y sería una integración nueva y completa —
no un parámetro más en la que ya existe.

---

# Parte 5 — lo que sigue faltando en los dos ambientes

- **Depósitos externos no se detectan.** El ingestor es EVM-only (Alchemy / TheGraph): un usuario que
  reciba ADA desde afuera **no recibe notificación**. Gap declarado, plan §5.8.
- **`deposit_info` no conoce Cardano.** `enviar_opciones_deposito` sigue mostrando sólo la red EVM.
  El único lugar donde hoy aparece la address de Cardano es el template de `wallet_creation` — ver
  [chatizalo](./2026-08-16-cardano-chatizalo.md) §3.
- **El dashboard arma el link del explorer concatenando `/tx/`.** Cardanoscan usa `/transaction/`.
  Cambio propio del dashboard, plan §8.1.
- **Swaps fuera de alcance.** Los `operations_limits.swap` van en cero declarado, no omitidos.
