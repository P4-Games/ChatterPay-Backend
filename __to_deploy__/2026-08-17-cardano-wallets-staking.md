# Wallets de Cardano: qué quedó, y qué falta para activar staking

## Resumen

La wallet de Cardano de un usuario es una **base address (CIP-19 tipo 0)**: lleva una credencial de
pago **y** una de staking. La de staking está **escrita en la address y registrada en ninguna
parte**.

Eso significa dos cosas a la vez:

- **Hoy no hay staking.** No delega, no cobra rewards, no vota.
- **Activarlo después es una transacción por wallet, no una address nueva.** No hay migración, no
  hay que recrear wallets, no hay fondos que mover.

Esa es toda la razón por la que la address tiene esta forma. La alternativa —una *enterprise
address*, más corta y con una sola credencial— habría sido funcionalmente idéntica en el día a día y
habría convertido el staking en una migración de todas las wallets fondeadas.

> **Decisión tomada el 2026-08-17, antes de emitir una sola address.** Se verificó primero:
> `users` con wallet de Cardano = **0**, transacciones en la red de Cardano = **0**. Por eso el
> cambio no costó nada. Cada día que hubiera pasado con wallets fondeadas lo habría encarecido.

---

# Parte 1 — lo que quedó

## 1.1 Forma de la address

```
addr1q…  =  header byte  ‖  blake2b-224(payment pubkey)  ‖  blake2b-224(stake pubkey)
            1 byte          28 bytes                        28 bytes      = 57 bytes
```

El header lleva el tipo en el nibble alto (`0` = base) y la red en el bajo (`0` testnet, `1`
mainnet). El HRP bech32 es `addr_test` o `addr`.

| | Preprod | mainnet |
|---|---|---|
| Prefijo | `addr_test1q…` | `addr1q…` |
| Header | `0x00` | `0x01` |
| Largo | ~108 chars | ~103 chars |

**El tipo de address es el mismo en las dos redes.** Lo único que cambia entre Preprod y mainnet es
el nibble de red y el prefijo.

## 1.2 De dónde salen las dos claves

Las dos se derivan del mismo master secret por HKDF-SHA256, con `info` distinto:

```
payment : HKDF( ikm  = SEED_INTERNAL_SALT ‖ env ‖ phone,
                salt = 'chatterpay:cardano:<network>',
                info = 'ed25519:v1:<chainId>' )          -> seed Ed25519 de pago
stake   : ... mismo ikm y salt,
                info = 'ed25519:stake:v1:<chainId>' )    -> seed Ed25519 de staking
```

**Una stake key por usuario**, no una compartida por todo ChatterPay. Una credencial única para todos
habría costado un solo depósito de 2 ADA en total en vez de uno por usuario, pero deja **todas las
wallets del producto agrupadas y enumerables on-chain** por esa credencial compartida, y obliga a
repartir los rewards del agregado por contabilidad off-chain. Con una por usuario, la address sigue
siendo función pura de las claves de ese usuario.

**La stake key no firma nada hoy.** Una transferencia se autoriza con la payment key sola. El signer
deliberadamente **no expone** una firma con la stake key: no hay nada que firmar con ella hasta que
haya certificados, y una capacidad de firma sin uso es superficie de ataque sin contrapartida.

## 1.3 Qué se guarda en `users.wallets[]`

```json
{
  "wallet_proxy": "addr_test1q…",
  "wallet_eoa": "addr_test1q…",
  "created_with_chatterpay_proxy_address": "",
  "created_with_factory_address": "",
  "chain_id": 900000000001,
  "status": "active",
  "address_type": "cardano_base",
  "cardano_public_key": "0x…",
  "cardano_stake_public_key": "0x…"
}
```

`wallet_proxy` y `wallet_eoa` llevan la misma address bech32 a propósito: no hay proxy ni EOA acá,
pero todos los lectores existentes (bot, dashboard, balance, notificaciones) buscan `wallet_proxy`, y
darles una address que puedan mostrar es lo que evita que este cambio se propague a todos ellos.

