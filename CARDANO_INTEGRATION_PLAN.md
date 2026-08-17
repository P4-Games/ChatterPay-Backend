# Plan de integración de Cardano (Preprod) en ChatterPay B2C Backend

> Alcance: transferencias de ADA y de stablecoins nativas (USDCx, USDM, USDA) en Cardano
> **Preprod** desde el backend B2C.
> Fecha: 2026-08-16.

## Estado de implementación

| Pieza | Estado |
|---|---|
| Núcleo: address CIP-19, CBOR, fee, firma Ed25519 | ✅ implementado, validado contra vectores oficiales |
| Encoder multiasset (native assets) | ✅ implementado, **validado byte a byte contra una tx real de Preprod** |
| Provider (Koios) con fallas clasificadas | ✅ implementado |
| Wallet por teléfono, derivación determinística | ✅ implementado |
| `POST /make_transaction` con dispatch a Cardano | ✅ implementado |
| `GET /transaction/:hash/status` para Cardano | ✅ implementado |
| `GET /balance/:wallet` para bech32, con assets | ✅ implementado |
| Cambios de base + seeds + índices | ✅ aplicados en local dev — ver [`__to_deploy__/`](./__to_deploy__/) |
| Variables de entorno (8) | ✅ cableadas; falta darlas de alta en el trigger de GCP — ver [`__to_deploy__/`](./__to_deploy__/) |
| `buildServer()` / `startServer()` split (§10.1) | ✅ implementado |
| Tests unitarios y con provider fake | ✅ ~140 tests |
| **Transferencia real en Preprod** | ⏳ **bloqueado: falta fondear la wallet de prueba** |
| **Transferencia real de un native asset** | ⏳ bloqueado: USDM/USDA/USDCx son de mainnet; hace falta un CNT que exista en Preprod |
| Extracción del `transferRouter` (F3a) | ⛔ pendiente y deliberado — ver §3.3 |
| Dashboard (§8) | ⛔ pendiente, repo aparte |

Los policy id de USDCx / USDM / USDA **no están en el repo**: se dan de alta con
`scripts/cardano-add-token.ts` tras verificarlos. Ver §4.8.

---

## 0. Nota sobre el B2B

Existe una implementación de Cardano funcionando en el mundo B2B (repo separado, cuentas GCP
separadas, activos separados). **Este plan no crea ninguna dependencia con ese repo**: no hay paquete
compartido, no hay submodule, no hay servicio cruzado. Lo único que se reutiliza es el *conocimiento*
del diseño (qué problemas aparecen y cómo se resolvieron), y en dos módulos puros y sin estado
—derivación de address y armado de transacción— conviene reimplementar el mismo algoritmo porque es
criptografía estándar (CIP-19 + CBOR canónico) y ya está probada contra la red real.

Diferencias estructurales que hacen que **no** se pueda copiar la arquitectura del B2B:

| Tema | B2B | B2C (este repo) |
|---|---|---|
| Custodia de claves | Signer Gateway externo (`ed25519/...` keyReference) | Claves derivadas **in-process** (`secService.get_up`) |
| Identidad de wallet | `walletId` (UUID por deployment) | Número de teléfono del usuario |
| Multi-red | Catálogo de chains, `chainId` string (`cardano-preprod`) | **Una sola red activa** por instancia, `chainId` numérico |
| Ledger contable | Postgres con invariantes y worker de operaciones | Mongo, ejecución síncrona dentro del request |
| Modelo EVM | EIP-7702 / cuentas nativas | ERC-4337 (proxy + paymaster + bundler) |

---

## 1. Objetivo

Permitir que un usuario de ChatterPay B2C:

1. **tenga una address de Cardano Preprod** derivada determinísticamente de su identidad (teléfono),
   sin ninguna acción on-chain previa;
2. **vea su saldo de ADA** en los endpoints de balance existentes;
3. **envíe ADA** a otra address de Cardano (o a otro usuario de ChatterPay por número de teléfono)
   vía `POST /make_transaction/`;
4. vea la operación registrada en `transactions` con su hash y link al explorer.

**Fuera de alcance en esta etapa** (declarado, no olvidado): swaps en Cardano, NFTs,
staking/delegación, cross-chain EVM↔Cardano, Cardano mainnet.

**Dentro del alcance, junto con ADA:** las stablecoins nativas **USDCx, USDM y USDA**. Son native
assets de Cardano (CNT), no ADA, y soportarlas es trabajo real de armado de transacción —no
configurar un token más—: ver §4.8. No hay V2; esto entra en el mismo entregable.

---

## 2. Punto de partida: qué hay hoy en el B2C

Hallazgos relevantes del código actual (necesarios para entender el diseño propuesto):

- **La API es mono-red en runtime.** `setupNetworkConfigPlugin`
  (`src/config/plugins/networkConfigPlugin.ts:26`) carga **un** documento de `blockchains`
  (`mongoBlockchainService.getNetworkConfig()` → `DEFAULT_CHAIN_ID`) y lo deja en
  `server.networkConfig`. Todos los flujos leen de ahí.
- **`validateInputs` rechaza cualquier `chain_id` distinto al activo**
  (`src/controllers/transactionController.ts:159-162`).
- **Ya existe un concepto de "red destino no-EVM"**: el parámetro `network` en `make_transaction` y
  el mapa `CHAIN_TYPES` con ids sintéticos (`'20000000000001': 'UTXO'` = Bitcoin de Li.Fi,
  `src/controllers/transactionController.ts:134-140`). Cardano **no** está en Li.Fi, así que no
  puede entrar por el camino cross-chain: necesita una rama propia.
- **Las claves de usuario se derivan in-process**: `secService.get_up(phone, chanId)` =
  `sha256(SEED_INTERNAL_SALT ‖ chanId ‖ BUN_ENV ‖ phoneFormateado)` → clave privada secp256k1
  (`src/services/secService.ts:8-18`). No hay HSM ni gateway de firma.
- **`IUserWallet.chain_id` es `Number`** (`src/models/userModel.ts:20`) y `getUserWalletByChainId`
  filtra por igualdad numérica (`src/services/userService.ts:229`).
- **El fee de red hoy lo paga el paymaster** (ERC-4337). En el modelo mental actual del producto,
  el usuario **nunca** paga gas. En Cardano esto no existe: ver §4.4.
- **`checkTransactionStatus` asume EVM**: si el hash no empieza con `0x` devuelve el estado guardado
  sin consultar la cadena (`src/controllers/transactionController.ts:197`). Los tx id de Cardano son
  hex **sin** `0x`, así que hoy caerían en esa rama.
- **Los tokens requieren `address` única** (`src/models/tokenModel.ts`), y el balance filtra
  direcciones que no son contratos (`isSkippableTokenContractAddress`). ADA no tiene contrato.

---

## 3. Arquitectura propuesta (vista general)

Cardano entra como **una capacidad paralela a la red EVM activa**, no como reemplazo. La instancia
sigue teniendo su `networkConfig` EVM (Scroll/Arbitrum) y además, si está configurada, una
`cardanoNetworkConfig`.

```
POST /make_transaction   { to, token, amount, network? , chain_id? }
        │
        ├── validaciones comunes (usuario, PIN, límites, concurrencia)   ← se reusa tal cual
        │
        ├── ¿destino Cardano?  (network === 'cardano' | chain_id === CARDANO_PREPROD_CHAIN_ID
        │                        | token === 'ADA')
        │        │
        │        └── cardanoTransferService.transfer()
        │                 ├─ deriva address propia   (cardanoAddress)
        │                 ├─ resuelve destino        (bech32 | teléfono → address derivada)
        │                 ├─ lee UTxOs + params + tip (blockfrostService)
        │                 ├─ arma tx + fee exacto     (cardanoTxBuilder)   ← puro, testeable
        │                 ├─ firma Ed25519 in-process (cardanoSigner)
        │                 └─ submit + resolución de timeout (blockfrostService)
        │
        ├── ¿cross-chain Li.Fi?  → flujo existente
        └── EVM same-chain      → sendTransferUserOperation (flujo existente)
```

### 3.1 Módulos nuevos

```
src/services/cardano/
  cardanoAddressService.ts     # CIP-19: derivación base addr (tipo 0) + decode/validate bech32
  cardanoTxService.ts          # CBOR canónico, coin selection, fee exacto, tx id (puro)
  cardanoSignerService.ts      # derivación Ed25519 + firma (in-process, análogo a secService)
  blockfrostService.ts         # cliente del provider, con clasificación de fallas
  cardanoTransferService.ts    # orquestación del transfer (equivalente a transferService.ts)
  cardanoBalanceService.ts     # saldo de ADA a partir de UTxOs
  cardanoTypes.ts              # tipos compartidos del subsistema

src/config/cardanoConfig.ts    # env + red activa (preprod/mainnet) + guard de habilitación

src/services/transfer/
  transferTypes.ts             # ChainTransferExecutor: el contrato común (§3.3)
  transferRouter.ts            # dispatch por family — único punto que conoce ambas cadenas
  evmTransferExecutor.ts       # pasos 7-10 EVM, MOVIDOS tal cual desde makeTransaction
```

