![](https://img.shields.io/badge/Python-informational?style=flat&logo=python&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/Bun.js-informational?style=flat&logo=bun&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/Typescript-informational?style=flat&logo=typescript&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/Fastify-informational?style=flat&logo=fastify&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/MongoDb-informational?style=flat&logo=mongodb&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/Mongoose-informational?style=flat&logo=mongoose&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/Alchemy-informational?style=flat&logo=alchemy&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/Web3-informational?style=flat&logo=web3&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/Ethers.js-informational?style=flat&logo=ethersjs&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/LI.FI-informational?style=flat&logo=li.fi&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/api3-informational?style=flat&logo=api3&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/jsdoc-informational?style=flat&logo=jsdoc&logoColor=white&color=6aa6f8)
![](https://img.shields.io/badge/userOps.js-informational?style=flat&logo=useropsjs&logoColor=white&color=6aa6f8)

# ChatterPay

ChatterPay is a Wallet for WhatsApp that integrates AI and Account Abstraction, enabling any user to use blockchain easily and securely without technical knowledge.

> Built for: [Level Up Hackathon - Ethereum Argentina 2024](https://ethereumargentina.org/) & [Ethereum Uruguay 2024](https://www.ethereumuruguay.org/)

> Built By: [mpefaur](https://github.com/mpefaur), [tomasfrancizco](https://github.com/tomasfrancizco), [TomasDmArg](https://github.com/TomasDmArg), [gonzageraci](https://github.com/gonzageraci),  [dappsar](https://github.com/dappsar)

__Components__:

- Landing Page ([product](https://chatterpay.net), [source code](https://github.com/P4-Games/ChatterPay))
- User Dashboard Website ([product](https://chatterpay.net/dashboard), [source code](https://github.com/P4-Games/ChatterPay))
- Backend API ([source code](https://github.com/P4-Games/ChatterPay-Backend))  (this Repo)
- Smart Contracts ([source code](https://github.com/P4-Games/ChatterPay-SmartContracts))
- Data Indexing (Subgraph) ([source code](https://github.com/P4-Games/ChatterPay-Subgraph))
- Bot AI Admin Dashboard Website ([product](https://app.chatizalo.com/))
- Bot AI (Chatizalo) ([product](https://chatizalo.com/))
- Bot AI Admin Dashboard Website ([product](https://app.chatizalo.com/))

# About this Repo

This repository contains the backend API source code.

__Built With__:

- Framework: [Bun.js](https://bun.sh/)
- Language: [TypeScript](https://www.typescriptlang.org)
- Database: [mongodb](https://www.mongodb.com)
- Database ODM: [mongoose](https://mongoosejs.com/)
- web3 SDK: [Alchemy](https://www.alchemy.com/sdk)
- web3 Library: [ethers.js](https://docs.ethers.org/v5/)
- web3 swap/bridges SDK: [LI.FI](https://li.fi/sdk/)
- web3 ERC-4337 Library: [Stackup userOps.js](https://github.com/stackup-wallet/userop.js#readme)
- web3 Data Feed: [api3](https://api3.org/)
- Source Code Documentation: [jsDoc](https://jsdoc.app/)

# Getting Started

__1. Install these Requirements__:

- [git](https://git-scm.com/)
- [bun](https://bun.sh/)
- [mongoDb](https://www.mongodb.com/docs/manual/installation/)

__2. Clone repository__:

```bash
git clone https://github.com/P4-Games/ChatterPay-Backend
cd ChatterPay-Backend
```

__3. Complete .env file__: 

Create a .env file in the root folder and populate it with the following keys and values:

```bash
ALCHEMY_API_KEY=
INFURA_API_KEY=
MONGO_URI=
SIGNING_KEY=
RPC_URL=
THRIDWEB_CLIENT_ID=
THIRDWEB_CLIENT_SECRET=
SCROLLSCAN_API_KEY=
ETHERSCAN_API_KEY=
FACTORY_ADDRESS=
PRIVATE_KEY=
MONGO_URI_CHATTERPAY=
```

__4. Install Dependencies__:

```bash
bun install
```

__5. Start Server__:

```bash
bun run dev
```

Then, open in: `http://localhost:3000`.

# Additional Info

## Project Structure

- `src/`:
  - `api/`: Definition of API paths.
  - `controllers/`: Helpers that interact with the DB and other services.
  - `services/`: Business logic.
  - `models/`: Data model definitions.
  - `middleware/`: Custom middleware.
  - `utils/`: Utility functions.
  - `config/`: Application configurations.
  - `types/`: Type and interface definitions.
  - `constants/`: Constants and enumerations.
  - `errors/`: Custom error classes.
  - `index.ts`: Application entry point.
- `tests/`: Unit Tests.
- `.gitignore`: Specifies files and directories ignored by Git.
- `package.json`: Project configuration and dependencies.
- `tsconfig.json`: TypeScript configuration.
- `README.md`: This File.
- `.env.example`: Example Environment File.

## Source Code Documentation

- We use JSDoc (in english) to document our code.