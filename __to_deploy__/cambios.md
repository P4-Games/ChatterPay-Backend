# Cardano — checklist de cambios a aplicar

## GCP Changes (backend)

**dev**

- Add variable `_CARDANO_ENABLED=true`
- Add variable `_CARDANO_NETWORK=preprod`
- Add variable `_CARDANO_CHAIN_ID=900000000001`
- Add variable `_CARDANO_PROVIDER_URL=https://preprod.koios.rest/api/v1`
- Add variable `_CARDANO_PROVIDER_TIMEOUT_MS=20000`
- Add variable `_CARDANO_TTL_SLOTS=900`
- Add variable `_CARDANO_DEPOSIT_CONFIRMATIONS=3`
- Add variable `_CARDANO_EXPLORER_URL=https://preprod.cardanoscan.io/transaction/`
- Add variable `_CARDANO_SPONSOR_FEES=true`
- Add variable `_CARDANO_TRANSFER_FEE_USD=0.08`
- Add variable `_CARDANO_SPONSOR_WALLET_ID=chatterpay-sponsor`

**main**

- Add variable `_CARDANO_ENABLED=false` → `true` en un segundo deploy
- Add variable `_CARDANO_NETWORK=mainnet`
- Add variable `_CARDANO_CHAIN_ID=900764824073`
- Add variable `_CARDANO_PROVIDER_URL=https://api.koios.rest/api/v1`
- Add variable `_CARDANO_PROVIDER_TIMEOUT_MS=20000`
- Add variable `_CARDANO_TTL_SLOTS=900`
- Add variable `_CARDANO_DEPOSIT_CONFIRMATIONS=3`
- Add variable `_CARDANO_EXPLORER_URL=https://cardanoscan.io/transaction/`
- Add variable `_CARDANO_SPONSOR_FEES=true`
- Add variable `_CARDANO_TRANSFER_FEE_USD=0.08`
- Add variable `_CARDANO_SPONSOR_WALLET_ID=chatterpay-sponsor`

No hay secretos. `SEED_INTERNAL_SALT` ya existe y es requerida.

> **Sponsor:** sin estas tres variables la opción C no se activa y la transferencia corre como
> opción A (el usuario paga la red y ChatterPay no cobra). La wallet del sponsor tiene que estar
> fondeada con ADA antes de habilitar `CARDANO_SPONSOR_FEES=true` — si está vacía, toda
> transferencia se rechaza con `CARDANO_SPONSOR_WALLET_EMPTY`.


## GCP changes (Chatizalo-bot)

- Add variable `MAX_BASE_PROMPT_CHARS=120000` — **obligatoria**: el default es 1800 y la sección de Cardano queda fuera del recorte
- Add variable `MAX_SYSTEM_PROMPT_CHARS=200000` — **obligatoria**
- Add variable `MAX_TOOL_HINTS=0` — opcional, ahorra ~2.070 tokens por llamada


## Database changes (chatterpay)

### dev / test

`blockchains` — insertar:

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
    "transfer": { "L1": { "D": 50 }, "L2": { "D": 1000 } }
  }
}
```

`tokens` — insertar:

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

`tokens` — stablecoin de Preprod (ya insertada en la base local de dev):

```json
{
  "address": "648823ffdad1610b4162f4dbc87bd47f6f9cf45d772ddef661eff19855534443",
  "chain_id": 900000000001,
  "name": "USD Coin",
  "symbol": "USDCx",
  "display_symbol": "USDC",
  "decimals": 6,
  "display_decimals": 2,
  "type": "stable",
  "ramp_enabled": false,
  "logo": "https://cryptofonts.com/img/SVG/usdc.svg",
  "operations_limits": {
    "transfer": { "L1": { "min": 1, "max": 1000 }, "L2": { "min": 1, "max": 1000 } },
    "swap":     { "L1": { "min": 0, "max": 0 },    "L2": { "min": 0, "max": 0 } }
  }
}
```

### producción

`blockchains` — insertar:

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
    "transfer": { "L1": { "D": 50 }, "L2": { "D": 100 } }
  }
}
```

`tokens` — insertar:

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

`tokens` — stablecoins de mainnet. `address` = policy id + asset name (hex, minúsculas):

```json
[
  {
    "address": "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378",
    "chain_id": 900764824073,
    "name": "USDCx", "symbol": "USDCx", "display_symbol": "USDC",
    "decimals": 6, "display_decimals": 2,
    "type": "stable", "ramp_enabled": false, "logo": "https://cryptofonts.com/img/SVG/usdc.svg",
    "operations_limits": {
      "transfer": { "L1": { "min": 1, "max": 1000 }, "L2": { "min": 1, "max": 1000 } },
      "swap":     { "L1": { "min": 0, "max": 0 },    "L2": { "min": 0, "max": 0 } }
    }
  },
  {
    "address": "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d",
    "chain_id": 900764824073,
    "name": "USDM", "symbol": "USDM", "display_symbol": "USDM",
    "decimals": 6, "display_decimals": 2,
    "type": "stable", "ramp_enabled": false, "logo": "",
    "operations_limits": {
      "transfer": { "L1": { "min": 1, "max": 1000 }, "L2": { "min": 1, "max": 1000 } },
      "swap":     { "L1": { "min": 0, "max": 0 },    "L2": { "min": 0, "max": 0 } }
    }
  },
  {
    "address": "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae45655534441",
    "chain_id": 900764824073,
    "name": "USDA", "symbol": "USDA", "display_symbol": "USDA",
    "decimals": 6, "display_decimals": 2,
    "type": "stable", "ramp_enabled": false, "logo": "",
    "operations_limits": {
      "transfer": { "L1": { "min": 1, "max": 1000 }, "L2": { "min": 1, "max": 1000 } },
      "swap":     { "L1": { "min": 0, "max": 0 },    "L2": { "min": 0, "max": 0 } }
    }
  }
]
```


