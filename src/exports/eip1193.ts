import {
  AztecAddress,
  NoFeePaymentMethod,
  SentTx,
  TxHash,
  type AztecNode,
  type FunctionCall,
  type PXE,
  type Wallet,
} from "@aztec/aztec.js";
import type { TxSimulationResult } from "@aztec/circuit-types";
import { GasSettings } from "@aztec/circuits.js";
import {
  encodeArguments,
  FunctionType,
  type ABIParameter,
  type FunctionAbi,
} from "@aztec/foundation/abi";
import { assert } from "ts-essentials";
import type { IntentAction } from "../contract.js";
import { decodeFunctionCall, encodeFunctionCall, serde } from "../serde.js";
import type {
  Eip1193Provider,
  RpcRequestMap,
  TypedEip1193Provider,
} from "../types.js";

export { BatchCall, Contract, type IntentAction } from "../contract.js";

export class Eip1193Account {
  /** The RPC provider to send requests to the wallet. */
  readonly provider: TypedEip1193Provider;

  constructor(
    /** The address of the account. */
    readonly address: AztecAddress,
    provider: Eip1193Provider,
    /** Aztec node to fetch public data */
    readonly aztecNode: Pick<
      AztecNode,
      // methods used in `SentTx`
      | "getTxEffect"
      | "getTxReceipt"
      | "getUnencryptedLogs"
      | "getProvenBlockNumber"
    >,
  ) {
    this.provider = provider as TypedEip1193Provider;
  }

  // for compatibility with aztec.js `Wallet`. Decide whether to keep this or not
  getAddress() {
    return this.address;
  }

  // TODO: return a promise that resolves to `SentTxWithHash`
  sendTransaction(txRequest: TransactionRequest): SentTx {
    const txHashPromise = (async () =>
      this.provider.request({
        method: "aztec_sendTransaction",
        params: [
          {
            from: this.address.toString(),
            calls: await Promise.all(txRequest.calls.map(encodeFunctionCall)),
            authWitnesses: await Promise.all(
              (txRequest?.authWitnesses ?? []).map(async (x) => ({
                caller: x.caller.toString(),
                action: await encodeFunctionCall(x.action),
              })),
            ),
          },
        ],
      }))().then((x) => TxHash.fromString(x));

    return new SentTx(this.aztecNode as unknown as PXE, txHashPromise);
  }

  // TODO: rename to either `call` or `view` or `readContract` or something more descriptive
  async simulateTransaction(
    txRequest: Pick<TransactionRequest, "calls">,
  ): Promise<string[]> {
    return await this.provider.request({
      method: "aztec_call",
      params: [
        {
          from: this.address.toString(),
          calls: await Promise.all(
            txRequest.calls.map((x) => encodeFunctionCall(x)),
          ),
        },
      ],
    });
  }

  /**
   * @deprecated only use to convert aztec.js account to `Eip1193Account` for compatibility reasons
   */
  static fromAztec(account: Wallet): Eip1193Account {
    const provider = createEip1193ProviderFromAccounts([account]);
    return new this(account.getAddress(), provider, account);
  }
  /** @deprecated TODO: remove this alias */
  static fromAztecAccount = this.fromAztec.bind(this);
}

export type TransactionRequest = {
  calls: FunctionCall[];
  authWitnesses?: IntentAction[];
};