`cardano_stake_public_key` se guarda aunque no firme nada: es la mitad de lo que la address hashea, y
lo que registre o delegue esa credencial más adelante va a necesitar **la clave**, no sólo el hash
que la address ya carga.

## 1.4 Cómo se crea, y qué cuesta

**Costo on-chain: cero.** No hay deploy de contrato, ni registro de cuenta, ni gas, ni depósito
mínimo, ni rent. Una address de Cardano no necesita existir en la cadena para recibir: aparece cuando
le llega el primer UTxO. El costo total de provisionar es **una escritura en Mongo**.

Es lo contrario del lado EVM, donde la address también es contrafáctica pero el proxy ERC-4337 se
despliega en la primera operación con gas del paymaster, y además se registra en Alchemy.

| Camino | Qué hace | ¿Escribe en `users.wallets[]`? |
|---|---|---|
| `POST /create_wallet` | `provisionCardanoWallet` → `ensureCardanoWalletForUser` | ✅ si falta |
| `POST /make_transaction` (emisor) | `ensureCardanoWalletForUser(fromUser)` | ✅ si falta |
| `POST /make_transaction` (destino por teléfono) | `getOrCreateCardanoWallet` — **crea el usuario** si el teléfono no está registrado, con wallet de Cardano y **sin wallet EVM** | ✅ |
| `GET /balance…` | `deriveCardanoAccount` — deriva y muestra | ❌ no escribe |

Todo idempotente: **la derivación es la fuente de verdad y la base es un caché de ella**. Si la fila
guardada no coincide con lo que las claves derivan, el código corta con `CARDANO_ADDRESS_MISMATCH` en
vez de seguir — significaría que la semilla cambió y que los fondos están en una address que este
deployment no puede firmar.

> **No hace falta backfill.** Un usuario existente obtiene su address la primera vez que pregunta por
> su wallet o transfiere. Un destinatario que nunca usó Cardano igual tiene address, así que
> transferir a un teléfono funciona la primera vez.

## 1.5 El costo que sí tuvo emitir base

La address pasó de 29 a 57 bytes. El min-ADA de un output se cobra por tamaño
(`(overhead + bytes) × coinsPerUtxoByte`, con `coinsPerUtxoByte = 4310`), así que:

| | enterprise (29 b) | base (57 b) | diferencia |
|---|---|---|---|
| min-ADA, output sin assets | 0.849070 ADA | 0.969750 ADA | **+0.120680** |
| min-ADA, output con 1 native asset | 1.034400 ADA | 1.155080 ADA | +0.120680 |
| fee de red, 1 input / 2 outputs | 0.165941 ADA | 0.167173 ADA | +0.001232 |

**+0.12 ADA por output.** Con ADA a USD 0,177 son ~2 centavos de dólar. El builder ya calculaba el
min-ADA dinámicamente, así que no hubo que tocar nada de esa matemática.

## 1.6 Verificación

```js
// La forma quedó bien: tipo 0 y las dos claves
db.users.findOne(
  { 'wallets.chain_id': 900000000001 },
  { 'wallets.$': 1, _id: 0 }
)
// -> address_type: 'cardano_base'
//    cardano_public_key y cardano_stake_public_key, distintos entre sí
```

```bash
# La address arranca con addr_test1q (Preprod) o addr1q (mainnet), NO con addr1v
```

Suites relacionadas:

```bash
bunx vitest run test/services/cardano/cardanoAddressService.test.ts   # vectores CIP-19 tipo 00
bunx vitest run test/services/cardano/cardanoSignerService.test.ts    # dos claves, independientes
bunx vitest run test/services/cardano/cardanoTxService.test.ts        # min-ADA y fee de base addr
```

`baseAddress()` se testea contra los **vectores oficiales de CIP-19**, no contra su propia salida: un
round-trip sólo prueba que el código coincide consigo mismo, y el error que importa acá —el nibble
del tipo del lado equivocado, la red invertida— round-trippea perfecto produciendo addresses que
nadie puede gastar.