### Índices (los dos ambientes)

```js
db.users.createIndex({ 'wallets.wallet_proxy': 1 }, { name: 'wallets_proxy', background: true })
db.users.createIndex({ 'wallets.chain_id': 1, 'wallets.wallet_proxy': 1 }, { name: 'wallets_chain_proxy', background: true })
```

### Template (los dos ambientes)

`templates` → `notifications.wallet_creation` — documento completo con el agregado:

```json
{
  "title": {
    "en": "Chatterpay: Wallet Created!",
    "es": "Chatterpay: ¡Billetera creada!",
    "pt": "Chatterpay: Carteira criada!"
  },
  "message": {
    "en": "Your wallet was successfully created and linked to your WhatsApp number! 🎉  \nYour wallet address is: [WALLET_ADDRESS].\n\nYour Cardano address is:\n[CARDANO_ADDRESS]\n\nYou can now easily send and receive funds via WhatsApp with ChatterPay.\n\n⚠️ Important: If you plan to send crypto to this wallet from an external platform (like another wallet or exchange), make sure to use the [NETWORK_NAME] network and double-check the address. To send ADA or Cardano tokens, use the Cardano address and the Cardano network. ChatterPay cannot reverse incorrect transactions made outside our app — like using the wrong network or mistyping the address.\n",
    "es": "¡Tu wallet fue creada y vinculada a tu número de WhatsApp con éxito! 🎉\nTu dirección de wallet es: [WALLET_ADDRESS].\n\nTu dirección de Cardano es:\n[CARDANO_ADDRESS]\n\nAhora puedes enviar y recibir fondos fácilmente por WhatsApp con ChatterPay. \n\n⚠️ Importante: Si planeas enviar crypto a esta wallet desde una plataforma externa (como un wallet o exchange), asegúrate de usar la red [NETWORK_NAME] y verifica dos veces la dirección. Para enviar ADA o tokens de Cardano, usá la dirección de Cardano y la red Cardano. ChatterPay no puede revertir transacciones incorrectas hechas fuera de nuestra app, como cuando seleccionas la red equivocada o escribes mal la dirección.\n",
    "pt": "Sua wallet foi criada e vinculada ao seu número do WhatsApp com sucesso! 🎉  \nO endereço da sua wallet é: [WALLET_ADDRESS].\n\nO seu endereço Cardano é:\n[CARDANO_ADDRESS]\n\nAgora você pode enviar e receber fundos facilmente pelo WhatsApp com a ChatterPay.\n\n⚠️ Importante: Se for enviar cripto para esta wallet a partir de uma plataforma externa (como uma carteira ou exchange), certifique-se de usar a rede [NETWORK_NAME] e verifique o endereço duas vezes. Para enviar ADA ou tokens Cardano, use o endereço Cardano e a rede Cardano. A ChatterPay não pode reverter transações incorretas feitas fora do nosso app — como usar a rede errada ou digitar o endereço errado.\n"
  }
}
```

---

## Database changes (bot)

Bases: `chatterpay-develop` (dev) / `chatterpay` (prod).

Los documentos completos están al lado de este archivo, listos para reemplazar:

| Colección | Ambiente | Archivo |
|---|---|---|
| `chat_functions` (`name: transferir_fondos`) | dev | `chat_functions.transferir_fondos.dev.json` |
| `chat_functions` (`name: transferir_fondos`) | prod | `chat_functions.transferir_fondos.prod.json` |
| `chat_modes` (documento **nuevo**) | dev y prod | `chat_modes.json` |

`chat_modes.json` va como documento nuevo, no reemplaza al anterior: el bot toma el de `date` más
grande. En prod hay que ajustarle `date` para que supere al último de esa base, y su
`start_system_message` sale del prompt vigente de prod, no del de dev.

`chat_modes.json` no está embebido acá porque son 98 KB — el `start_system_message` solo son 94.288
caracteres.

> El bot cachea `chat_functions` y `chat_modes` con TTL: reiniciar después de aplicar.

-----------
## [#734: Add Cardano as a supported network](https://github.com/P4-Games/ChatterPay-Backend/issues/734)

### Backend Changes

- 


## [#342: Support Cardano in the dashboard](https://github.com/P4-Games/ChatterPay/issues/342)

### Frontend Changes

- 

## [#259: Support Cardano transfers](https://github.com/P4-Games/ChatBot-WhatsappOpenIA/issues/259)

### Bot Changes

- 