### 3.2 Módulos que se modifican

| Archivo | Cambio |
|---|---|
| `src/models/userModel.ts` | `IUserWallet`: campos opcionales `address_type` y `wallet_address` |
| `src/models/blockchainModel.ts` | `family: 'evm' \| 'cardano'`; hacer opcionales los campos EVM-only |
| `src/models/transactionModel.ts` | `network_fee?: number`, `network_fee_token?: string` |
| `src/config/constants.ts` | nuevas env vars de Cardano + `CARDANO_*_CHAIN_ID` |
| `src/config/plugins/networkConfigPlugin.ts` | cargar y refrescar `server.cardanoNetworkConfig` |
| `src/controllers/transactionController.ts` | `validateInputs` acepta Cardano; **extracción** de los pasos 7–10 al router (§3.3); `checkTransactionStatus` resuelve tx de Cardano |
| `src/services/userService.ts` | derivar/persistir wallet de Cardano al crear usuario y on-demand |
| `src/services/balanceService.ts` | incorporar el saldo de ADA |
| `src/helpers/validationHelper.ts` | `isValidCardanoAddress` (delega en el decode real) |
| `package.json` | `@noble/hashes`, `@scure/base` |

### 3.3 Separación respecto de la lógica EVM

Pregunta de diseño explícita: **¿queda la lógica de Cardano separada de la de EVM?** La respuesta
tiene tres partes distintas, porque no todo lo que hoy vive en el camino EVM *es* lógica EVM.

**a) El motor de cadena queda totalmente separado, sin abstracción común.**
`src/services/cardano/*` no comparte una línea con el camino EVM. Y no debe compartirla: gas /
paymaster / bundler / userOp y UTxO / fee exacto / TTL no tienen ningún concepto en común que valga
la pena unificar. Una "interfaz de blockchain" que intente cubrir ambos termina siendo un
denominador común que no describe ninguno de los dos y que hay que romper con la tercera cadena.

**b) Lo que sí se comparte, se comparte a propósito.** Identidad del usuario, gate de PIN, límites
diarios y por monto, lock de concurrencia, persistencia en `transactions`, chatterpoints y
notificaciones **no son lógica EVM: son política de producto**. Duplicarlas para Cardano sería el
error real — significaría que un cambio de límites o de reglas de seguridad aplica a una red y no a
la otra, y nadie se enteraría hasta que pase.

**c) La costura va por extracción, no por abstracción.** `makeTransaction` hoy tiene ~500 líneas y
ya carga dos ramas (Li.Fi cross-chain / EVM same-chain). Meter una tercera rama de Cardano ahí
adentro es lo que hay que evitar: funciona, pero la cadena siguiente lo empeora otra vez.

El corte propuesto:

```
makeTransaction  (controller)
   1-6.  validaciones comunes            ← sin cambios
   7-10. const result = await transferRouter.execute(ctx)   ← ÚNICO punto que conoce las familias
   11-13. persistencia + notificaciones  ← sin cambios (salvo network_fee)

transferRouter.execute(ctx)
   └─ switch (ctx.family)
        'evm'     → evmTransferExecutor      (código actual, MOVIDO tal cual)
        'cardano' → cardanoTransferService   (nuevo)
```

Con un contrato mínimo y honesto —solo lo que ambas familias realmente responden—:

```ts
export interface ChainTransferExecutor {
  readonly family: 'evm' | 'cardano';
  resolveDestination(to: string, ctx: TransferContext): Promise<string>;
  checkBalance(ctx: TransferContext): Promise<WalletBalanceInfo>;
  preflight(ctx: TransferContext): Promise<PreflightResult>;   // EVM: paymaster/signer/gas
                                                               // Cardano: protocol params + tip
  transfer(ctx: TransferContext): Promise<ExecuteTransferResult>;
  statusOf(txHash: string): Promise<'pending' | 'completed' | 'failed'>;
  explorerUrlFor(txHash: string): string;
}
```

**Regla de ejecución de este refactor: `evmTransferExecutor` es un `git mv` conceptual, no una
reescritura.** El camino EVM es el flujo de plata en producción; una refactorización real ahí es
riesgo de regresión que la incorporación de Cardano no justifica. Se mueve el código como está, se
lo envuelve en la interfaz, y cualquier limpieza del camino EVM va en un PR aparte con su propia
justificación.

**Qué se gana además del orden:** el `switch` queda en un solo archivo de ~30 líneas en lugar de
disperso en el controller; `cardanoTransferService` se puede testear sin levantar Fastify ni Mongo;
y agregar una cuarta cadena no vuelve a tocar `makeTransaction`.

**Acoplamiento residual que sí queda (declarado, no escondido):** los modelos Mongo son compartidos
con campos opcionales por familia (`IUserWallet.address_type`, `ITransaction.network_fee`). Es
acoplamiento débil y deliberado: la alternativa —colecciones separadas— duplicaría el lookup de
wallets y rompería a todos los consumidores que hoy iteran `user.wallets` (bot, dashboard, balance).

---

## 4. Decisiones de arquitectura

### 4.1 `chain_id` sintético para Cardano

Cardano no tiene chain id EIP-155, pero `IUserWallet.chain_id`, `ITransaction.chain_id` y
`IToken.chain_id` son numéricos. Cambiarlos a string sería un cambio invasivo que rompe bot,
dashboard e índices.

**Propuesta:** id interno derivado del *network magic* de Cardano, en un rango libre:

```ts
// Namespace interno ChatterPay para redes sin chain id EIP-155.
// 9e11 + network magic. No colisiona con EIP-155 (<1e9) ni con los ids sintéticos de Li.Fi
// (Bitcoin 2e13, Solana 1.15e15).
export const CARDANO_PREPROD_CHAIN_ID = 900000000001; // magic 1
export const CARDANO_MAINNET_CHAIN_ID = 900764824073; // magic 764824073
```

> ⚠️ Es una decisión **irreversible una vez que se escriben datos** (wallets, transactions). Hay que
> fijarla antes de la primera corrida contra la base real. Si se prefiere alinear con Li.Fi por si
> algún día agregan Cardano, la alternativa es esperar a que Li.Fi publique el suyo — pero eso
> bloquea el desarrollo, así que se recomienda el id interno y, si aparece el de Li.Fi, mapearlo en
> una capa de presentación.

### 4.2 Custodia de la clave Ed25519

El B2B guarda la clave en un Signer Gateway. **El B2C no tiene esa pieza**, y agregarla es un
proyecto en sí mismo. La decisión coherente con el estado actual del B2C es derivar la clave
Ed25519 in-process, igual que hoy se hace con la EOA de EVM.

**Requisito no negociable: separación de dominio.** No reutilizar los mismos 32 bytes de
`secService.get_up()` como seed Ed25519. Usar HKDF-SHA256 con `info` distinto:

```ts
// cardanoSignerService.ts (esquema)
const seed = hkdfSha256({
  ikm:  masterSecretFor(phoneNumber),        // mismo secreto raíz que hoy
  salt: SEED_INTERNAL_SALT,
  info: `chatterpay:cardano:ed25519:${CARDANO_NETWORK}:v1`,
  length: 32
});
```

Esto reproduce el efecto del prefijo `ed25519/` del keyReference del B2B: la clave de Cardano de un
usuario **nunca** es la misma que su clave EVM, y la versión (`v1`) queda explícita por si hay que
rotar el esquema.

**Firma:** `node:crypto` soporta Ed25519 envolviendo el seed en PKCS#8
(`302e020100300506032b657004220420` + 32 bytes) y llamando `sign(null, msg, key)`. No hace falta
dependencia nueva. **Verificar en la fase de spike que Bun implementa esto correctamente**; si no,
el fallback es `@noble/curves/ed25519` (misma familia que las otras dos deps propuestas).

### 4.3 Address: base (tipo 0) con la stake credential sin registrar

> **Revisado el 2026-08-17.** La primera versión de esta sección definía enterprise (tipo 6). Se
> cambió a base **antes de emitir una sola address** (0 wallets y 0 transacciones en toda base de
> datos al momento del cambio), para que habilitar staking después sea una transacción y no una
> migración de todas las wallets.

- **Lo que emitimos:** base address (tipo 0, CIP-19) = header byte + blake2b-224 del pubkey Ed25519
  de pago + blake2b-224 del pubkey Ed25519 de staking, en bech32 con HRP `addr_test` / `addr`. Las
  dos claves salen del mismo master secret por HKDF con `info` distinto
  (`ed25519:v1:<chainId>` y `ed25519:stake:v1:<chainId>`), una por usuario — no una compartida.
  Sigue siendo una **función pura de las claves**: existe y puede recibir fondos sin escribir nada
  en ningún lado, que es lo que habilita la "address anticipada" para destinatarios que todavía no
  son usuarios.
