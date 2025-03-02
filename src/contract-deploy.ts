import type {
  Contract as AztecContract,
  ContractArtifact,
  ContractInstanceWithAddress,
  Fr,
  FunctionArtifact,
  FunctionCall,
  PublicKeys,
  PXE,
  TxHash,
  TxReceipt,
  WaitOpts,
} from "@aztec/aztec.js";
import { AztecAddress, SentTx } from "@aztec/aztec.js";
import {
  getContractClassFromArtifact,
  getContractInstanceFromDeployParams,
  MAX_PACKED_PUBLIC_BYTECODE_SIZE_IN_FIELDS,
} from "@aztec/circuits.js";
import { bufferAsFields, getInitializer } from "@aztec/foundation/abi";
import { ProtocolContractAddress } from "@aztec/protocol-contracts";
import { getCanonicalClassRegisterer } from "@aztec/protocol-contracts/class-registerer";
import { getCanonicalInstanceDeployer } from "@aztec/protocol-contracts/instance-deployer";
import type { MinimalAztecNode } from "./base.js";
import {
  Contract,
  ContractFunctionInteraction,
  UnsafeContract,
  type Capsule,
  type ContractInfo,
} from "./contract.js";
import type { TransactionRequest } from "./exports/eip1193.js";
import type { Account } from "./types.js";
import { lazyValue } from "./utils.js";

export class DeployMethod<TContract extends AztecContract> {
  #contract: () => Promise<ContractInfo>;
  #txRequest: () => Promise<TransactionRequest>;
  #constructorArtifact: FunctionArtifact | undefined;

  constructor(
    publicKeys: PublicKeys,
    private account: Account,
    artifact: ContractArtifact,
    private postDeployCtor: (
      address: AztecAddress,
      account: Account,
    ) => Promise<Contract<TContract>>,
    private args: unknown[],
    private options: DeployOptions,
    constructorNameOrArtifact?: string | FunctionArtifact,
  ) {
    this.#constructorArtifact = getInitializer(
      artifact,
      constructorNameOrArtifact,
    );
    this.#contract = lazyValue(async () => {
      const instance = await getContractInstanceFromDeployParams(artifact, {
        constructorArgs: args,
        salt: options.contractAddressSalt,
        publicKeys,
        constructorArtifact: this.#constructorArtifact,
        deployer: options.universalDeploy
          ? AztecAddress.ZERO
          : this.account.getAddress(),
      });

      // Obtain contract class from artifact and check it matches the reported one by the instance.
      const contractClass = await getContractClassFromArtifact(artifact);
      if (!instance.contractClassId.equals(contractClass.id)) {
        throw new Error(
          `Contract class mismatch when deploying contract: got ${instance.contractClassId.toString()} from instance and ${contractClass.id.toString()} from artifact`,
        );
      }

      return {
        address: instance.address,
        instance,
        artifact,
      };
    });

    this.#txRequest = lazyValue(async () => {
      const deployment = await this.#getDeploymentFunctionCalls();
      const bootstrap = await this.#getInitializeFunctionCalls();

      if (deployment.calls.length + bootstrap.calls.length === 0) {
        throw new Error(
          `No function calls needed to deploy contract ${artifact.name}`,
        );
      }

      return {
        calls: [...deployment.calls, ...bootstrap.calls],
        capsules: [...deployment.capsules, ...bootstrap.capsules],
        registerContracts: [await this.#contract()],
      } satisfies TransactionRequest;
    });
  }

  send(): DeploySentTx<TContract> {
    const tx = this.account.sendTransaction(this.#txRequest());
    return new DeploySentTx(
      this.account.aztecNode,
      tx.getTxHash(),
      lazyValue(async () => {
        const contract = await this.#contract();
        return await this.postDeployCtor(contract.address, this.account);
      }),
    );
  }

  async #getDeploymentFunctionCalls() {
    const calls: FunctionCall[] = [];
    const capsules: Capsule[] = [];

    const contract = await this.#contract();

    // Register the contract class if it hasn't been published already.
    if (!this.options.skipClassRegistration) {
      const alreadyRegistered =
        (await this.account.aztecNode.getContractClass(
          contract.instance.contractClassId,
        )) != null;
      if (!alreadyRegistered) {
        const registering = await registerContractClass(
          this.account,
          contract.artifact,
        );
        calls.push(registering.call);
        capsules.push(registering.capsule);
      }
    }

    // Deploy the contract via the instance deployer.
    if (!this.options.skipPublicDeployment) {
      const deploymentInteraction = await deployInstance(
        this.account,
        contract.instance,
      );
      calls.push(await deploymentInteraction.request());
    }

    return { calls, capsules };
  }

  async #getInitializeFunctionCalls() {
    const contract = await this.#contract();
    const calls: FunctionCall[] = [];
    const capsules: Capsule[] = [];
    if (this.#constructorArtifact && !this.options.skipInitialization) {
      const constructorCall = new ContractFunctionInteraction(
        contract,
        this.account,
        this.#constructorArtifact,
        this.args,
        undefined, // options
      );
      calls.push(await constructorCall.request());
    }
    return { calls, capsules };
  }
}