---

# Parte 2 — qué falta para activar staking

Nada de esto está implementado. Es el trabajo pendiente, y ahora es **opcional y reversible**: se
puede hacer cuando se quiera, sobre las wallets que ya existan.

## 2.1 Qué es delegar, en Cardano

Importante para dimensionar la decisión: **delegar es no-custodial y no bloquea nada**. El ADA nunca
se mueve, sigue en los UTxOs del usuario, sigue líquido y gastable mientras está delegado. No hay
período de lock-up ni de unbonding. Rinde ~2–3% anual.

Lo único que sí queda inmovilizado es el **depósito de la stake key**: 2 ADA, reembolsables.

## 2.2 Los pasos, por wallet

1. **Registrar la stake credential.** Una transacción con un certificado de registro. Paga un
   depósito de 2 ADA (`key_deposit = 2000000` lovelace, verificado contra los parámetros de la época
   649 de mainnet).
2. **Delegar a un stake pool.** Certificado de delegación, con el pool id.
3. **Delegar el voto a un DRep.** Desde la era Conway, **para poder retirar rewards** la credencial
   tiene que estar delegada a un DRep. Alcanza con `abstain`.
4. **Esperar.** El primer reward tarda ~4 épocas: la delegación entra en el snapshot al cierre de la
   época en curso, queda activa 2 épocas después, y el reward de esa época se paga al inicio de la
   siguiente a la siguiente. Con épocas de 5 días son **~15–20 días** hasta el primer reward.
5. **Retirar los rewards.** No caen solos en un UTxO: se acumulan en una **reward account** aparte y
   hay que retirarlos con otra transacción.

Los pasos 1, 2 y 3 se pueden meter **en una sola transacción**: la era Conway define certificados
combinados que registran y delegan a pool y a DRep de una. Antes de implementar, chequear la CDDL de
la era vigente — los tipos de certificado cambiaron entre Babbage y Conway y conviven variantes
viejas y nuevas.

> Corrección respecto de lo que se dijo antes en
> [config-entornos §3.1](./2026-08-16-cardano-config-entornos.md): el primer reward no llega a las
> ~2 épocas sino a las ~4. Dos épocas es cuando la delegación queda *activa*, no cuando paga.

## 2.3 Costos reales

Con `key_deposit = 2 ADA`, `minFeeA = 44`, `minFeeB = 155381` y ADA a **USD 0,177**:

| Concepto | ADA | USD | ¿Vuelve? |
|---|---|---|---|
| Depósito de la stake key | 2.000000 | $0,354 | ✅ al des-registrar |
| Fee de la tx de registro + delegación | ~0.18 | $0,032 | ❌ |
| Fee de cada tx de retiro de rewards | ~0.17 | $0,030 | ❌ |

**Por usuario.** Agregado:

| Usuarios | Depósitos (inmovilizados) | Fees (gastados) |
|---|---|---|
| 100 | 200 ADA · $35 | ~18 ADA · $3 |
| 1.000 | 2.000 ADA · $354 | ~180 ADA · $32 |
| 10.000 | 20.000 ADA · $3.540 | ~1.800 ADA · $319 |

### El número que decide la política

Con un retiro por año, los fees no reembolsables son ~0.35 ADA anuales por usuario. Al 3%:

```
0.35 ADA / 0.03  ≈  12 ADA
```

**Por debajo de ~12 ADA de saldo, staquear le cuesta plata al usuario.** Y eso ignorando que el
depósito de 2 ADA le sale del saldo: alguien con 10 ADA vería el 20% de su plata inmovilizada para
perder dinero neto.

> ⚠️ **La pregunta no es cuánto le cuesta a ChatterPay, es de dónde salen esos 2 ADA.** El depósito
> se descuenta de los UTxOs de la wallet. Un usuario con menos de ~2.2 ADA **no puede registrarse**,
> y a uno con 5 ADA el registro le come casi la mitad del saldo disponible.