export function createEip1193ProviderFromAccounts(accounts: Wallet[]) {
  function getAccount(address: string) {
    const account = accounts.find((a) => a.getAddress().toString() === address);
    assert(account, `no account found for ${address}`);
    return account;
  }
  const provider: TypedEip1193Provider = {
    async request(params) {
      params = JSON.parse(JSON.stringify(params)); // ensure (de)serialization works

      const methodMap: {
        [K in keyof RpcRequestMap]: (
          ...args: Parameters<RpcRequestMap[K]>
        ) => Promise<ReturnType<RpcRequestMap[K]>>;
      } = {
        aztec_sendTransaction: async (request) => {
          const account = getAccount(request.from);
          const authWitRequests: IntentAction[] = await Promise.all(
            request.authWitnesses.map(async (authWitness) => ({
              caller: AztecAddress.fromString(authWitness.caller),
              action: await decodeFunctionCall(account, authWitness.action),
            })),
          );
          const calls = await Promise.all(
            request.calls.map((x) => decodeFunctionCall(account, x)),
          );

          // approve auth witnesses
          for (const authWitRequest of authWitRequests) {
            await account.createAuthWit(authWitRequest);
          }

          // sign the tx
          const txRequest = await account.createTxExecutionRequest({
            calls,
            fee: await getDefaultFee(account),
          });
          const simulatedTx = await account.simulateTx(
            txRequest,
            true, // simulatePublic
          );
          const tx = await account.proveTx(
            txRequest,
            simulatedTx.privateExecutionResult,
          );
          const txHash = await new SentTx(
            account,
            account.sendTx(tx.toTx()),
          ).getTxHash();
          return txHash.toString();
        },
        aztec_call: async (request) => {
          const account = getAccount(request.from);
          const deserializedCalls = await Promise.all(
            request.calls.map((x) => decodeFunctionCall(account, x)),
          );
          const { indexedCalls, unconstrained } = deserializedCalls.reduce<{
            /** Keep track of the number of private calls to retrieve the return values */
            privateIndex: 0;
            /** Keep track of the number of public calls to retrieve the return values */
            publicIndex: 0;
            /** The public and private function calls in the batch */
            indexedCalls: [FunctionCall, number, number][];
            /** The unconstrained function calls in the batch. */
            unconstrained: [FunctionCall, number][];
          }>(
            (acc, current, index) => {
              if (current.type === FunctionType.UNCONSTRAINED) {
                acc.unconstrained.push([current, index]);
              } else {
                acc.indexedCalls.push([
                  current,
                  index,
                  current.type === FunctionType.PRIVATE
                    ? acc.privateIndex++
                    : acc.publicIndex++,
                ]);
              }
              return acc;
            },
            {
              indexedCalls: [],
              unconstrained: [],
              publicIndex: 0,
              privateIndex: 0,
            },
          );

          const unconstrainedCalls = unconstrained.map(
            async ([call, index]) =>
              [
                await account.simulateUnconstrained(
                  call.name,
                  call.args,
                  call.to,
                  account.getAddress(),
                ),
                index,
              ] as const,
          );

          let simulatedTxPromise: Promise<TxSimulationResult> | undefined;
          if (indexedCalls.length !== 0) {
            const txRequest = await account.createTxExecutionRequest({
              calls: indexedCalls.map(([call]) => call),
              fee: await getDefaultFee(account),
            });
            simulatedTxPromise = account.simulateTx(
              txRequest,
              true, // simulatePublic
              undefined, // TODO: use account.getAddress() when fixed https://github.com/AztecProtocol/aztec-packages/issues/11278
              false, // skipTxValidation
            );
          }

          const [unconstrainedResults, simulatedTx] = await Promise.all([
            Promise.all(unconstrainedCalls),
            simulatedTxPromise,
          ]);

          const results: string[] = [];

          for (const [result, index] of unconstrainedResults) {
            // TODO: remove encoding logic when fixed https://github.com/AztecProtocol/aztec-packages/issues/11275
            let returnTypes = deserializedCalls[index]!.returnTypes;
            if (returnTypes.length === 1 && returnTypes[0]?.kind === "tuple") {
              returnTypes = returnTypes[0]!.fields;
            }
            const paramsAbi: ABIParameter[] = returnTypes.map((type, i) => ({
              type,
              name: `result${i}`,
              visibility: "public",
            }));
            const encoded = encodeArguments(
              { parameters: paramsAbi } as FunctionAbi,
              Array.isArray(result) ? result : [result],
            );
            results[index] = await serde.FrArray.serialize(encoded);
          }
          if (simulatedTx) {
            for (const [call, callIndex, resultIndex] of indexedCalls) {
              // As account entrypoints are private, for private functions we retrieve the return values from the first nested call
              // since we're interested in the first set of values AFTER the account entrypoint
              // For public functions we retrieve the first values directly from the public output.
              const rawReturnValues =
                call.type == FunctionType.PRIVATE
                  ? simulatedTx.getPrivateReturnValues()?.nested?.[resultIndex]
                      ?.values
                  : simulatedTx.getPublicReturnValues()?.[resultIndex]?.values;
              results[callIndex] = await serde.FrArray.serialize(
                rawReturnValues ?? [],
              );
            }
          }
          return results;
        },
        aztec_requestAccounts: async () => {
          return accounts.map((a) => a.getCompleteAddress().toString());
        },
        aztec_accounts: async () => {
          return accounts.map((a) => a.getCompleteAddress().toString());
        },
      };

      let result = await methodMap[params.method](...params.params);
      result = JSON.parse(JSON.stringify(result)); // ensure (de)serialization works
      return result;
    },
  };

  async function getDefaultFee(
    aztecNode: Pick<AztecNode, "getCurrentBaseFees">,
  ) {
    return {
      gasSettings: GasSettings.default({
        maxFeesPerGas: await aztecNode.getCurrentBaseFees(),
      }),
      paymentMethod: new NoFeePaymentMethod(),
    };
  }

  return provider;
}
