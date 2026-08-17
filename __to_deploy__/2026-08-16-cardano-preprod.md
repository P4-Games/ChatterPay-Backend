# Cardano Preprod: red, token ADA e índices

**Fecha:** 2026-08-16
**Motivo:** habilitar transferencias de ADA en Cardano Preprod ([plan](../CARDANO_INTEGRATION_PLAN.md) §5)
**Script:** `scripts/cardano-seed-db.ts`

## Entornos

| Entorno | Base | Estado |
|---|---|---|
| local dev | `chatterpay-dev` @ `172.30.64.1:27017` | ✅ aplicado |
| staging | — | ⛔ **no aplicado** |
| producción | — | ⛔ **no aplicado** |

> Los datos existentes no se tocaron: los 2 documentos EVM de `blockchains` (Scroll Sepolia 534351,
> Arbitrum Sepolia 421614), los 13 tokens, los 7 usuarios y las 86 transacciones quedaron intactos.
> Este cambio sólo **agrega**.

---

## 1. Cambios de schema (código)

Sin migración de datos: todo lo agregado es opcional o tiene default, así que los documentos
existentes siguen validando sin tocarlos.

### `src/models/blockchainModel.ts`

- **`family: 'evm' | 'cardano'`**, `required`, **default `'evm'`**. Los documentos escritos antes de
  Cardano no tienen el campo y se leen como EVM, que es lo que son.
- **`cardano?: { network, providerUrl, ttlSlots, depositConfirmations }`**, opcional.
- **14 campos EVM-only pasaron de `required: true` a `required` condicional** por familia
  (`manteca_name`, `rpc`, `rpcBundler`, `marketplaceOpenseaUrl`, `supportsEIP1559`,
  `externalDeposits`, `gas.useFixedValues`, `gas.operations.transfer`, `gas.operations.swap`, los 5
  de `balances.*`, y `limits.swap` / `limits.mint_nft` / `limits.mint_nft_copy`).

  Siguen obligatorios para **todas** las familias: `name`, `chainId`, `explorer`, `environment` y
  `limits.transfer` — los límites de transferencia son política de producto, no un detalle de EVM.

  > La alternativa era rellenar el documento de Cardano con valores dummy (`rpc: ""`, `gas: {…}`).
  > Se descartó: produce una fila que *dice* tener un RPC y un paymaster, y algo eventualmente lo
  > va a creer, lejos de acá.

  Verificado por `test/models/blockchainModel.cardano.test.ts`, que además chequea lo que importa de
  verdad: **que Scroll siga exigiendo los 14 campos**. Aflojar el schema para Cardano sin aflojarlo
  para EVM era el riesgo real.

### `src/models/userModel.ts` — `IUserWallet`

- **`address_type?: 'evm_aa' | 'cardano_enterprise'`**, opcional. Ausente = `evm_aa`.
- **`cardano_public_key?: string`**, opcional. Clave Ed25519 cruda, hex con `0x`.

Las entradas de Cardano llevan la misma address bech32 en `wallet_proxy` **y** en `wallet_eoa`, para
que todos los lectores existentes (bot, dashboard, balance) sigan funcionando sin cambios.

### `src/models/transactionModel.ts`

- **`network_fee?: number`** y **`network_fee_token?: string`**, opcionales.

Distintos de `fee`, que es el fee de ChatterPay cobrado en el token movido. En EVM el paymaster
absorbe el costo de red y el usuario nunca lo ve; en Cardano el emisor lo paga directo de los inputs
de su propia transacción, así que un historial que sólo mostrara `fee` escondería un costo real.

### `src/models/tokenModel.ts` y `blockchainModel.ts` — corrección de forma

Los sub-schemas de límites (`limitDetailSchema`, `operationLimitsSchema` en ambos modelos) pasaron a
`{ _id: false }`.

> **Esto corrige un defecto introducido en la primera corrida de este mismo seed.** Sin `_id: false`,
> Mongoose estampa un ObjectId en cada límite anidado, y el documento de ADA quedó con `_id` en
> `operations_limits.transfer.L1`, `.L2`, etc. **Ningún otro token de la colección los tiene.** Se
> detectó comparando contra el USDC existente, se corrigió el schema y se reescribieron los
> documentos con `--force`. La forma actual coincide con la de los documentos preexistentes.

---

## 2. Documentos insertados

### `blockchains` — 1 documento nuevo

```json
{
  "chainId": 900000000001,
  "name": "Cardano Preprod",
  "family": "cardano",
  "environment": "TEST",
  "explorer": "https://preprod.cardanoscan.io/transaction/",
  "logo": "",
  "cardano": {
    "network": "testnet",
    "providerUrl": "https://preprod.koios.rest/api/v1",
    "ttlSlots": 900,
    "depositConfirmations": 3
  },
  "limits": { "transfer": { "L1": { "D": 14 }, "L2": { "D": 100 } } }
}
```

