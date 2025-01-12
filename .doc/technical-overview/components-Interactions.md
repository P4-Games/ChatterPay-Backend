# Chatterpay Components Interactions

## BOT => Frontend

- precio_de_tokens => https://chatterpay.net/api/v1/bot/rates/, GET

## BOT => Backend

- consultar_balance => https://back.chatterpay.net/balance_by_phone/, GET
- obtener_balance => https://back.chatterpay.net/balance_by_phone/, GET
- crear_wallet => https://back.chatterpay.net/create_wallet/, POST
- obtener_wallet => https://back.chatterpay.net/create_wallet/, POST
- transferir_fondos => https://back.chatterpay.net/make_transaction/, POST
- intercambiar_tokens => https://back.chatterpay.net/swap/, POST
- copiar_certificado_existente => https://back.chatterpay.net/mint_existing/, POST
- generar_certificado => https://back.chatterpay.net/nft/, POST
- ramp_user_onboarding => https://back.chatterpay.net/ramp/onboarding, POST
- ramp_create_user => https://back.chatterpay.net/ramp/user, POST
- ramp_user_compliance_documents_upload => https://back.chatterpay.net/ramp/user/:userId/compliance/documents, POST
- ramp_user_compliance_documents_status => https://back.chatterpay.net/ramp/user/:userId/compliance/documents/status, GET
- ramp_user_compliance_status => https://back.chatterpay.net/ramp/user/:userId/compliance/status, GET
- ramp_user_limits => https://back.chatterpay.net/ramp/user/:userId/limits, GET
- ramp_user_add_bank_account => https://back.chatterpay.net/ramp/user/:userId/bankaccount/ARS, POST
- ramp_user_remove_bank_account => https://back.chatterpay.net/ramp/user/:userId/bankaccount/ARS/:accountId, DELETE
- ramp_market_price => https://back.chatterpay.net/ramp/market/price, GET
- ramp_on => https://back.chatterpay.net/ramp/on, POST
- ramp_off => https://back.chatterpay.net/ramp/off, POST

## BOT => Sitio tdm

- pay_qr => https://qrchatterpay.tdm.ar/api/payments_demo/execute, POST
- generate_qr => https://qrchatterpay.tdm.ar/api/payments_demo/create, POST

## Frontend => Backend

- transferAll => /withdraw_all, POST
- getBalancesWithTotalsFromBackend => /balance:walletAddress, GET
- fethCustomTokens => /balance:walletAddress, GET

## Frontend => BOT

- Send Message => chatbot/conversations/send-message

## OpenSea => Backend

- Get NFT Metadata => /nft/metadata/opensea/:id, GET

## Backend => BOT

- sendSwapNotification => chatbot/conversations/send-message
- sendMintNotification => chatbot/conversations/send-message
- sendTransferNotification => chatbot/conversations/send-message
- sendOutgoingTransferNotification => chatbot/conversations/send-message

## Backend => The Graph

- /check_deposits, checkExternalDeposits, GET https://api.studio.thegraph.com/query/91286/balance-sepolia

## Backend => Push

- sendWalletCreationNotification => Push to Chatterpay Channel
- sendSwapNotification => Push to Chatterpay Channel
- sendMintNotification => Push to Chatterpay Channel
- sendTransferNotification => Push to Chatterpay Channel
- sendOutgoingTransferNotification => Push to Chatterpay Channel

## Backend => Smart Contracts

- Create Wallet (/create_wallet)

  - ChatterPayWalletFactory.computeProxyAddress
  - ChatterPayWalletFactory.createProxy

- NFT: Mint Original (/nft) => ChatterPayNFT.mintOriginal

- NFT: Mint Copy (/mint_existing) => ChatterPayNFT.mintCopy

- Make Transaction (/make_transaction)

  - ChatterPayWalletFactory.computeProxyAddress
  - [ERC20].approve
  - Chatterpay.execute
  - Chatterpay.balanceOf
  - CHatterpay.transfer

- Swap (/swap)
  - ChatterPayWalletFactory.computeProxyAddress
  - SimpleSwap.swapWETHforUSDT
  - SimpleSwap.swapUSDTforWETH
