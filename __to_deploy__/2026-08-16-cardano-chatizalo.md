# Cardano en chatizalo: `chat_functions`, templates y prompt del bot

**Fecha:** 2026-08-16
**Motivo:** que el bot sepa que existe Cardano — hoy el backend ya responde, pero ninguna
herramienta lo ofrece y el prompt no lo nombra
**Depende de:** [la configuración de base y entorno](./2026-08-16-cardano-config-entornos.md)
(aplicar primero, en el ambiente que corresponda)

## Bases involucradas

| Ambiente | Base de chatizalo | `Origin` | Host del backend |
|---|---|---|---|
| dev / test | `chatterpay-develop` | `dev.chatizalo` | `https://dev.back.chatterpay.net` |
| producción | `chatterpay` | `chatizalo` | `https://back.chatterpay.net` |

Los documentos de abajo están escritos para **dev**. Para producción cambian tres cosas y nada más:
el host de `api_config.url`, el header `Origin`, y la lista de tickers del `enum`.

---

## 1. `chat_functions` — qué cambia realmente

**Hace falta un solo cambio: actualizar `transferir_fondos`.** No hay ninguna herramienta nueva que
dar de alta, y conviene decir por qué, porque la primera intuición es la contraria:

| Necesidad | Cómo se resuelve | ¿Tool nueva? |
|---|---|---|
| Mostrar la address de Cardano | `obtener_wallet` → `POST /create_wallet` ya devuelve `cardanoAddress` y resuelve `[CARDANO_ADDRESS]` en el template | ❌ — cambia el **template** (§3) |
| Ver saldo de ADA | `obtener_balance` → el backend agrega las filas de Cardano al mismo `balances` / `totals` | ❌ |
| Transferir ADA | `transferir_fondos` → `POST /make_transaction`, que rutea por familia | ✅ **actualizar** (§2) |
| Estado de una transacción | ya resuelto contra la cadena por `chain_id`, sin tool nueva | ❌ |
| Swap / AAVE / NFT / Polymarket en Cardano | **no existen** — el prompt tiene que decirlo (§4) | ❌ |

El backend rutea a Cardano si se cumple **cualquiera** de estas tres (`isCardanoTransferRequest`):

1. `network` empieza con `"cardano"`, o
2. `chain_id` es el chain id de Cardano, o
3. el `token` es un ticker que existe en el catálogo de Cardano **y no existe en la red EVM activa**.

La regla 3 es la que protege lo que ya funciona: **un ticker que también existe en EVM se queda en
EVM**. Si mañana se lista `USDM` en Scroll, una transferencia de USDM no se desvía a Cardano de
prepo. Por eso el prompt manda `network: "cardano"` explícito y no confía en el ticker.

---

## 2. `transferir_fondos` — documento actualizado

Cambian tres cosas respecto del documento actual: el `enum` de `token`, la descripción de `to` y la
descripción de `network`. **`preconditions` no se toca** — el gate de PIN aplica igual a Cardano,
porque el controller de Cardano llama a `securityService.getOperationGate` como el de EVM.

### 2.1 dev — `chatterpay-develop`

```js
// mongosh "mongodb://<host>:27017/chatterpay-develop"
db.chat_functions.updateOne(
  { name: 'transferir_fondos' },
  {
    $set: {
      'model_config.function.description':
        'This tool allows users to transfer funds from their wallet to a contact or wallet they provide. ' +
        'They can transfer to a phone number (same-chain), to a wallet address on another EVM/Solana/Bitcoin network (cross-chain), ' +
        'or to a Cardano address on the Cardano network. They need to specify the amount, recipient, token type, ' +
        'and optionally the destination network and token.',

      'model_config.function.parameters.properties.to.description':
        'Recipient: a wa_id (phone number) for same-chain transfers, a wallet address for cross-chain transfers ' +
        '(EVM 0x address, Solana base58 address, or Bitcoin address), or a Cardano bech32 address ' +
        "(starts with 'addr1' on mainnet, 'addr_test1' on testnet) when the network is Cardano.",

      'model_config.function.parameters.properties.token.enum': ['USDT', 'WETH', 'ADA'],

      'model_config.function.parameters.properties.network.description':
        "Destination network. Use 'cardano' when the user is sending ADA or any Cardano native token; " +
        "in that case the transfer is same-chain on Cardano, not a bridge. For cross-chain EVM/Solana/Bitcoin " +
        "transfers use the chain key (e.g., 'eth', 'arb', 'pol', 'sol', 'btc'). Omit for same-chain EVM transfers.",

      'api_config.parameters.network': 'str'
    }
  }
)
```

