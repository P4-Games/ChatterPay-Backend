import { FastifyRequest, FastifyReply } from 'fastify';
import { ethers } from 'ethers';
import { SCROLL_CONFIG } from '../constants/networks';
import { USDT_ADDRESS, WETH_ADDRESS } from '../constants/contracts';

// Emite nuevos tokens a la dirección especificada
export const issueTokens = async (request: FastifyRequest<{
    Body: {
        address: string,
    }
}>, reply: FastifyReply) => {
    try {
        //Mintear 100,000 tokens al usuario que envia la solicitud
        const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL);
        const signer = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
        const erc20 = new ethers.Contract("0x9a01399df4E464B797E0f36B20739a1BF2255Dc8",
            [
                'function transfer(address to, uint256 amount)',
                'function mint(address, uint256 amount)'
            ], signer
        );

        const amount_bn = ethers.utils.parseUnits("100000", 18);

        const gasLimit = 300000; // Set the desired gas limit here

        const tx = await erc20.mint("0xe54b48F8caF88a08849dCdDE3D3d41Cd6D7ab369", amount_bn, { gasLimit });

        const result = await tx.wait();

        return reply.status(201).send({
            message: 'Tokens issued',
            txHash: result.transactionHash,
        });
    } catch (error) {
        console.error('Error creating user:', error);
        return reply.status(400).send({ message: 'Bad Request' });
    }
};

const getContractBalance = async (contractAddress: string, signer: ethers.Wallet, address: string) => {
    try {
        const erc20 = new ethers.Contract(contractAddress,
            [
                'function transfer(address to, uint256 amount)',
                'function balanceOf(address owner) view returns (uint256)',
            ], signer
        );
        const balance = await erc20.balanceOf(address);

        const formattedBalance = ethers.utils.formatUnits(balance, 18);

        return formattedBalance;
    } catch (error: any) {
        console.log(`Error getting balance: ${error.message}`);
        return '0';
    }
}

export const walletBalance = async (request: FastifyRequest<{ Params: { wallet: string } }>, reply: FastifyReply) => {
    const wallet = request.params.wallet;

    const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL);
    const signer = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

    const API_URLs = [
        ["UYU", "https://criptoya.com/api/ripio/USDT/UYU"],
        ["ARS", "https://criptoya.com/api/ripio/USDT/ARS"],
        ["BRL", "https://criptoya.com/api/ripio/USDT/BRL"],
    ] as const;

    const tokenInfo = [
        { symbol: "USDT", address: USDT_ADDRESS, rateUSD: 1 },
        { symbol: "WETH", address: WETH_ADDRESS, rateUSD: 2700 },
    ];

    type Currency = "USD" | "UYU" | "ARS" | "BRL";

    try {
        const [fiatQuotes, tokenBalances] = await Promise.all([
            // Fetch all fiat quotes in parallel
            Promise.all(API_URLs.map(async ([currency, url]) => {
                const response = await fetch(url);
                const data = await response.json();
                return { currency, rate: data.bid };
            })),
            // Fetch all token balances in parallel
            Promise.all(tokenInfo.map(async (token) => {
                const balance = await getContractBalance(token.address, signer, wallet);
                return { ...token, balance };
            }))
        ]);

        const balances = tokenBalances.map(({ symbol, balance, rateUSD }) => {
            const balanceUSD = parseFloat(balance) * rateUSD;
            return { 
                network: "Scroll Sepolia",
                token: symbol,
                logo: `https://cryptofonts.com/img/SVG/${symbol.toLowerCase()}.svg`,
                balance: parseFloat(balance),
                balance_conv: {
                    USD: balanceUSD,
                    UYU: balanceUSD * (fiatQuotes.find(q => q.currency === "UYU")?.rate || 1),
                    ARS: balanceUSD * (fiatQuotes.find(q => q.currency === "ARS")?.rate || 1),
                    BRL: balanceUSD * (fiatQuotes.find(q => q.currency === "BRL")?.rate || 1),
                } as Record<Currency, number>
            };
        });

        const totals = balances.reduce((acc, balance) => {
            (Object.keys(balance.balance_conv) as Currency[]).forEach(currency => {
                acc[currency] = (acc[currency] || 0) + balance.balance_conv[currency];
            });
            return acc;
        }, {} as Record<Currency, number>);

        const res = {
            balances,
            totals,
            wallet
        };

        return reply.status(200).send(res);
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};