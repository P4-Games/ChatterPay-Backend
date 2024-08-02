import Web3 from 'web3';

const web3 = new Web3('https://mainnet.infura.io/v3/' + process.env.INFURA_API_KEY);

export default web3;