`api_config.parameters.network` ya existe con el valor `'str'`; se repite acá sólo para que el
comando sea seguro de correr en una base donde no esté.

### 2.2 producción — `chatterpay`

Idéntico, con el `enum` extendido a las stablecoins que se hayan dado de alta en la base de prod
(§2.3 de [config-entornos](./2026-08-16-cardano-config-entornos.md)):

```js
// mongosh "mongodb://<host>:27017/chatterpay"
'model_config.function.parameters.properties.token.enum': ['USDT', 'WETH', 'ADA', 'USDCx', 'USDM', 'USDA']
```

> ⚠️ **El `enum` tiene que coincidir con `tokens.symbol`, no con lo que ve el usuario.** El backend
> resuelve la transferencia por `symbol`. Si el catálogo dice `USDCx` y el `enum` dice `USDC`, el
> modelo va a mandar `USDC`, el catálogo de Cardano no lo va a encontrar, y —peor— si existe un USDC
> en la red EVM activa, la transferencia **se ejecuta en EVM** sin que nadie note el desvío.
>
> Si se quiere que el usuario lea "USDC", eso va en `tokens.display_symbol` y en el prompt, nunca en
> el `enum`.

### 2.3 Verificación

```js
db.chat_functions.findOne(
  { name: 'transferir_fondos' },
  { 'model_config.function.parameters.properties.token.enum': 1, _id: 0 }
)
```

### 2.4 Rollback

```js
db.chat_functions.updateOne(
  { name: 'transferir_fondos' },
  { $set: { 'model_config.function.parameters.properties.token.enum': ['USDT', 'WETH'] } }
)
```

Volver el `enum` alcanza: sin `ADA` en la lista el modelo no la ofrece, y el resto de los textos son
descripciones sin efecto operativo.

---

## 3. `templates` — mostrar la address de Cardano al crear la wallet

Esto va en la **base del backend** (`chatterpay-dev` / la de prod), no en la de chatizalo.

`createWallet` resuelve `[CARDANO_ADDRESS]` en el mensaje de `wallet_creation`. El placeholder es
opcional: si el template no lo menciona, no pasa nada. Hoy no lo menciona, así que la address de
Cardano **no se le muestra al usuario en ningún lado**.

```js
// mongosh "mongodb://<host>:27017/<base-backend>"
db.templates.updateOne(
  {},
  {
    $set: {
      'notifications.wallet_creation.message.es':
        '¡Tu wallet fue creada y vinculada a tu número de WhatsApp con éxito! 🎉\n' +
        'Tu dirección de wallet es: [WALLET_ADDRESS].\n' +
        'Tu dirección de Cardano es: [CARDANO_ADDRESS].\n' +
        '\n' +
        'Ahora puedes enviar y recibir fondos fácilmente por WhatsApp con ChatterPay. \n' +
        '\n' +
        '⚠️ Importante: Si planeas enviar crypto a esta wallet desde una plataforma externa (como un wallet o exchange), asegúrate de usar la red [NETWORK_NAME] y verifica dos veces la dirección. Para enviar ADA o tokens de Cardano, usá la dirección de Cardano y la red Cardano. ChatterPay no puede revertir transacciones incorrectas hechas fuera de nuestra app, como cuando seleccionas la red equivocada o escribes mal la dirección.\n',

      'notifications.wallet_creation.message.en':
        'Your wallet was successfully created and linked to your WhatsApp number! 🎉  \n' +
        'Your wallet address is: [WALLET_ADDRESS].\n' +
        'Your Cardano address is: [CARDANO_ADDRESS].\n' +
        '\n' +
        'You can now easily send and receive funds via WhatsApp with ChatterPay.\n' +
        '\n' +
        '⚠️ Important: If you plan to send crypto to this wallet from an external platform (like another wallet or exchange), make sure to use the [NETWORK_NAME] network and double-check the address. To send ADA or Cardano tokens, use the Cardano address and the Cardano network. ChatterPay cannot reverse incorrect transactions made outside our app — like using the wrong network or mistyping the address.\n',

      'notifications.wallet_creation.message.pt':
        'Sua wallet foi criada e vinculada ao seu número do WhatsApp com sucesso! 🎉  \n' +
        'O endereço da sua wallet é: [WALLET_ADDRESS].\n' +
        'O seu endereço Cardano é: [CARDANO_ADDRESS].\n' +
        '\n' +
        'Agora você pode enviar e receber fundos facilmente pelo WhatsApp com a ChatterPay.\n' +
        '\n' +
        '⚠️ Importante: Se for enviar cripto para esta wallet a partir de uma plataforma externa (como uma carteira ou exchange), certifique-se de usar a rede [NETWORK_NAME] e verifique o endereço duas vezes. Para enviar ADA ou tokens Cardano, use o endereço Cardano e a rede Cardano. A ChatterPay não pode reverter transações incorretas feitas fora do nosso app — como usar a rede errada ou digitar o endereço errado.\n'
    }
  }
)
```