export type DeployOptions = Pick<
  import("@aztec/aztec.js").DeployOptions,
  | "contractAddressSalt"
  | "universalDeploy"
  | "skipClassRegistration"
  | "skipPublicDeployment"
  | "skipInitialization"
>;

export class DeploySentTx<TContract extends AztecContract> extends SentTx {
  constructor(
    aztecNode: MinimalAztecNode,
    txHash: Promise<TxHash>,
    private contract: () => Promise<Contract<TContract>>,
  ) {
    super(aztecNode as unknown as PXE, txHash);
  }

  async deployed(options: WaitOpts) {
    const receipt = await this.wait(options);
    return receipt.contract;
  }

  async wait(
    options?: WaitOpts,
  ): Promise<TxReceipt & { contract: Contract<TContract> }> {
    const receipt = await super.wait(options);
    const contract = await this.contract();
    return { ...receipt, contract };
  }
}

/** Sets up a call to register a contract class given its artifact. */
async function registerContractClass(
  account: Account,
  artifact: ContractArtifact,
) {
  const emitPublicBytecode = true;
  const {
    artifactHash,
    privateFunctionsRoot,
    publicBytecodeCommitment,
    packedBytecode,
  } = await getContractClassFromArtifact(artifact);
  const encodedBytecode = bufferAsFields(
    packedBytecode,
    MAX_PACKED_PUBLIC_BYTECODE_SIZE_IN_FIELDS,
  );
  const registerer = await getRegistererContract(account);
  const capsule = encodedBytecode;
  const call = await registerer.methods.register!(
    artifactHash,
    privateFunctionsRoot,
    publicBytecodeCommitment,
    emitPublicBytecode,
  ).request();
  return { call, capsule };
}

async function deployInstance(
  account: Account,
  instance: ContractInstanceWithAddress,
): Promise<ContractFunctionInteraction> {
  const deployerContract = await getDeployerContract(account);
  const { salt, contractClassId, publicKeys, deployer } = instance;
  const isUniversalDeploy = deployer.isZero();
  if (!isUniversalDeploy && !account.getAddress().equals(deployer)) {
    throw new Error(
      `Expected deployer ${deployer.toString()} does not match sender account ${account.getAddress().toString()}`,
    );
  }
  return deployerContract.methods.deploy!(
    salt,
    contractClassId,
    instance.initializationHash,
    publicKeys,
    isUniversalDeploy,
  );
}

async function getRegistererContract(account: Account) {
  return await getProtocolContract(
    ProtocolContractAddress.ContractClassRegisterer,
    account,
  );
}

async function getDeployerContract(account: Account) {
  return await getProtocolContract(
    ProtocolContractAddress.ContractInstanceDeployer,
    account,
  );
}

async function getProtocolContract(address: AztecAddress, account: Account) {
  const contractInstance = await account.aztecNode.getContract(address);
  if (!contractInstance) {
    throw new Error(`${address} is not registered`);
  }
  const artifact = await fetchProtocolContractArtifact(
    contractInstance.contractClassId,
  );
  if (!artifact) {
    throw new Error(`no artifact found for ${address}`);
  }
  return new UnsafeContract(contractInstance, artifact, account);
}

async function fetchProtocolContractArtifact(contractClassId: Fr) {
  // TODO: a more robust way to fetch protocol contract artifacts. This does not account for upgrades
  const contracts = await Promise.all([
    getCanonicalClassRegisterer(),
    getCanonicalInstanceDeployer(),
  ]);
  return contracts.find((c) => c.contractClass.id.equals(contractClassId))
    ?.artifact;
}
