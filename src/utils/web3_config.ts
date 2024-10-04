import { Web3 } from 'web3';

import { INFURA_API_KEY } from '../constants/environment';

const web3 = new Web3(`https://mainnet.infura.io/v3/${INFURA_API_KEY}`);

export default web3;