- **La stake credential va escrita en la address y registrada en ninguna parte.** Sin certificado,
  sin depósito, sin delegación: se comporta igual que una enterprise. Sin rewards en V1 — pero
  habilitarlos después cuesta una transacción (2 ADA de depósito reembolsables + ~0.2 ADA de fee,
  por usuario) en vez de mover los fondos de todos.
- **La stake key no firma nada** hoy: una transferencia se autoriza con la payment key sola. El
  signer deliberadamente no expone una firma con la stake key hasta que haya certificados que armar.
- **Costo de emitir base:** la address pasa de 29 a 57 bytes, así que el min-ADA de cada output sube
  ~0.12 ADA (28 bytes × `coinsPerUtxoByte`) y el fee sube en proporción al tamaño.
- **Lo que aceptamos como destino:** tipos 0–3 (base addresses) **además** de 6 y 7. Las wallets
  reales (Eternl, Lace, Daedalus) entregan base addresses; aceptar solo tipo 6 rechazaría
  prácticamente todos los destinos externos.
- **La red va dentro de la address.** Validar con un decode bech32 real (checksum incluido), no con
  un regex de prefijo, y verificar que el nibble de red del header coincida con el prefijo *y* con
  la red configurada. Una mainnet address pegada por error en una instancia Preprod se rechaza; un
  typo se rechaza por checksum.

### 4.4 Fees: el usuario paga, y eso cambia el producto ⚠️

En EVM el paymaster subsidia el gas y el usuario nunca ve una moneda nativa. **En Cardano no existe
ese mecanismo**: el fee sale de los inputs de la propia transacción, es decir, del ADA del usuario.
Consecuencias que hay que decidir a nivel producto, no técnico:

1. **Un usuario con 0 ADA no puede transferir nada.** No hay forma de "sponsorizar" sin construir
   un input propio en la transacción.
2. **Mínimo por output (~1 ADA).** El protocolo rechaza outputs por debajo del min-ADA calculado a
   partir del tamaño del output. Transferencias de "0.1 ADA" son imposibles, no solo caras.
3. **Cambio dust.** Si el vuelto queda por debajo del min-ADA no puede ser un output propio: se
   suma al fee. Es un costo real y hay que reportarlo como fee, nunca ocultarlo.

**Números reales, medidos** (parámetros de Preprod epoch 307: `minFeeA=44`, `minFeeB=155381`,
`coinsPerUtxoByte=4310`; precio ADA/USD tomado del propio `getTokenPrices` del backend):

| Concepto | ADA | USD (ADA = 0.17631) |
|---|---|---|
| Fee de red, 1 input / 2 outputs → enterprise addr | 0.165941 | $0.029 |
| Fee de red → base addr (**las que emitimos**, y las que pega el usuario) | 0.167173 | **$0.029** |
| min-ADA de un output a enterprise addr | 0.849070 | $0.150 |
| min-ADA de un output a base addr (**las que emitimos**) | 0.969750 | **$0.171** |

**Consecuencia sobre el fee de 0.08 de ChatterPay:** un output on-chain de 0.08 ADA es **inválido**,
no caro — está 10.6x por debajo del min-ADA, y el ledger rechaza la transacción entera. El output de
fee más chico que Cardano acepta cuesta $0.15, o sea **casi el doble del fee objetivo y 5x el costo
de red**. Cobrar el fee on-chain por transferencia llevaría el costo total al usuario de $0.029 a
$0.179.

Y si `0.08` se interpreta como 0.08 **ADA** ($0.014), ni siquiera cubre el fee de red. Pero la
pregunta de cobertura es secundaria: en EVM el fee recupera el gas que adelantó el paymaster; en
Cardano ChatterPay no adelanta nada, así que no hay nada que recuperar.

**Recomendación por fases:**
- **V1 (Preprod):** el usuario se fondea desde el faucet de Cardano. El backend, cuando no alcanza,
  devuelve un mensaje accionable que **incluye la address a fondear** (no un error genérico).
- **V2:** wallet de subsidio de la plataforma que agrega un input propio + un segundo witness
  (`witnessCount: 2` en el builder). El builder ya queda preparado para eso; el resto (selección de
  UTxOs de la wallet de plataforma, contabilidad, reposición) es trabajo aparte.

### 4.5 Provider: Blockfrost

- **Elección:** Blockfrost Preprod (`https://cardano-preprod.blockfrost.io/api/v0`). Es el que ya
  está validado contra la red en el otro mundo, tiene tier gratuito suficiente para un piloto y su
  API cubre exactamente lo necesario: `/addresses/{a}/utxos`, `/epochs/latest/parameters`,
  `/blocks/latest`, `/tx/submit`, `/txs/{id}`.
- **Alternativas descartadas por ahora:** nodo propio (sync de horas y decenas de GB), Koios (sin
  API key pero menos garantías de disponibilidad), Maestro (de pago).
- **Toda falla del provider debe clasificarse**, no propagarse como string. En particular:
  `rate_limited` (429), `unauthorized` (401/402/403), `provider_unavailable` (5xx),
  `rejected_by_chain` (400 en POST /tx/submit), `timeout`.
- **El caso crítico es el timeout en submit:** puede haber llegado a la cadena. Cardano no tiene RBF
  ni nonce, así que reenviar es gastar los mismos inputs dos veces. La resolución correcta es
  **buscar el tx id** (que se conoce *antes* de enviar, porque es el hash del body firmado) y
  concluir a partir de eso.

### 4.6 Armado de transacción: implementación propia, no librería WASM

El body de una transacción de transferencia simple es un mapa CBOR canónico de 4 claves enteras
(inputs, outputs, fee, ttl) y su blake2b-256 es el tx id. Son ~400 líneas de encoder + coin
selection + loop de fee.

- **A favor de implementarlo:** cero dependencias WASM en el runtime Bun/Docker; el fee depende del
  tamaño serializado, así que el encoder es *parte* del cálculo de fee y no un detalle debajo; queda
  100% testeable con UTxOs fabricados (change dust, saldo que cubre monto pero no fee, tx too
  large) sin necesidad de armarlos en una cadena real.
- **En contra de `@emurgo/cardano-serialization-lib`:** binario WASM pesado, fricción en build
  multi-stage de Docker, y no elimina la necesidad de entender el cálculo de fee.
- **El fee es exacto, no estimado:** se calcula sobre el tamaño de la transacción **firmada**
  (witnesses incluidos, con firmas placeholder del largo correcto), iterando hasta que converge.

**Invariante a verificar antes de firmar:** `Σ inputs = monto + fee + cambio`. Una transacción que
no balancea la rechaza la cadena, y enterarse por el provider cuesta una firma.

### 4.7 Ejecución: fallar antes de firmar

Cardano no ofrece forma de reemplazar ni cancelar una transacción enviada. El único fallo limpio es
el que nunca salió. Por lo tanto **todas** las validaciones (destino, red, fondos, min-ADA, tamaño,
balance de la tx) ocurren **antes** de pedir la firma.

El TTL (propuesto: 900 slots ≈ 15 min en Preprod) es el mecanismo que hace resoluble una transacción
trabada: pasado el TTL, los inputs vuelven a estar provablemente libres.

Para gastar, exigir **3 confirmaciones** sobre los UTxOs de entrada. No es "finalidad" (la garantía
de Cardano es probabilística y la finalidad plena está a miles de bloques); es la respuesta
declarada del piloto a la pregunta del rollback, deliberadamente conservadora para los montos de un
piloto en Preprod.

### 4.8 Native assets: USDCx, USDM y USDA

Las tres son **stablecoins nativas de Cardano** (CNT: policy id + asset name), no ADA. Soportarlas
no es "configurar un token más" — la transferencia de ADA y la de un token son dos armados
distintos. Esto es lo que cambia, y todo está implementado:

**1. Cambia la codificación de los outputs.** Hoy `encodeOutput` escribe `[address, coin]`. Con
tokens, la CDDL es `transaction_output = [address, amount]` con
`amount = coin / [coin, multiasset]`, donde el multiasset es un mapa anidado
`{policy_id: {asset_name: quantity}}`. Es una rama nueva del encoder CBOR, y como el fee se calcula
sobre el tamaño serializado, toca también el cálculo del fee.

**2. El token no puede viajar solo — y esto es lo que más cambia el producto.** Un output que carga
tokens es más grande, así que su min-ADA sube. Medido con los parámetros reales de Preprod
(`coinsPerUtxoByte = 4310`):

Con una cantidad de 30.000000 (6 decimales), que es un envío realista:

| Output hacia | sin assets | 1 asset | 2 assets (misma policy) | 2 assets (policies distintas) | 3 assets |
|---|---|---|---|---|---|
| enterprise (ya no las emitimos) | 0.849070 | 1.034400 | 1.077500 | 1.211110 | 1.387820 |
| base addr (**las que emitimos**, y las que pega el usuario) | 0.969750 | **1.155080** | 1.198180 | 1.331790 | 1.508500 |

Consecuencia directa: **cada transferencia de USDM mueve además ~1.16 ADA al destinatario** (ese es
el número de la fila que aplica: emitimos base y el usuario pega base), y
el emisor tiene que tenerlos. No existe mandar una stablecoin sin adjuntarle ADA.

Lo que hace crecer ese número es **la cantidad de activos distintos en el output**, no el monto —
aunque la magnitud del monto influye un poco, porque la cantidad se serializa dentro del output:

| Cantidad enviada | min-ADA (enterprise, 1 asset — sumar 0.120680 para base) |
|---|---|
| 1 | 1.017160 |
| 1.000 | 1.025780 |
| 1.000.000 | 1.034400 |
| 30.000.000 | 1.034400 |
| 10.000.000.000.000 | 1.051640 |

**3. El emisor necesita ADA aunque sólo quiera mover tokens.** Fee de red + min-ADA del output de
tokens + min-ADA del output de cambio. **Un usuario con 100 USDM y 0 ADA no puede transferir nada.**
Esto agrava el problema de fondeo de §4.4 en vez de aliviarlo: hoy el usuario necesita ADA para el
fee; con tokens necesita ADA para el fee *y* para cada output. Es el argumento más fuerte a favor de
la wallet de subsidio (§4.4 V2), porque acá la fricción ya no es de centavos.

**4. El cambio tiene que arrastrar los tokens sobrantes.** Gastar un UTxO con 100 USDM para enviar
30 exige un output de cambio con 70 USDM. Es la pieza que V1 saltea, y es la que vuelve
**multidimensional la selección de UTxOs**: hay que cubrir el ADA *y* la cantidad de cada activo.
El selector actual, largest-first sobre ADA, deja de alcanzar.

**5. Hay que persistir la identidad del activo.** Un CNT se identifica por `policyId` (28 bytes) +
`assetName` (hex). El campo centinela `tokens.address` es el lugar natural: la "unit" estándar es la
concatenación `policyIdHex + assetNameHex`, que es exactamente lo que devuelven Koios y Blockfrost.

**6. Cambia la llamada al provider.** `utxosFor` hoy pide `_extended: false` y sólo marca
`holdsOtherAssets`. Necesita `_extended: true` para recibir `asset_list` con
`policy_id` / `asset_name` / `quantity`.

**7. El balance pasa a ser por activo**, y el endpoint tiene que devolver una fila por stablecoin
además de la de ADA.

#### Dos hechos de planificación fáciles de pasar por alto

**a. Las tres son activos de mainnet: en Preprod no existen.** USDM (Moneta), USDA (Anzens/Emurgo) y
el USDC puenteado no tienen contraparte en la testnet. Probar el flujo exige una de dos cosas:
**mintear un CNT de prueba propio en Preprod** —lo correcto para CI, E2E y para ejercitar los
bordes— o probar en mainnet con plata real. Recomendación: mintear el token de prueba y validar
contra los reales recién en el paso a mainnet.

