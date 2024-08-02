import { Network as ANet, BigNumber } from 'alchemy-sdk';

export const TEST_BTC = "0x2fa2e7a6deb7bb51b625336dbe1da23511914a8a";
export const USDC_MAINNET = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
export const ETH_MAINNET = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

export const ASSETS: {
    [key: string]: string;
} = {
    eth: ETH_MAINNET,
    usdc: USDC_MAINNET,
    usdc_e: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    matic: "0xEEeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

export const ASSETS_TEST = {
    eth: "0xc199807af4fedb02ee567ed0feb814a077de4802",
    usdc: "0x52D800ca262522580CeBAD275395ca6e7598C014",
    matic: "0xEEeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
}

export const CONTRACT_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // pool aave polygon
export const CONTRACT_ADDRESS_TEST = "0xcC6114B983E4Ed2737E9BD3961c9924e6216c704";


export const ADDRESS = process.env.ADDRESS ?? "";
export const PK = process.env.PK ?? "";

export const polygon = {
    rpc: "https://polygon-mainnet.g.alchemy.com/v2/t2TH4dogN1FWTFUgBs4VXc7g-zFOhIV0"
}

export const settings = {
    apiKey: "t2TH4dogN1FWTFUgBs4VXc7g-zFOhIV0",
    network: ANet.MATIC_MAINNET,
};

export const providerRPC = {
    mumbai: {
        name: "Polygon",
        rpc: polygon.rpc,
        chainId: 137,
    }
}