> ⚠️ **Aplicar esto sólo donde Cardano esté encendido.** Con `CARDANO_ENABLED=false`,
> `cardanoAddress` viene vacío y el placeholder se reemplaza por nada: el mensaje queda con la línea
> "Tu dirección de Cardano es: ." Si el flag va a estar apagado un tiempo, este cambio va **después**
> de encenderlo, no antes.

**`deposit_info` sigue sin conocer Cardano.** `enviar_opciones_deposito` muestra sólo la red EVM: es
un cambio de código pendiente, no de datos.

---

## 4. Prompt del bot — `chat_modes.default.start_system_message`

**Documento:** `chatterpay-develop.chat_modes`, `_id = ObjectId("6a826fecaea24916eabb7129")`
**Campo:** `default.start_system_message`

El prompt actual tiene 1529 líneas y **no nombra Cardano ni una vez**. Con el `enum` actualizado el
modelo *podría* mandar ADA, pero sin estas reglas va a tratar Cardano como una red EVM más: ofrecer
swap, ofrecer el bridge de Layerswap, o mezclar la address `0x…` con la `addr1…`.

Los cambios son de dos tipos: **una sección nueva** (§4.1) y **cinco renglones existentes** (§4.2).

### 4.1 Sección nueva

Insertar dentro de `## Services`, **inmediatamente después de la sección `### SWAP`** y antes de
`### HOLD` (así queda pegada a la regla que la contradice, que es donde el modelo la va a necesitar):

```markdown
### CARDANO / ADA

* ChatterPay users have **two separate wallets**: an EVM wallet (address starts with `0x`) and a **Cardano wallet** (bech32 address, starts with `addr1` on mainnet and `addr_test1` on testnet). They are different addresses on different blockchains. The assistant must NEVER present one as the other, never mix them in the same instruction, and never suggest sending EVM tokens to the Cardano address or ADA to the `0x` address. Funds sent to the wrong address are unrecoverable.
* Both addresses are returned by the `obtener_wallet` tool. The assistant must never type, guess, complete, or reconstruct any address by itself — only the tools produce addresses.
* **Supported on Cardano: transfers only.** The user can send and receive ADA (and the Cardano stablecoins listed in the `transferir_fondos` tool, when available). Nothing else works on Cardano.
* **NOT supported on Cardano — never offer, and say so plainly if asked:** swaps, savings/interest (AAVE), NFT certificates, Polymarket, buying/selling with FIAT (onramp), and cross-chain bridge (Layerswap). Those are EVM-only features.
* **Cardano transfers are same-chain, never a bridge.** Sending ADA is NOT a cross-chain operation and must NEVER trigger the Layerswap CTA or the `enviar_deposito_otras_redes` tool. There is no bridge between the user's EVM wallet and their Cardano wallet: moving value between them is not something ChatterPay does.
* **How to call the transfer tool for Cardano:** call `transferir_fondos` with `token` set to the Cardano ticker (e.g. `ADA`) and `network` set to `cardano`. The `network` parameter must be the literal string `cardano` — never a chain key like `eth`, `arb`, `pol`, `sol` or `btc`, which mean cross-chain EVM/Solana/Bitcoin transfers.
* **Recipient (`to`) on Cardano:** a WhatsApp phone number (wa_id) of a ChatterPay user, or a Cardano bech32 address the user provides. An EVM `0x` address is NEVER a valid recipient for a Cardano transfer — if the user gives one together with ADA, the assistant must ask exactly one clarification question and must not call the tool.
* **Fees on Cardano are paid in ADA and are visible to the user**, unlike EVM transfers where ChatterPay covers the network cost. The exact fee is decided by the network at the moment of sending, so the assistant must never quote, estimate, or promise a specific fee amount.
* **Sending a Cardano token that is not ADA also requires ADA in the wallet**, because the network charges its fee in ADA and requires a minimum amount of ADA to accompany the token. A user with a token balance and zero ADA cannot send. If a transfer fails for insufficient funds, the backend message names the address to fund — the assistant must relay that message and must not invent a different explanation.
* **To deposit ADA from outside**, the user must send it to their Cardano address, on the Cardano network, from a wallet or exchange that supports Cardano. The assistant must not send the Layerswap link for this.
* **Incoming ADA deposits from outside ChatterPay are not detected yet**, so the user will not get an automatic notification for them. If the user says they sent ADA and saw no notification, the assistant must tell them to check their balance with `obtener_balance` rather than claim the deposit failed.
* Every general transfer rule still applies to Cardano without exception: the confirmation summary before calling the tool, the PIN verification gate, the daily and per-amount limits, and the no-guessing rule.
```

