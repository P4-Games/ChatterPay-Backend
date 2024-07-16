SUPPORTED_NETWORKS = {
    "polygon": {
        "logo": "https://cryptofonts.com/img/SVG/matic.svg",
        "rpc": f"https://polygon-mainnet.g.alchemy.com/v2/{{ALCHEMY_API_KEY}}",
        "chain_id": 137,
        "explorer": "https://polygonscan.com",
        "tokens": {
            "weth": {"address": "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "decimals": 18},
            "usdc": {"address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "decimals": 6},
            "native": {"address": "0x0000000000000000000000000000000000000000", "symbol": "MATIC", "decimals": 18}
        }
    },
    "arbitrum": {
        "logo": "https://cryptofonts.com/img/SVG/arb.svg",
        "rpc": "https://arbitrum.llamarpc.com",
        "chain_id": 42161,
        "explorer": "https://arbiscan.io",
        "tokens": {
            "weth": {"address": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "decimals": 18},
            "usdc": {"address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "decimals": 6},
            "usdt": {"address": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "decimals": 6},
            "native": {"address": "0x0000000000000000000000000000000000000000", "symbol": "ETH", "decimals": 18}
        }
    },
    "scroll": {
        "logo": "https://scroll.io/static/media/Scroll_Logomark.673577c8260b63ae56867bc9af6af514.svg",
        "rpc": "https://rpc.scroll.io",
        "chain_id": 534352,
        "explorer": "https://scrollscan.com",
        "tokens": {
            "weth": {"address": "0x5300000000000000000000000000000000000004", "decimals": 18},
            "usdc": {"address": "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", "decimals": 6},
            "usdt": {"address": "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", "decimals": 6},
            "native": {"address": "0x0000000000000000000000000000000000000000", "symbol": "ETH", "decimals": 18}
        }
    }
}