**b. Los policy ID hay que confirmarlos de fuente autoritativa antes de configurarlos.** Un policy
ID equivocado **no falla**: produce una transferencia perfectamente válida de un activo que no es el
que el usuario cree estar mandando. A propósito no quedan escritos acá, para que nadie los copie sin
verificar. Fuentes a cruzar, las tres: el
[Cardano Token Registry](https://github.com/cardano-foundation/cardano-token-registry), la
documentación oficial de cada emisor, y Cardanoscan.

> Sobre **USDCx** en particular: conviene confirmar primero *qué* es exactamente en el contexto del
> producto — el USDC puenteado a Cardano circula bajo más de un nombre y más de un emisor según el
> puente. Definir el activo antes de definir el ticker.

#### Cómo se dan de alta

Con `scripts/cardano-add-token.ts`, que exige el policy id explícito y **rechaza** cualquier cosa
que no sea estructuralmente un activo de Cardano (56 hex de policy, asset name ≤32 bytes, sin
tickers duplicados en la misma red). Deliberadamente **no** hay una tabla de stablecoins
hardcodeada en el repo: los valores los aporta quien los verificó.

```bash
MONGO_URI=... bun run scripts/cardano-add-token.ts \
  --symbol USDM --policy-id <56 hex> --asset-name-ascii USDM --decimals 6
```

**Impacto en decisiones ya tomadas:** §4.4 (fees) se vuelve más urgente; §5.2 (documentos de
`tokens`) usa `address` = `policyId+assetNameHex`; §8.2 (dashboard) necesita vista por activo.

---

## 5. Cambios en base de datos (MongoDB)

### 5.0 Resumen

| Colección | Cambio de schema | Datos nuevos | Migración de datos existentes |
|---|---|---|---|
| `blockchains` | **Sí** — `family` + relajar `required` EVM-only | 1 documento | No |
| `tokens` | No | 1 documento (ADA) | No |
| `users` | Sí — 2 campos **opcionales** en `wallets[]` | — | Backfill idempotente (opcional) |
| `transactions` | Sí — 2 campos **opcionales** | — | No |
| Índices | **Sí** — 2 índices nuevos en `users` | — | Build en background |

**Hallazgo que baja el riesgo:** `mongoBlockchainService.getAllNetworks()` está definido pero
**no se usa en ningún lado de `src/`**. Todo el backend accede a las redes por
`getNetworkConfig()` (chain activa) o `getBlockchain(chainId)` (chain puntual). Es decir: agregar un
documento de Cardano a `blockchains` es **inerte** para todos los jobs y servicios existentes — no
hay ningún proceso que itere las redes y que vaya a intentar levantar un `JsonRpcProvider` con un
`rpc` vacío. Esto hay que **volver a verificar antes de mergear** (un `getAllNetworks()` nuevo
introducido mientras tanto rompería el supuesto).

### 5.1 `blockchains` — cambio de schema + documento nuevo

**El insert falla hoy tal cual está el schema.** `blockchainSchema`
(`src/models/blockchainModel.ts:107`) marca como `required: true` un conjunto de campos que no
tienen sentido en Cardano. Lista exacta de lo que hay que volver condicional:

| Campo | Por qué no aplica a Cardano |
|---|---|
| `manteca_name` | no hay par de Manteca para esta red |
| `rpc`, `rpcBundler` | no hay JSON-RPC ni bundler ERC-4337 |
| `marketplaceOpenseaUrl` | no hay OpenSea |
| `supportsEIP1559` | no hay EIP-1559 (ni gas) |
| `externalDeposits` | el ingestor de depósitos es EVM-only (§5.8) |
| `gas.useFixedValues`, `gas.operations.transfer`, `gas.operations.swap` | no hay gas |
| `balances.*` (los 5) | no hay paymaster ni backend signer que fondear |
| `limits.swap`, `limits.mint_nft`, `limits.mint_nft_copy` | operaciones fuera de alcance |
| `logo` | se completa igual, pero deja de ser obligatorio por consistencia |

Se mantienen obligatorios para todas las familias: `name`, `chainId`, `explorer`, `environment`,
`limits.transfer`.

```ts
// Patrón propuesto: required condicional por familia, en lugar de rellenar con valores falsos
const evmOnly = { type: String, required(this: IBlockchain) { return this.family === 'evm'; } };
```

> **Alternativa descartada:** completar los campos EVM con valores dummy (`rpc: ""`, `gas: {...}`).
> Produce un documento que *dice* tener un RPC y un paymaster. Cualquier lectura futura lo va a
> creer, y el bug va a aparecer lejos de acá.

Documento a insertar:

```jsonc
{
  "name": "Cardano Preprod",
  "family": "cardano",                  // NUEVO — 'evm' | 'cardano'
  "chainId": 900000000001,
  "environment": "testnet",
  "explorer": "https://preprod.cardanoscan.io/transaction/",
  "logo": "...",
  "cardano": {                          // NUEVO — sub-doc específico
    "network": "testnet",               // decide el header byte de la address (CIP-19)
    "providerBaseUrl": "https://cardano-preprod.blockfrost.io/api/v0",
    "ttlSlots": 900,
    "depositConfirmations": 3,
    "slotSeconds": 1
  },
  "limits": { "transfer": { "L1": { "ADA": 100 }, "L2": { "ADA": 500 } } }
}
```

> El `project_id` de Blockfrost **va por env, nunca en la base ni en el repo**.

### 5.2 `tokens` — ADA

ADA no tiene contrato. `address` es `unique` en el schema, así que necesita un centinela estable:

```jsonc
{
  "name": "Cardano ADA",
  "symbol": "ADA",
  "display_symbol": "ADA",
  "chain_id": 900000000001,
  "decimals": 6,                        // lovelace
  "display_decimals": 2,
  "address": "cardano:preprod:lovelace",  // centinela, NO es un contrato
  "type": "native",
  "ramp_enabled": false,
  "operations_limits": { "transfer": { "L1": { "min": 1, "max": 100 }, "L2": { "min": 1, "max": 500 } } }
}
```

> `min: 1` no es arbitrario: está por encima del min-ADA de un output (§4.4).
> El camino de balance debe **ramificar por `family` antes** de `isSkippableTokenContractAddress`,
> que descartaría esta address por no ser un contrato.

### 5.3 `users.wallets[]`

Se reutiliza el array existente con el chain_id sintético, para que `getUserWalletByChainId` siga
funcionando sin cambios. Campos nuevos, todos opcionales (retro-compatible):

```ts
export interface IUserWallet {
  wallet_proxy: string;   // Cardano: la bech32 address (para que bot/dashboard no cambien)
  wallet_eoa: string;     // Cardano: la misma bech32 address
  chain_id: number;       // 900000000001
  status: string;
  address_type?: 'evm_aa' | 'cardano_base';          // NUEVO
  cardano_public_key?: string;                       // NUEVO — pubkey Ed25519 de pago, hex
  cardano_stake_public_key?: string;                 // NUEVO — pubkey Ed25519 de staking, hex
  // ...campos EVM existentes quedan vacíos
}
```

> Alternativa considerada y descartada: colección `cardano_wallets` aparte. Duplica la lógica de
> lookup y rompe todos los consumidores que iteran `user.wallets`.

### 5.4 `transactions`

- `trx_hash`: tx id de Cardano, hex de 64 chars **sin `0x`**.
- `chain_id`: `900000000001`.
- `fee`: `0` en V1 (no hay fee de ChatterPay en Cardano todavía).
- **`network_fee?: number` y `network_fee_token?: string`** (NUEVOS): el fee real de red en ADA.
  Sin esto, el fee de Cardano —que sí existe y sí lo paga el usuario— queda invisible en el
  historial.
- `status`: `'pending'` al submit, `'completed'` cuando se confirma (§6.3).

El índice único existente `{ trx_hash, wallet_from, wallet_to }` (`transactionModel.ts:56`) funciona
sin cambios: el tx id de Cardano es único globalmente.

### 5.5 Índices

Hoy **`users` no tiene ningún índice declarado sobre `wallets`**. Con Cardano cada usuario pasa a
tener 2+ entradas en el array, y hay al menos una consulta que ya hoy hace collection scan:

```ts
// src/services/mongo/mongoUserService.ts:438
{ 'wallets.wallet_proxy': { $regex: new RegExp(`^${address}$`, 'i') } }
```

Cambios propuestos:

```js
db.users.createIndex({ 'wallets.wallet_proxy': 1 }, { name: 'wallets_proxy' })
db.users.createIndex({ 'wallets.chain_id': 1, 'wallets.wallet_proxy': 1 }, { name: 'wallets_chain_proxy' })
```

Dos observaciones sobre esa consulta, ninguna introducida por Cardano pero ambas empeoran con más
wallets por usuario:

1. **El `$regex` con `'i'` no usa el índice** aunque exista. Para direcciones de Cardano el
   case-insensitive es innecesario: bech32 tiene un case canónico (minúsculas) y una address
   mixed-case es inválida por definición. Propuesta: normalizar a minúsculas al persistir y
   consultar por igualdad exacta, dejando el `$regex` solo para el camino EVM legacy.
2. **La address se interpola cruda en un `RegExp`.** Con direcciones EVM (`0x` + 40 hex) no hay
   metacaracteres posibles, así que hoy no es explotable; con inputs de otras familias conviene
   escapar. Vale registrarlo aunque se resuelva fuera de este plan.

### 5.6 Scripts de migración y orden de ejecución

Todo va en `scripts/`, idempotente y con `--dry-run`:

| Script | Qué hace | Cuándo |
|---|---|---|
| `cardano-seed-blockchain.ts` | upsert del documento de `blockchains` por `chainId` | F2, antes de habilitar el flag |
| `cardano-seed-token.ts` | upsert del token ADA por `address` | F2 |
| `cardano-create-indexes.ts` | los índices de §5.5, `background: true` | F2 |
| `cardano-backfill-wallets.ts` | deriva y persiste la address de Cardano de usuarios existentes | F2, opcional (ver decisión §12.3) |

**Orden obligatorio:** schema (deploy del código) → índices → seed de `blockchains` → seed de
`tokens` → backfill → recién ahí `CARDANO_ENABLED=true`.

**Rollback:** los tres primeros son reversibles borrando los documentos y los índices. El backfill
no necesita rollback: las addresses son determinísticas, así que borrar las entradas de `wallets[]`
y volver a derivarlas da exactamente el mismo resultado. **Ese es el motivo real por el que la
derivación determinística importa acá**: no hay estado que perder.

### 5.7 Colecciones que NO se tocan

Verificado explícitamente, porque "no lo toqué" es distinto de "confirmé que no hace falta":

- **`nfts`** — flujo EVM (contratos), no aplica.
- **`token_whitelist`** — índice `{chainId, token}`, lo alimenta el sync de Alchemy (EVM-only).
- **`external_deposits`** — ver §5.8.
- **`notification_templates`** — se reutilizan las plantillas existentes; el placeholder
  `[EXPLORER]` se resuelve desde el `networkConfig` correcto según la familia de la transacción
  (`notificationService.ts:621,754,808,850`). **Hay que verificar en F4 que esas cuatro llamadas
  usen el explorer de Cardano y no el de la red EVM activa** — hoy las cuatro hacen
  `getNetworkConfig()` a secas, que devuelve siempre la chain por defecto.
- **`chatterpoints`, `security_events`, `countries`, `polymarket_*`** — agnósticas de cadena.

### 5.8 Gap: depósitos externos en Cardano

`externalDepositsService` detecta ADA/tokens que entran desde afuera vía Alchemy o TheGraph, ambos
EVM-only, y depende de `blockchains.externalDeposits.lastBlockProcessed`.

**Consecuencia:** en V1, un usuario que recibe ADA desde una wallet externa o desde el faucet
**no recibe notificación** y el depósito no queda registrado en `external_deposits`. El saldo sí se
va a ver bien (se lee de los UTxOs en vivo), pero la experiencia es peor que en EVM.

Es un gap **declarado, no un olvido**. Cerrarlo requiere un ingestor propio (polling de
`/addresses/{addr}/utxos` por usuario, o webhooks de Blockfrost) y es trabajo aparte, fuera del
alcance de este plan. Queda como decisión de producto en §12.

---

## 6. Flujos

### 6.1 Alta de wallet de Cardano

La address es una función pura de la clave, así que **no hay ninguna operación on-chain**. Se deriva
y se persiste:

- Al crear un usuario nuevo (`createUserWithWallet`), si Cardano está habilitado: se agrega una
  segunda entrada en `wallets[]`.
- Para usuarios existentes: derivación **on-demand** la primera vez que se pide balance o transfer
  de Cardano (`addCardanoWalletToUser`), más un script de backfill idempotente en `scripts/`.
- Como es determinística, la derivación es siempre reproducible: no hace falta migración de datos ni
  hay riesgo de perder la address.

### 6.2 Transferencia (`POST /make_transaction/`)

Reutiliza los pasos 1–6 y 11–13 del `makeTransaction` actual sin cambios (usuario, concurrencia,
gate de seguridad/PIN, límites diarios, límites por monto, respuesta optimista, persistencia,
chatterpoints, notificaciones). Solo cambian los pasos 7–10:

| Paso | EVM (hoy) | Cardano (nuevo) |
|---|---|---|
| Detección de ruta | `network` + Li.Fi | `network === 'cardano'` \| `chain_id === CARDANO_*` \| `token === 'ADA'` |
| 7. Balance | `verifyWalletBalanceInRpc` (ERC-20) | `cardanoBalanceService`: Σ UTxOs confirmados y sin native assets |
| 8. Condiciones de red | paymaster, signer, gas | protocol params + tip del provider (y nada más: no hay paymaster) |
| 9. Destino | `0x…` \| teléfono → proxy | bech32 validado \| teléfono → address Cardano derivada |
| 10. Ejecución | `sendTransferUserOperation` | `cardanoTransferService.transfer()` |

Detalle del paso 10:

```
1. decode del destino  → tipo de address + red + payload bytes   (falla → rechazo, nada firmado)
2. deriva address propia y valida contra la persistida           (mismatch → rechazo)
3. lee en paralelo: protocolParameters(), tip(), confirmedUtxos(addr, 3)
4. buildTransfer(...)  → body CBOR + tx id + fee exacto + cambio
     rechaza: monto < min-ADA | fondos insuficientes | tx > maxTxSize | fee no converge
5. verifica invariante Σinputs = monto + fee + cambio
6. firma Ed25519 (in-process, seed HKDF)  ← primer punto sin retorno
7. encodeSignedTransaction(body, [witness])
8. submit → tx id
     timeout → statusOf(txId): conocido = éxito; desconocido = fallo seguro de reintentar
9. devuelve { transactionHash, fee, explorerUrl }
```

**Sobre la concurrencia:** el lock existente (`openOperation`/`closeOperation` por usuario) es lo que
impide que dos transferencias simultáneas seleccionen los mismos UTxOs. **Es obligatorio que la rama
de Cardano quede dentro de ese lock** — en EVM el nonce protege, acá no hay nada más.

### 6.3 Confirmación y estado

`checkTransactionStatus` hoy corta en `if (!trx_hash.startsWith('0x'))` y devuelve el estado
guardado. Hay que ramificar **antes** de eso, por `chain_id` de la transacción:

- Cardano → `blockfrostService.statusOf(txId)`; `known && confirmations >= 1` → `completed`.
- Si pasó el TTL y sigue desconocida → `failed` (los inputs volvieron a estar libres).

Opcional (recomendado para V2): un worker de reconciliación periódico sobre las transacciones
`pending` de Cardano, análogo a lo que ya se hace con depósitos externos.

### 6.4 Balance

`getAddressBalanceWithNfts` / `getTokenBalances` ramifican por `family`:

- Cardano: `spendableBalance(utxos)` en lovelace → ADA con 6 decimales.
- **UTxOs que contienen native assets se excluyen del saldo gastable pero se informan aparte** (su
  ADA es real, simplemente V1 no la gasta). Reportarlos como ausentes haría que el saldo no coincida
  con ningún explorer.
- Precio ADA/USD: reutilizar `coingeckoService` (id `cardano`).

---

## 7. Configuración

Nuevas variables de entorno (agregar a `example_env` y a `src/config/constants.ts`):

```bash
CARDANO_ENABLED=true
CARDANO_NETWORK=preprod                       # preprod | mainnet
CARDANO_CHAIN_ID=900000000001
CARDANO_BLOCKFROST_BASE_URL=https://cardano-preprod.blockfrost.io/api/v0
CARDANO_BLOCKFROST_PROJECT_ID=<secreto>       # GCP Secret Manager, nunca en el repo
CARDANO_PROVIDER_TIMEOUT_MS=20000
CARDANO_TTL_SLOTS=900
CARDANO_DEPOSIT_CONFIRMATIONS=3
```

**Guard de habilitación:** `CARDANO_ENABLED` solo tiene efecto si además hay `PROJECT_ID` y existe
el documento de `blockchains` correspondiente. Si falta algo, el subsistema queda apagado y la rama
de Cardano en `make_transaction` responde "red no disponible" — nunca a medias, y nunca simulando.

Dependencias nuevas (ambas sin dependencias transitivas, auditadas, sin WASM):

```json
"@noble/hashes": "^1.5.0",   // blake2b-224 (credencial) y blake2b-256 (tx id)
"@scure/base":   "^1.1.9"    // bech32 con límite de longitud configurable (256, no 90)
```

---

## 8. Impacto en el dashboard de usuario (repo `front-local`)

> Repo separado: `/mnt/c/develop/chatterpay/front-local` (Next.js + MUI). Va en **su propio PR**,
> coordinado con el backend por el flag `CARDANO_ENABLED`. Lo que sigue es el relevamiento del
> impacto real, verificado contra el código.

**La buena noticia estructural:** el front ya está diseñado para *operar* en una chain y *mostrar*
datos de varias. `src/config-chains.ts` es un registry indexado por `chainId` numérico creado
exactamente para eso ("un usuario conserva la wallet, los NFTs y el historial de cada red en la que
operó"). Cardano entra por ahí, no por una refactorización.

### 8.1 `src/config-chains.ts` — fila nueva + un campo nuevo

```ts
export const CARDANO_PREPROD_CHAIN_ID = 900000000001

[CARDANO_PREPROD_CHAIN_ID]: {
  chainId: CARDANO_PREPROD_CHAIN_ID,
  name: 'Cardano Preprod',
  explorerUrl: 'https://preprod.cardanoscan.io',
  txPath: '/transaction',            // ← CAMPO NUEVO (ver abajo)
  nftExplorerUrl: 'https://preprod.cardanoscan.io',
  nftMarketplaceUrl: '',             // no hay NFTs en Cardano V1
  logo: '',
  layerswapNetwork: '',              // Layerswap no lista Cardano → el widget se oculta solo ✓
  testnet: true
}
```

⚠️ **El link al explorer se rompe sin el campo nuevo.** Hoy la URL se arma concatenando `/tx/` a
mano: `banking-recent-transitions-row.tsx:184` (`` `${explorerBase}/tx/${row.trx_hash}` ``) y
`nft-item.tsx:73`. **Cardanoscan usa `/transaction/{id}`, no `/tx/{hash}`.** Hay que agregar
`txPath` a `ChainConfig` y un helper `getTxUrl(chainId, hash)` que reemplace las concatenaciones.
Las dos de Polymarket (`dashboard-positions-table.tsx:862`, `polymarket-portfolio.tsx:948`) son
Polygon fijo y pueden quedar como están.

### 8.2 `dashboard-withdraw-modal.tsx` — el flujo de envío

Ya es multi-familia: tiene `addressType: 'evm' | 'solana' | 'bitcoin'`, `validateAddress()` y chain
ids sintéticos hardcodeados (`20000000000001` BTC, `1151111081099710` SOL). Agregar Cardano es
seguir el patrón existente, con cuatro salvedades:

1. **La lista de redes destino se arma desde la API de Li.Fi** (`c.chainType`). Cardano no está en
   Li.Fi, así que **hay que inyectar la entrada como estática**; esperarla del fetch no la va a
   traer nunca.
2. **Validación con decode bech32 real, no regex.** `isValidEvmAddress` es un regex porque para EVM
   alcanza; para Cardano un regex sobre `addr_test1…` acepta una address con un typo, y el error
   cuesta la plata. Recomendación: `@scure/base` en el front (~3 KB) para validar al pegar. El
   backend valida igual —§4.3— pero el feedback inmediato es la mitad del valor.
3. **El fee de red hay que mostrarlo.** El modal hoy muestra `TRANSACTION_FEE_USD` (fee de
   ChatterPay). En Cardano el usuario además paga el fee de red en ADA (§4.4); si no se muestra, lo
   que llega al destinatario no coincide con lo que el usuario creyó enviar.
4. **Mínimo por operación.** El min-ADA (~1 ADA) ya se puede tomar de
   `IToken.operations_limits.transfer.L1.min`, que el tipo del front ya contempla. Bloquear por
   debajo, con mensaje explícito de por qué.

### 8.3 Fondeo / recepción — el gap de UX más grande

En V1 el usuario se fondea solo (§4.4), así que **necesita ver y copiar su address de Cardano**. Hoy
no puede:

- `deposit-view.tsx:27` valida `^0x[a-fA-F0-9]{40}$` y rechaza cualquier address no-EVM.
- Layerswap no cubre Cardano, así que el widget de depósito queda oculto (correcto, pero deja la
  pantalla sin alternativa).

Hace falta una vista **"Recibir ADA"**: address + QR + botón copiar + link al faucet de Preprod.
Sin esto la funcionalidad es inusable para un usuario sin ADA — que al principio son todos.

### 8.4 Multi-wallet: la decisión de producto del front

`IBalances.wallet` es un **string** y el balance se pide como `/balance/{walletAddress}`: el
dashboard es mono-wallet. Con Cardano el usuario pasa a tener dos addresses.

El backend ya devuelve `wallets: string[]` (plural) en `AddressBalanceWithNfts`, así que el contrato
lo contempla. Dos caminos:

| Opción | Qué implica | Veredicto |
|---|---|---|
| **(a) Portfolio unificado** | el backend devuelve las filas de ADA junto a las EVM; `IBalance.network` ya distingue la red, y la tabla no cambia de estructura | **Recomendada para V1**: cambio mínimo y coincide con cómo el usuario piensa su plata |
| (b) Selector de red | switcher en el header, un balance por red | Más trabajo, y fragmenta la vista de patrimonio |

Con (a), lo único que sí cambia es el header que muestra "tu wallet: 0x…": tiene que mostrar la
address correspondiente al activo, o las dos.

### 8.5 Render de addresses

| | Largo |
|---|---|
| EVM | 42 chars |
| Cardano enterprise (ya no la emitimos) | ~59 chars |
| Cardano base (la que emitimos, y la que el usuario pega desde Eternl/Lace) | ~103 chars |

Revisar truncados, `wordBreak`, ancho de columna en la tabla de transacciones y densidad del QR
(un QR de 103 chars necesita más módulos y más tamaño mínimo para ser escaneable).

### 8.6 Tipos e i18n

- `src/types/wallet.ts`: `ITransaction.chain_id?: number` **ya existe** — no hay cambio de tipo para
  que las filas de Cardano se rendericen. Agregar `network_fee?` y `network_fee_token?` si se
  muestran (§5.4).
- `src/locales/langs/{en,es,br}.json`: strings nuevas (nombre de red, faucet, mínimo por
  transacción, fee de red, errores de address inválida / red equivocada). Las tres deben quedar
  completas: una clave faltante se muestra cruda al usuario.

### 8.7 Estimación

**4–6 días** de front, secuenciados detrás de F3b del backend (necesita el endpoint funcionando para
integrar). El registry (§8.1) y los tipos (§8.6) se pueden adelantar sin backend.

---

## 9. Plan de trabajo por fases

| Fase | Contenido | Entregable verificable | Est. |
|---|---|---|---|
| **F0 — Spike** | Ed25519 en Bun vía `node:crypto`; alta de proyecto Blockfrost Preprod; script `scripts/cardano-spike.ts` que deriva una address, la fondea desde el faucet, arma, firma y **submitea una tx real**. Además: split `buildServer()` / `startServer()` (§10.1), que habilita todo el testing de flujo del repo | Un tx id visible en preprod.cardanoscan.io + `fastify.inject()` funcionando | 2–3 d |
| **F1 — Núcleo** | `cardanoAddressService`, `cardanoTxService`, `cardanoSignerService`, `blockfrostService`. Puros y sin acoplamiento al resto del backend | Tests unitarios verdes con UTxOs fabricados y vectores CIP-19 | 3–5 d |
| **F2 — Dominio** | Modelos Mongo (`blockchains`, `tokens`, `users.wallets`, `transactions`); `cardanoConfig`; plugin Fastify; derivación de wallet + backfill | Un usuario existente tiene address Cardano y aparece en `/balance` | 2–3 d |
| **F3a — Costura** | Extracción de los pasos 7–10 de `makeTransaction` a `transferRouter` + `evmTransferExecutor` (§3.3). **Solo EVM, sin Cardano**: se mergea y se verifica que el flujo de producción no cambió | Transfers EVM y cross-chain siguen funcionando idénticos, con el router en el medio | 1–2 d |
| **F3b — Transfer** | `cardanoTransferService` detrás del router + `validateInputs` + resolución de destino por teléfono | `POST /make_transaction` mueve ADA real en Preprod entre dos usuarios | 3–4 d |
| **F4 — Estado y UX** | `checkTransactionStatus` para Cardano, `network_fee` persistido, notificaciones con explorer de Cardano, mensajes de error accionables (incluida la address a fondear) | Historial y notificaciones correctos de punta a punta | 2–3 d |
| **F5 — Hardening** | Límites por token/nivel, gate de PIN verificado en la rama nueva, clasificación de fallas de provider en logs, rate-limit del provider, suite live (§10.5), documentación en `.doc/` | Checklist de §13 completo | 2–3 d |
| **F6 — Dashboard** | Cambios del repo `front-local` (§8), en PR propio | Usuario ve su saldo de ADA, su address para fondear y puede enviar desde el dashboard | 4–6 d |
| **F7 — Native assets** | USDCx / USDM / USDA (§4.8): encoder multiasset, selección multidimensional, cambio con tokens, balance por activo, alta de tokens. **Validación en vivo requiere un CNT en Preprod** | Transferencia de una stablecoin nativa en Preprod, con su ADA adjunto | 5–8 d |

**Total estimado: 15–23 días de backend + 4–6 días de dashboard**, sin contar la decisión de
producto sobre fees (§4.4). F6 puede solaparse parcialmente con F4–F5 (el registry y los tipos del
front no dependen del backend).

Orden sugerido de merge, pensado para que el riesgo sobre el flujo EVM sea aislable:

1. **F0 + F1** en un PR propio: código puro, sin ningún efecto sobre el flujo existente. Riesgo cero
   de regresión, se puede mergear aunque Cardano nunca se habilite.
2. **F3a sola, en su propio PR**: es un refactor de EVM sin una línea de Cardano. Se revisa y se
   valida contra producción por separado, que es la única forma de saber que una regresión en el
   camino de plata —si la hay— vino de ahí y no de Cardano.
3. **F2 + F3b + F4 + F5** detrás del flag `CARDANO_ENABLED=false` por defecto.

---

## 10. Testing y prueba del flujo E2E

### 10.1 Qué hay hoy (y qué falta)

| Pieza | Estado |
|---|---|
| Runner | Vitest, `pool: 'forks'`, `maxWorkers: 1`, sin paralelismo de archivos |
| Base de datos | **Mongo real en memoria** (`mongodb-memory-server` 7.0.14), colecciones vaciadas en cada `beforeEach` |
| Logger | mockeado globalmente en `test/setupTests.ts` |
| Tests de controller | **prácticamente inexistentes** — `test/controllers/swapController.test.ts` es un placeholder (`expect(1 + 1).toBe(2)`) |
| Harness HTTP | **no existe** |

**Bloqueante para cualquier E2E:** `startServer()` (`src/config/server.ts:21`) construye el servidor
**y hace `listen()` en la misma función** (línea 50). Para poder usar `fastify.inject()` hay que
partirla:

```ts
export async function buildServer(): Promise<FastifyInstance> { /* todo menos listen() */ }
export async function startServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  await server.listen({ port: PORT, host: '0.0.0.0' });
  return server;
}
```

Es un refactor chico y sin riesgo, pero **es la puerta de entrada de todo el testing de flujo del
repo**, no solo de Cardano. Va en F0 para que esté disponible desde el principio.

### 10.2 Estrategia en tres niveles

```
 nivel 1  unitarios puros        sin red, sin Mongo         ~90% de los casos borde     CI: siempre
 nivel 2  E2E con provider fake  Mongo en memoria + inject  el flujo completo           CI: siempre
 nivel 3  live contra Preprod    red real, wallet fondeada  que la cadena acepte la tx  manual/nightly
```

El nivel 2 es el que responde tu pregunta: **permite probar el flujo de punta a punta sin red, sin
fondos y sin esperar bloques**, con Mongo real. El nivel 3 existe porque el nivel 2 no puede probar
lo único que importa de verdad — que el nodo acepte los bytes que armamos.

### 10.3 Nivel 1 — unitarios (sin red, sin base)

- **Address:** vectores conocidos CIP-19; rechazo de pubkey que no mide 32 bytes (una clave
  secp256k1 comprimida mide 33 y produciría una address plausible que nadie puede gastar).
- **Decode:** checksum inválido, prefijo desconocido, largo de payload que no corresponde al tipo,
  desacuerdo entre prefijo y nibble de red del header, mainnet en instancia testnet, base address
  (tipo 0) aceptada como destino.
- **Builder:** el fee converge; `Σinputs = monto + fee + cambio` **siempre**; cambio dust va al fee;
  monto por debajo de min-ADA se rechaza; fondos insuficientes se rechaza; tx too large se rechaza;
  selección determinística ante UTxOs de igual valor; UTxO con native assets nunca se selecciona.
- **Encoder:** el tx id de un body es reproducible byte a byte (CBOR canónico).
- **Signer:** la clave Cardano de un usuario **nunca** coincide con su clave EVM — test explícito de
  separación de dominio (§4.2). Y la derivación es estable: misma entrada, misma address, siempre.

Todo esto no necesita Mongo ni Fastify: son funciones puras con UTxOs fabricados. Es donde viven los
casos borde que en una red real habría que provocar a mano.

### 10.4 Nivel 2 — E2E con provider fake (el harness principal)

**Piezas a construir:**

```
test/helpers/
  buildTestServer.ts        # buildServer() + inject, con auth de test
  seedCardano.ts            # upsert de blockchains + tokens + usuarios de prueba
  fakeBlockfrost.ts         # implementa la interfaz del cliente, en memoria
```

**`fakeBlockfrost.ts` es la pieza clave.** Un set de UTxOs en memoria + protocol params fijos + un
tip que avanza cuando el test lo pide. `submit()` valida el CBOR, guarda la tx y devuelve el id.
Permite provocar deterministicamente lo que en la red real es casi imposible de arreglar a demanda:

- fondos insuficientes / justo al límite del fee
- cambio dust
- 429 (rate limit) y 5xx del provider
- **timeout en submit con la tx efectivamente en cadena** ← el caso crítico de §4.5, imposible de
  provocar contra Preprod
- timeout en submit con la tx **no** en cadena
- TTL vencido

**Inyección:** el `cardanoTransferService` debe recibir el cliente por constructor/parámetro, no
importarlo como singleton. Si no, el fake solo se puede meter con `vi.mock`, que acopla los tests a
la ruta del módulo.

**Casos E2E vía `fastify.inject()` sobre `POST /make_transaction/`:**

| # | Caso | Resultado esperado |
|---|---|---|
| 1 | transfer ADA entre dos usuarios de prueba | 200, tx persistida con `chain_id` Cardano, `network_fee` > 0, notificaciones a ambos |
| 2 | transfer a address bech32 externa (base address, tipo 0) | 200, aceptada |
| 3 | transfer a teléfono de un usuario **sin** wallet de Cardano | address derivada on-demand, transfer OK (§6.1) |
| 4 | saldo insuficiente | **el mensaje incluye la address a fondear** |
| 5 | address de **mainnet** en instancia Preprod | rechazo **antes de firmar** |
| 6 | address con un typo (checksum roto) | rechazo antes de firmar |
| 7 | monto por debajo de min-ADA | rechazo con el mínimo explícito en el mensaje |
| 8 | dos transfers concurrentes del mismo usuario | el segundo pega contra el lock (§6.2) |
| 9 | PIN no verificado | gate de seguridad bloquea, igual que en EVM |
| 10 | límite diario / de monto excedido | mismo comportamiento que EVM (verifica que la rama nueva no lo saltea) |
| 11 | timeout de submit + tx en cadena | operación **exitosa**, sin reenvío |
| 12 | timeout de submit + tx ausente | fallo declarado como seguro de reintentar |
| 13 | `CARDANO_ENABLED=false` | la ruta responde "red no disponible", y **el flujo EVM no cambia** |

**Test de no-regresión obligatorio para F3a:** el mismo set de casos EVM ejecutado antes y después
de la extracción del `transferRouter`. Es lo que convierte "moví el código" en una afirmación
verificada.

### 10.5 Nivel 3 — live contra Preprod

Suite aparte, **fuera del CI por defecto**, gateada por variable:

```bash
CARDANO_LIVE_TESTS=true CARDANO_TEST_MNEMONIC_PHONE=+54900000001 bun test test/live/
```

Requiere una wallet de test fondeada desde el faucet de Preprod. Cubre lo único que el fake no
puede: que el nodo acepte los bytes. Ciclo mínimo — derivar address → leer UTxOs reales → armar →
firmar → submit → poll hasta confirmación → verificar el fee real contra el calculado.

Por qué no va en CI: es lento (bloques de ~20s), consume fondos, depende de un tercero y de rate
limits, y falla por razones que no son del código. Se corre a mano antes de cada release y,
opcionalmente, en un nightly cuyo rojo **no bloquea** merges.

### 10.6 Cómo probar el flujo a mano (checklist de QA)

1. Levantar el backend con `CARDANO_ENABLED=true` y un `CARDANO_BLOCKFROST_PROJECT_ID` de Preprod.
2. Correr los seeds de §5.6.
3. `GET /balance/{address}` → debe aparecer la fila de ADA en 0.
4. Fondear la address desde el faucet de Preprod; esperar 3 confirmaciones (~1 min).
5. `GET /balance/...` de nuevo → saldo visible.
6. `POST /make_transaction/` con `{ to: "<addr_test1…>", token: "ADA", amount: "2", network: "cardano" }`.
7. Verificar: tx id en `preprod.cardanoscan.io`, registro en `transactions` con `network_fee`,
   notificación recibida, y `GET /transaction/{id}/status` pasando de `pending` a `completed`.

### 10.7 Estimación

**+3–4 días**, repartidos: `buildServer()` y `fakeBlockfrost` en F0/F1, el grueso de los E2E dentro
de F3b, y la suite live en F4. Ya está contemplado dentro de las estimaciones por fase de §9 salvo
el harness HTTP, que es trabajo nuevo que el repo no tenía.

---

## 11. Riesgos y deuda declarada

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R1 | **El usuario paga el fee** — rompe la premisa "el usuario nunca ve gas" del producto | Alto, de producto | Decisión explícita §4.4; V1 user-funded con mensaje accionable, V2 subsidio |
| R2 | `chain_id` sintético irreversible una vez escrito | Medio | Fijarlo antes del primer deploy con datos reales |
| R3 | Ed25519 in-process (sin HSM/gateway) | Medio, de seguridad | Es el posture actual del B2C, no una regresión; HKDF con separación de dominio; documentarlo como deuda consciente |
| R4 | Blockfrost como tercero: 429 / 5xx / timeouts | Medio | Clasificación de fallas + resolución de submit por `statusOf`, nunca reenvío |
| R5 | Min-ADA (~1 ADA) hace imposibles los montos chicos | Medio, de producto | Límite mínimo en `tokens.operations_limits` + mensaje claro |
| R6 | Fragmentación de UTxOs (selección largest-first) sube el fee con el tiempo | Bajo | Aceptado en V1; V2 puede consolidar |
| R7 | Solo ADA: los UTxOs con native assets quedan sin gastar | Bajo | Declarado; se informan aparte en el balance |
| R8 | Ed25519 en Bun podría comportarse distinto que en Node | Bajo pero bloqueante | Se resuelve en F0; fallback `@noble/curves` |
| R9 | Sin staking, el ADA de los usuarios no genera rewards | Bajo | **Mitigado en el diseño:** emitimos base addresses con la stake credential sin registrar, así que habilitarlo es una transacción (2 ADA/usuario, reembolsables) y no una migración de addresses |

---

## 12. Decisiones pendientes (requieren definición de producto)

1. **Fees (§4.4):** ¿V1 con usuario fondeándose desde el faucet, o se arranca directo con wallet de
   subsidio? *Recomendación: V1 user-funded; el builder queda preparado para el segundo witness.*
2. **`chain_id` sintético (§4.1):** ¿se acepta `900000000001`? *Recomendación: sí, y congelarlo.*
3. **Alta de wallet:** ¿se deriva la address de Cardano para **todos** los usuarios, o solo bajo
   demanda? *Recomendación: solo bajo demanda + backfill, para no inflar documentos de usuarios que
   nunca van a usar Cardano.*
4. **Envío por teléfono a un usuario sin Cardano:** ¿se le deriva la address y se le envía igual
   (queda con fondos antes de "activar" Cardano)? *Recomendación: sí — es gratis y es la ventaja
   real del modelo de address de Cardano.*
5. **Fee de ChatterPay en Cardano:** V1 propone `0`. ¿Se cobra en el futuro, y en ADA o descontado
   del monto?
6. **Mainnet:** ¿entra en el roadmap con fecha, o Preprod es el alcance cerrado por ahora?
7. **Depósitos externos (§5.8):** en V1 un usuario que recibe ADA desde afuera no recibe
   notificación. ¿Se acepta para el piloto, o hay que construir el ingestor de Cardano ahora?
   *Recomendación: aceptar en V1 — el saldo se ve bien igual; el ingestor es un proyecto propio.*
8. **Dashboard multi-wallet (§8.4):** ¿portfolio unificado o selector de red?
   *Recomendación: portfolio unificado para V1.*
9. **Native assets (§4.8):** ¿USDCx / USDM / USDA entran como V2 después de que ADA esté en
   producción, o hay que adelantarlos? *Recomendación: después — comparten todo el riesgo de V1 más
   el suyo propio, y el problema de fondeo se vuelve más duro (un usuario con stablecoins y sin ADA
   no puede mover nada).*
10. **¿Qué es exactamente USDCx?** El USDC puenteado a Cardano circula bajo más de un emisor según
    el puente. Hay que definir el activo antes que el ticker.

---

## 13. Checklist de "listo"

- [ ] Un usuario nuevo y uno existente tienen address `addr_test1…` derivada y persistida
- [ ] `/balance` muestra ADA con su valor en USD/ARS
- [ ] `make_transaction` mueve ADA real en Preprod, a address externa y a otro usuario por teléfono
- [ ] El fee de red queda registrado en `transactions.network_fee`
- [ ] Saldo insuficiente devuelve un mensaje que **incluye la address a fondear**
- [ ] Una address de mainnet o con typo se rechaza **antes** de firmar
- [ ] Un timeout de submit se resuelve consultando el tx id, nunca reenviando
- [ ] `checkTransactionStatus` resuelve transacciones de Cardano
- [ ] `CARDANO_ENABLED=false` deja el sistema exactamente como está hoy (sin regresiones EVM)
- [ ] Los 13 casos E2E de §10.4 pasan con el provider fake, en CI
- [ ] El set de no-regresión EVM pasa idéntico antes y después de F3a
- [ ] La suite live (§10.5) corrió al menos una vez contra Preprod antes del release
- [ ] Dashboard: el usuario ve su saldo de ADA, puede copiar su address para fondearla, y el link
      al explorer de una tx de Cardano abre la transacción correcta (`/transaction/`, no `/tx/`)
- [ ] Las tres traducciones (`en`/`es`/`br`) completas, sin claves crudas visibles
- [ ] Documentación en `.doc/`