### 4.2 Renglones existentes a modificar

| Sección | Texto actual (fragmento) | Cambio |
|---|---|---|
| `### Knowledge` | `Basic concepts about Blockchain, Web3, Ethereum, EVM, and Arbitrum` | agregar `, and Cardano (UTxO model, native assets)` |
| `### Knowledge` | `Price of USDT, USDC, WETH, WBTC, SCR, wstETH, USX, StakedUSX, and USDQ` | agregar `, and ADA` |
| `### Skills` | `Check dollar, USDT, USDC, WETH, … and USDQ rates` | agregar `, and ADA` |
| `### Skills` | `Transfer funds to WhatsApp contacts` | agregar debajo: `* Transfer ADA and Cardano native tokens on the Cardano network` |
| `### Important Rules` | `The user can transfer USDT, USDC, WETH, WBTC, SCR, wstETH, USX, StakedUSX, or USDQ; make sure to send the correct token as indicated, without automatic changes.` | agregar `, or ADA (on Cardano)` antes del `;` |
| `### SWAP` | `Easily switch between USDT, USDC, WETH, …` | agregar al final del bullet: ` Swaps are EVM-only: ADA and Cardano tokens cannot be swapped.` |

> La línea de `### SWAP` es la más importante de las seis. Sin ella, un usuario con saldo en ADA que
> pida "cambiame ADA a USDT" recibe un intento de swap que no existe, y el modelo va a inventar una
> explicación cuando falle.

### 4.3 Cómo aplicarlo

El campo es un string largo; conviene editarlo con un script en vez de a mano.

```js
// mongosh "mongodb://<host>:27017/chatterpay-develop"
const id = ObjectId('6a826fecaea24916eabb7129');
const doc = db.chat_modes.findOne({ _id: id });
let p = doc.default.start_system_message;

// 1. backup, siempre — el campo no tiene historial
db.chat_modes_backup.insertOne({ ...doc, _id: undefined, backup_of: id, backup_date: new Date() });

// 2. insertar la sección nueva antes de '### HOLD'
const CARDANO_SECTION = `### CARDANO / ADA\n\n...` ; // el bloque de §4.1
if (!p.includes('### CARDANO / ADA')) {
  p = p.replace('### HOLD', CARDANO_SECTION + '\n### HOLD');
}

// 3. los seis renglones de §4.2, uno por uno, con replace exacto
// ...

db.chat_modes.updateOne({ _id: id }, { $set: { 'default.start_system_message': p } });
```

**Verificación:**

```js
const p = db.chat_modes.findOne({ _id: ObjectId('6a826fecaea24916eabb7129') }).default.start_system_message;
print(p.includes('### CARDANO / ADA'));   // true
print((p.match(/### HOLD/g) || []).length); // 1  — no se duplicó nada
print(p.length);
```

**Rollback:** restaurar `default.start_system_message` desde `chat_modes_backup`. Por eso el paso 1
no es opcional: el campo no tiene versionado y una corrida de `replace` que no matchea deja el prompt
a medias sin avisar.

En producción el documento de `chat_modes` es otro (base `chatterpay`); hay que ubicarlo por
contenido, no por este `_id`.

### 4.4 Después de aplicar — qué probar en el bot

| Prompt del usuario | Comportamiento esperado |
|---|---|
| "¿cuál es mi wallet?" | dos addresses, `0x…` y `addr…`, claramente separadas |
| "mandale 5 ADA a +54911…" | resumen de confirmación → PIN → `transferir_fondos` con `network: "cardano"` |
| "mandá 5 ADA a 0xabc…" | una pregunta de aclaración, **sin** llamar la tool |
| "cambiame ADA por USDT" | dice que no se puede, sin intentar el swap |
| "quiero depositar ADA" | la address de Cardano, **sin** el link de Layerswap |
| "mandá 10 USDT a +54911…" | sigue yendo por EVM, sin desvíos |

La última fila es la que hay que mirar con más atención: es la regresión posible de todo este
cambio.
