# Polymarket Integration Documentation

This document describes the comprehensive flows for Polymarket integration within ChatterPay, specifically focusing on the unified purchase flow.

## 1. Buy Flow Overview

The buy flow is an orchestrated process that takes a user from having funds on Scroll to holding a position on Polymarket. It handles account setup, cross-chain bridging, and order execution in a single seamless experience.

### 1.1 Process Flow Diagram

```mermaid
sequenceDiagram
    participant U as User (App)
    participant PS as PolymarketPurchaseService
    participant AS as PolymarketAccountService
    participant BS as PolymarketBridgeService
    participant TS as PolymarketTradingService
    participant R as Polymarket Relayer
    participant L as Li.Fi Bridge
    participant C as Polymarket CLOB

    U->>PS: executePurchase(params)
    
    Note over PS, AS: Step 1: Account Check & Creation
    PS->>AS: createPolymarketAccount()
    AS->>R: deploySafeWallet() (Gasless)
    AS->>R: setupGaslessTrading() (Approve USDC.e)
    AS->>AS: generate & encrypt API Credentials
    PS->>AS: acceptTerms()

    Note over PS, BS: Step 2: Balance Check & Bridge
    PS->>BS: executeBridge()
    BS->>BS: findAvailableStablecoin() (Checks USDC/USDT on Scroll)
    alt Insufficient Balance
        BS-->>PS: Throw "Insufficient stablecoin balance"
        PS-->>U: Update Status: Failed (bridge)
    else Sufficient Balance
        BS->>L: getLifiQuote(Scroll -> Polygon USDC.e)
        Note right of BS: Quote retries (3x) for transient errors
        BS->>BS: approve LiFi Router (if needed)
        BS->>BS: fund Proxy with ETH (if native bridge fee required)
        BS->>L: Execute Cross-chain Swap
        loop Status Polling
            BS->>L: checkBridgeStatus()
        end
        L-->>BS: DONE
    end

    Note over PS, TS: Step 3: Order Placement
    PS->>TS: placeOrder()
    TS->>C: getAuthenticatedClient()
    TS->>C: check Allowance
    alt Allowance missing
        TS->>R: ensureTokenApprovals() (Gasless)
    end
    TS->>C: createAndPostOrder() (Limit or Market)
    C-->>TS: orderID
    PS->>PS: Record order in MongoDB

    PS-->>U: Update Status: Completed
```

---

## 2. Key Components

### 2.1 Balance Check
The system automatically detects which stablecoin the user has available on the source chain (Scroll).
- **Service**: `PolymarketBridgeService.findAvailableStablecoin`
- **Logic**:
  - Queries DB for supported stablecoins (USDC, USDT).
  - Checks on-chain balance for each token in priority order.
  - Returns the first token meeting the required amount.
  - If no token has enough balance, a detailed error listing all current balances is returned to the user.

### 2.2 Account Check & Creation (Gasless Infrastructure)
ChatterPay uses Polymarket's gasless trading infrastructure, which relies on Gnosis Safe wallets.
- **Service**: `PolymarketRelayerService`
- **Mechanism**:
  - **Safe Wallet**: A deterministic Safe address is derived for every user based on their EOA address.
  - **Deployment**: The Safe is deployed gaslessly via the Polymarket Relayer upon the first purchase.
  - **RelayClient**: Authenticates using Builder Program credentials (API Key, Secret, Passphrase).
  - **Sponsorship**: The Relayer sponsors all on-chain operations (Safe deployment, approvals).

### 2.3 Li.Fi Bridge (Scroll → Polygon)
Bridging is handled by Li.Fi to ensure the best route and rates for USDC.e.
- **Destination**: Funds are bridged directly to the user's **Polygon Safe address**.
- **Quote Retries**: The system implements 3 retries with exponential backoff for `getLifiQuote` to handle transient network or provider errors.
- **Native Fee Handling**: Some bridge tools (e.g., Across) require a small native ETH fee. The service automatically detects this and funds the user's proxy wallet from a backend "gas" signer if necessary.
- **Status Polling**: The system polls the Li.Fi API every 10 seconds for up to 5 minutes to track the cross-chain transaction to completion.

### 2.4 Order Placement
Orders are placed on the Polymarket CLOB (Central Limit Order Book).
- **Service**: `PolymarketTradingService`
- **Order Types**:
  - **GTC (Good Till Cancelled)**: Default limit order.
  - **FOK (Fill Or Kill)**: Market order that must be filled immediately or cancelled.
  - **GTD (Good Till Date)**: Order with an expiration.
- **Authentication**: Uses internal API credentials (key, secret, passphrase) derived during account creation.

### 2.5 Error Handling & Reversals
- **Step-wise Persistence**: Every step (Account, Bridge, Order) updates a "purchase record" in MongoDB. This allows the frontend to show real-time progress.
- **Failures**: If any step fails:
  - The process stops and the record is marked as `failed`.
  - **No Automatic Reversal**: Currently, funds are not automatically bridged back to the source chain. They remain on the chain where the failure occurred (e.g., if the bridge finished but the order failed, funds stay as USDC.e on Polygon).
- **Retries**: Explicit retries are implemented for API calls (LiFi Quote), while on-chain status checks use polling.

### 2.6 Gasless Structure (Summary)
| Operation | Gas Paid By | Mechanism |
| :--- | :--- | :--- |
| Safe Deployment | Polymarket Relayer | `RelayClient.deploy()` |
| Token Approvals | Polymarket Relayer | `RelayClient.execute()` |
| Order Placement | Polymarket (CLOB) | EIP-712 Signatures |
| Bridge Execution | ChatterPay Backend | `ChatterPay.execute()` + Backend Signer |
