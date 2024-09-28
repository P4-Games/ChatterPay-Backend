/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */
import type {
    BaseContract,
    BigNumber,
    BytesLike,
    CallOverrides,
    ContractTransaction,
    Overrides,
    PopulatedTransaction,
    Signer,
    utils,
} from 'ethers';
import type { FunctionFragment, Result } from '@ethersproject/abi';
import type { Listener, Provider } from '@ethersproject/providers';
import type { TypedEventFilter, TypedEvent, TypedListener, OnEvent } from './common';

export interface ChatterPayWalletFactoryInterface extends utils.Interface {
    functions: {
        'createProxy(address)': FunctionFragment;
        'computeProxyAddress(address)': FunctionFragment;
        'getProxiesCount()': FunctionFragment;
    };

    getFunction(
        nameOrSignatureOrTopic: 'createProxy' | 'computeProxyAddress' | 'getProxiesCount',
    ): FunctionFragment;

    encodeFunctionData(functionFragment: 'createProxy', values: [string]): string;
    encodeFunctionData(functionFragment: 'computeProxyAddress', values: [string]): string;
    encodeFunctionData(functionFragment: 'getProxiesCount', values?: undefined): string;

    decodeFunctionResult(functionFragment: 'createProxy', data: BytesLike): Result;
    decodeFunctionResult(functionFragment: 'computeProxyAddress', data: BytesLike): Result;
    decodeFunctionResult(functionFragment: 'getProxiesCount', data: BytesLike): Result;

    events: {};
}

export interface ChatterPayWalletFactory extends BaseContract {
    connect(signerOrProvider: Signer | Provider | string): this;
    attach(addressOrName: string): this;
    deployed(): Promise<this>;

    interface: ChatterPayWalletFactoryInterface;

    queryFilter<TEvent extends TypedEvent>(
        event: TypedEventFilter<TEvent>,
        fromBlockOrBlockhash?: string | number | undefined,
        toBlock?: string | number | undefined,
    ): Promise<Array<TEvent>>;

    listeners<TEvent extends TypedEvent>(
        eventFilter?: TypedEventFilter<TEvent>,
    ): Array<TypedListener<TEvent>>;
    listeners(eventName?: string): Array<Listener>;
    removeAllListeners<TEvent extends TypedEvent>(eventFilter: TypedEventFilter<TEvent>): this;
    removeAllListeners(eventName?: string): this;
    off: OnEvent<this>;
    on: OnEvent<this>;
    once: OnEvent<this>;
    removeListener: OnEvent<this>;

    functions: {
        createProxy(
            _owner: string,
            overrides?: Overrides & { from?: string },
        ): Promise<ContractTransaction>;

        computeProxyAddress(_owner: string, overrides?: CallOverrides): Promise<[string]>;

        getProxiesCount(overrides?: CallOverrides): Promise<[BigNumber]>;
    };

    createProxy(
        _owner: string,
        overrides?: Overrides & { from?: string },
    ): Promise<ContractTransaction>;

    computeProxyAddress(_owner: string, overrides?: CallOverrides): Promise<string>;

    getProxiesCount(overrides?: CallOverrides): Promise<BigNumber>;

    callStatic: {
        createProxy(_owner: string, overrides?: CallOverrides): Promise<string>;

        computeProxyAddress(_owner: string, overrides?: CallOverrides): Promise<string>;

        getProxiesCount(overrides?: CallOverrides): Promise<BigNumber>;
    };

    filters: {};

    estimateGas: {
        createProxy(_owner: string, overrides?: Overrides & { from?: string }): Promise<BigNumber>;

        computeProxyAddress(_owner: string, overrides?: CallOverrides): Promise<BigNumber>;

        getProxiesCount(overrides?: CallOverrides): Promise<BigNumber>;
    };

    populateTransaction: {
        createProxy(
            _owner: string,
            overrides?: Overrides & { from?: string },
        ): Promise<PopulatedTransaction>;

        computeProxyAddress(
            _owner: string,
            overrides?: CallOverrides,
        ): Promise<PopulatedTransaction>;

        getProxiesCount(overrides?: CallOverrides): Promise<PopulatedTransaction>;
    };
}