## 2.4 Decisiones de producto, antes de escribir código

| Decisión | Opciones | Nota |
|---|---|---|
| **¿Quién paga el depósito?** | el usuario (sale de su saldo) / ChatterPay (transferencia previa) | Si paga ChatterPay, son ~$0,35 por usuario, recuperables — pero hay que financiar cada wallet antes de registrarla |
| **¿Automático u opt-in?** | todos al crear la wallet / sólo quien lo pide / sólo por encima de un saldo mínimo | Automático sobre saldos chicos destruye valor (§2.3). Un umbral de ~50–100 ADA es lo que tiene sentido económico |
| **¿Qué pool?** | uno propio / uno de terceros / rotación | Delegar todo a un pool concentra riesgo y stake. La saturación (~64M ADA) no es un problema a esta escala |
| **¿Los rewards son del usuario o del producto?** | — | Con una stake key por usuario los rewards caen en **su** reward account, así que la respuesta por defecto es "del usuario". Cobrar una comisión sería una decisión aparte y explícita |
| **¿Qué DRep?** | `abstain` / uno concreto | `abstain` es lo neutral y desbloquea el retiro. Votar en nombre del usuario es otra conversación |

## 2.5 Trabajo de código

Nada de esto existe hoy:

| Pieza | Dónde | Detalle |
|---|---|---|
| Firma con la stake key | `cardanoSignerService` | Hoy expone `sign()` sólo con la key de pago. Los certificados necesitan un witness de la stake key |
| Armado de certificados | `cardanoTxService` | Registro, delegación a pool, delegación a DRep. Van en el campo `certificates` del cuerpo de la tx |
| Reward address | `cardanoAddressService` | `stake1…` / `stake_test1…`: header tipo 14 + la stake credential. Es la clave contra la que se consultan y se retiran los rewards |
| Retiro de rewards | `cardanoTxService` | Campo `withdrawals` del cuerpo, más witness de la stake key |
| Estado de la cuenta | `cardanoProviderService` | Koios `POST /account_info` con la stake address: si está registrada, a qué pool delega, cuánto tiene sin retirar |
| Mostrar rewards | `cardanoBalanceService` | **Los rewards no están en los UTxOs.** El balance actual suma UTxOs, así que hoy no los mostraría. Hay que sumar la reward account aparte, o el usuario no ve lo que ganó |
| Orquestación | nuevo servicio | Elegir cuándo registrar, reintentos, y no dejar una wallet registrada a medias |

> El de `cardanoBalanceService` es el que más fácil se pasa por alto: se puede implementar todo el
> staking, que funcione, y que el usuario **no vea un peso** de lo que ganó porque el balance lee
> UTxOs y los rewards no son un UTxO.

## 2.6 Cómo se revierte

Des-registrar la stake credential con un certificado de baja: **devuelve los 2 ADA** y corta la
delegación. Cuesta el fee de una transacción.

La address **no cambia** al des-registrar, igual que no cambia al registrar. Es exactamente la
propiedad por la que se eligió esta forma: registrar y des-registrar son transacciones sobre la
misma wallet.

---

# Parte 3 — lo que este documento no cubre

- **No hay backfill de wallets** y no hace falta (§1.4).
- **Los depósitos externos no se detectan.** El ingestor es EVM-only (Alchemy / TheGraph): un usuario
  que reciba ADA desde afuera no recibe notificación.
- **`deposit_info` no conoce Cardano.** El único lugar donde hoy aparece la address de Cardano es el
  template de `wallet_creation` — ver [chatizalo §3](./2026-08-16-cardano-chatizalo.md).
- **No hay bridge EVM ↔ Cardano.** Li.Fi no soporta Cardano y no hay configuración que lo habilite;
  ver [config-entornos, Parte 4](./2026-08-16-cardano-config-entornos.md).