**Sobre `limits.transfer`:** `D` es la **cantidad diaria de operaciones** por nivel de usuario, no un
monto. Es la misma forma que usan las filas EVM (Scroll tiene exactamente `{"L1":{"D":14},"L2":{"D":100}}`).
Los límites por monto viven en el token, no acá.

> ⚠️ **Segundo defecto corregido en este mismo cambio.** La primera versión del seed escribió
> `{"L1":{"ADA":100},"L2":{"ADA":500}}`, interpretando el campo como un monto. El modo de falla no
> era un error: `userReachedOperationLimit` lee `limits.transfer[nivel]['D']`, que con esa forma da
> `undefined`, y `count >= undefined` es siempre `false` — **el límite diario nunca se habría
> aplicado, en silencio**. Detectado al leer `blockchainService.ts:315-333` para integrar el
> controller; corregido y reescrito con `--force`.

**Sobre `chainId = 900000000001`.** Cardano no tiene chain id EIP-155, pero `chain_id` es numérico en
`users.wallets`, `transactions` y `tokens`. El id es interno: `9e11 + network magic` (magic de
Preprod = 1). No colisiona con EIP-155 (< 1e9) ni con los ids sintéticos de Li.Fi (Bitcoin 2e13,
Solana 1.15e15). Mainnet sería `900764824073`.

> ⚠️ **Este número queda congelado.** Una wallet, una transacción o un token que lo lleve es una fila
> que nadie puede reinterpretar después.

**Sobre el explorer:** termina en `/transaction/`, no en `/tx/`. Cardanoscan usa otra ruta que todos
los exploradores EVM. El dashboard concatena `/tx/` a mano, así que necesita un cambio propio
(plan §8.1).

**Campos EVM ausentes a propósito:** sin `rpc`, sin `rpcBundler`, sin `contracts`, sin `gas`, sin
`balances`, sin `externalDeposits`, sin `manteca_name`, sin `marketplaceOpenseaUrl`, sin
`supportsEIP1559`. Nada de eso existe en Cardano.

### `tokens` — 1 documento nuevo

```json
{
  "address": "cardano:testnet:lovelace",
  "chain_id": 900000000001,
  "name": "Cardano ADA",
  "symbol": "ADA",
  "display_symbol": "ADA",
  "decimals": 6,
  "display_decimals": 2,
  "type": "native",
  "ramp_enabled": false,
  "logo": "",
  "operations_limits": {
    "transfer": { "L1": { "min": 1, "max": 100 }, "L2": { "min": 1, "max": 500 } },
    "swap":     { "L1": { "min": 0, "max": 0 },   "L2": { "min": 0, "max": 0 } }
  }
}
```

**`address` es un centinela, no un contrato.** ADA es la moneda nativa y no tiene dirección de
contrato, pero `tokens.address` es `unique` en el schema. El valor `cardano:testnet:lovelace` ocupa
ese lugar.

> ⚠️ Consecuencia para el código: `isSkippableTokenContractAddress()` en `balanceService` descarta
> direcciones que no son contratos. El camino de balance **tiene que ramificar por `family` antes**
> de llegar a ese filtro, o el saldo de ADA va a dar siempre 0.

**`transfer.min = 1` no es arbitrario:** el min-ADA de un output en Preprod es ~0.85 ADA (medido con
`coinsPerUtxoByte = 4310`). Por debajo de eso el ledger no rechaza el pago, rechaza **la transacción
entera**. El mínimo de 1 ADA deja margen sobre ese piso.

**`swap` en 0:** los swaps están fuera de alcance, pero el schema exige la forma. Declarado en cero
en vez de omitido.

### 2.1 Stablecoins nativas (USDCx, USDM, USDA) — **no incluidas en este seed**

Las tres son native assets de Cardano y el código las soporta, pero **no se dan de alta acá**. Se
registran una por una con un script que exige el policy id explícito:

```bash
MONGO_URI=... bun run scripts/cardano-add-token.ts \
  --symbol USDM --policy-id <56 hex> --asset-name-ascii USDM --decimals 6
```

En la colección quedan con `address` = `policyIdHex + assetNameHex` (la "unit", que es como las
nombran Koios y Blockfrost) y `type: 'native_asset'`.

> ⚠️ **Por qué no están hardcodeadas en el repo.** Un policy id equivocado **no falla**: produce una
> transferencia perfectamente válida de un activo que no es el que el usuario cree estar mandando, y
> nada aguas abajo puede notar la diferencia. Los valores los aporta quien los verificó, cruzando
> tres fuentes: el Cardano Token Registry, la documentación del emisor y Cardanoscan.
>
> El script rechaza de antemano lo que no sea estructuralmente un activo (policy de 56 hex, asset
> name ≤32 bytes) y no permite dos tickers iguales en la misma red, porque la resolución de una
> transferencia se hace justamente por ticker.

**Además:** las tres son activos de **mainnet**. En Preprod no existen, así que validar el camino de
tokens contra la red real necesita un CNT que sí exista ahí.

---

## 3. Índices creados

En `users`, ambos con `background: true`:

```js
db.users.createIndex({ 'wallets.wallet_proxy': 1 }, { name: 'wallets_proxy', background: true })
db.users.createIndex({ 'wallets.chain_id': 1, 'wallets.wallet_proxy': 1 },
                     { name: 'wallets_chain_proxy', background: true })
```

`users` no tenía **ningún** índice sobre `wallets`. Con Cardano cada usuario pasa a tener 2+ entradas
en el array y las consultas por wallet se vuelven más caras.

> Deuda anotada, no resuelta acá: `mongoUserService.ts:438` consulta con
> `{ $regex: new RegExp('^' + address + '$', 'i') }`. Un `$regex` case-insensitive **no usa el
> índice**, así que ese query sigue escaneando. Para bech32 el case-insensitive además es innecesario
> (el case canónico es minúsculas y una address mixed-case es inválida por definición). Y la address
> se interpola cruda en el `RegExp`: con direcciones EVM no hay metacaracteres posibles, pero con
> otras familias conviene escapar. Ninguna de las dos cosas la introdujo Cardano.

---

## 4. Cómo aplicarlo en otro entorno

```bash
# 1. Deployar el código con los cambios de schema (§1). Sin esto, el paso 2 escribe
#    documentos que el modelo no valida.
# 2. Correr el seed en seco y revisar la salida:
MONGO_URI='mongodb://<host>:27017/<base>' \
CARDANO_ENABLED=true CARDANO_NETWORK=preprod \
  bun run scripts/cardano-seed-db.ts --dry-run

# 3. Aplicar:
MONGO_URI='...' CARDANO_ENABLED=true CARDANO_NETWORK=preprod \
  bun run scripts/cardano-seed-db.ts

# 4. Recién entonces habilitar el flag en el runtime: CARDANO_ENABLED=true
```

El script es **idempotente**: una segunda corrida no toca nada (4 `skip`). `--force` sobrescribe los
documentos existentes, y es la única forma de pisar límites o `providerUrl` ajustados a mano.

**Orden obligatorio:** schema → índices → `blockchains` → `tokens` → flag. El script hace los tres
del medio en ese orden.

### Nota de entorno: WSL

MongoDB corriendo en el host Windows **no es alcanzable en `127.0.0.1` desde WSL** (da
`ECONNREFUSED`). Hay que usar la IP del host:

```bash
ip route show default          # -> default via 172.30.64.1
MONGO_URI='mongodb://172.30.64.1:27017/chatterpay-dev'
```

Esa IP **cambia cuando se reinicia WSL**. El `MONGO_URI` del `.env` apunta a `localhost` y no fue
modificado: los scripts toman `MONGO_URI` por variable de entorno.

---

## 5. Verificación

```js
// La red quedó, y las EVM siguen intactas
db.blockchains.find({}, { chainId: 1, name: 1, family: 1 })
// -> 534351 Scroll Sepolia (sin family)
//    421614 Arbitrum Sepolia (sin family)
//    900000000001 Cardano Preprod family=cardano

// El token ADA
db.tokens.findOne({ address: 'cardano:testnet:lovelace' })

// Los índices
db.users.getIndexes()   // -> _id_, wallets_proxy, wallets_chain_proxy

// Ningún documento existente cambió
db.blockchains.countDocuments()   // 3 (era 2)
db.tokens.countDocuments()        // 14 (era 13)
db.users.countDocuments()         // 7 (sin cambios)
db.transactions.countDocuments()  // 86 (sin cambios)
```

Suite relacionada: `bunx vitest run test/models/blockchainModel.cardano.test.ts` (6 tests).

---

## 6. Rollback

Los tres cambios de datos son reversibles y no hay pérdida de información:

```js
db.blockchains.deleteOne({ chainId: 900000000001 })
db.tokens.deleteOne({ address: 'cardano:testnet:lovelace' })
db.users.dropIndex('wallets_proxy')
db.users.dropIndex('wallets_chain_proxy')
```

Los cambios de schema (§1) no necesitan rollback de datos: todo lo agregado es opcional o tiene
default, así que revertir el código deja los documentos existentes válidos.

**Las wallets de Cardano en `users.wallets[]` tampoco necesitan rollback**, cuando existan: las
addresses se derivan determinísticamente del teléfono, así que borrar las entradas y volver a
derivarlas da exactamente el mismo resultado. No hay estado que perder — es la razón de fondo por la
que la derivación es determinística.

---

## 7. Lo que este cambio **no** hace

- **No crea wallets de Cardano para los usuarios existentes.** El backfill
  (`cardano-backfill-wallets.ts`) todavía no está escrito; falta decidir si se derivan para todos o
  sólo bajo demanda (plan §12.3).
- **No habilita nada en runtime.** Sin `CARDANO_ENABLED=true` el subsistema queda apagado y el
  comportamiento actual no cambia.
- **No toca `external_deposits`.** El ingestor de depósitos es EVM-only (Alchemy / TheGraph), así que
  un usuario que reciba ADA desde afuera no va a recibir notificación. Gap declarado, plan §5.8.
- **No toca `token_whitelist`, `nfts`, `templates` ni ninguna otra colección.**
