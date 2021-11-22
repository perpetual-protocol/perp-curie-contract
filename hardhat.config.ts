import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@openzeppelin/hardhat-upgrades"
import "@tenderly/hardhat-tenderly"
import "@typechain/hardhat"
import "hardhat-contract-sizer"
import "hardhat-dependency-compiler"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import "hardhat-gas-reporter"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"
import {
    ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC,
    ARBITRUM_RINKEBY_WEB3_ENDPOINT,
    OPTIMISM_DEPLOYER_MNEMONIC,
    OPTIMISM_KOVAN_DEPLOYER_MNEMONIC,
    OPTIMISM_KOVAN_WEB3_ENDPOINT,
    OPTIMISM_WEB3_ENDPOINT,
    RINKEBY_DEPLOYER_MNEMONIC,
    RINKEBY_WEB3_ENDPOINT,
    STAGE,
} from "./constants"
import "./mocha-test"

enum ChainId {
    ARBITRUM_ONE_CHAIN_ID = 42161,
    ARBITRUM_RINKEBY_CHAIN_ID = 421611,
    OPTIMISM_CHAIN_ID = 10,
    OPTIMISM_KOVAN_CHAIN_ID = 69,
    RINKEBY_CHAIN_ID = 4,
}

const config: HardhatUserConfig = {
    solidity: {
        version: "0.7.6",
        settings: {
            optimizer: { enabled: true, runs: 0 },
            evmVersion: "berlin",
            // for smock to mock contracts
            outputSelection: {
                "*": {
                    "*": ["storageLayout"],
                },
            },
        },
    },
    networks: {
        hardhat: {
            allowUnlimitedContractSize: true,
            forking:
                STAGE === "staging"
                    ? {
                          enabled: true,
                          url: OPTIMISM_KOVAN_WEB3_ENDPOINT,
                      }
                    : {
                          enabled: false,
                          url: OPTIMISM_WEB3_ENDPOINT,
                      },
            accounts:
                STAGE === "staging"
                    ? {
                          mnemonic: OPTIMISM_KOVAN_DEPLOYER_MNEMONIC,
                      }
                    : {
                          mnemonic: OPTIMISM_DEPLOYER_MNEMONIC,
                      },
            companionNetworks: {
                staging: "optimismKovan",
                production: "optimism",
            },
            saveDeployments: true,
        },
        arbitrumRinkeby: {
            url: ARBITRUM_RINKEBY_WEB3_ENDPOINT,
            accounts: {
                mnemonic: ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC,
            },
            chainId: ChainId.ARBITRUM_RINKEBY_CHAIN_ID,
        },
        rinkeby: {
            url: RINKEBY_WEB3_ENDPOINT,
            accounts: {
                mnemonic: RINKEBY_DEPLOYER_MNEMONIC,
            },
            chainId: ChainId.RINKEBY_CHAIN_ID,
        },
        optimismKovan: {
            url: OPTIMISM_KOVAN_WEB3_ENDPOINT,
            accounts: {
                mnemonic: OPTIMISM_KOVAN_DEPLOYER_MNEMONIC,
            },
            chainId: ChainId.OPTIMISM_KOVAN_CHAIN_ID,
        },
        optimism: {
            url: OPTIMISM_WEB3_ENDPOINT,
            accounts: {
                mnemonic: OPTIMISM_DEPLOYER_MNEMONIC,
            },
            chainId: ChainId.OPTIMISM_CHAIN_ID,
        },
    },
    namedAccounts: {
        deployer: 0, // 0 means ethers.getSigners[0]
        cleanAccount: 1,
        uniswapV3Factory: {
            default: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        },
        gnosisSafeAddress: {
            // It's an EOA account created for v2 because Gnosis safe doesn't support ArbitrumRinkeby now
            [ChainId.RINKEBY_CHAIN_ID]: "0x374152052700eDf29Fc2D4ed5eF93cA7d3fdF38e",
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0x374152052700eDf29Fc2D4ed5eF93cA7d3fdF38e",
            [ChainId.OPTIMISM_KOVAN_CHAIN_ID]: "0x374152052700eDf29Fc2D4ed5eF93cA7d3fdF38e",
        },
        // Chainlink addresses
        // Rinkeby: https://docs.chain.link/docs/ethereum-addresses/#Rinkeby%20Testnet
        // Arbitrum: https://docs.chain.link/docs/arbitrum-price-feeds/
        // Optimism: https://docs.chain.link/docs/optimism-price-feeds/#Optimism%20Kovan
        ethUsdChainlinkAggregator: {
            [ChainId.RINKEBY_CHAIN_ID]: "0x8A753747A1Fa494EC906cE90E9f37563A8AF630e",
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0x5f0423B1a6935dc5596e7A24d98532b67A0AeFd8",
            [ChainId.OPTIMISM_KOVAN_CHAIN_ID]: "0xCb7895bDC70A1a1Dce69b689FD7e43A627475A06",
        },
        btcUsdChainlinkAggregator: {
            [ChainId.RINKEBY_CHAIN_ID]: "0xECe365B379E1dD183B20fc5f022230C044d51404",
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0x0c9973e7a27d00e656B9f153348dA46CaD70d03d",
            [ChainId.OPTIMISM_KOVAN_CHAIN_ID]: "0x81AE7F8fF54070C52f0eB4EB5b8890e1506AA4f4",
        },
        // USDC addresses (only needed for production)
        // Arbitrum: https://arbiscan.io/token/0xff970a61a04b1ca14834a43f5de4533ebddb5cc8
        // Optimism: https://optimistic.etherscan.io/token/0x7f5c764cbc14f9669b88837ca1490cca17c31607
        usdc: {
            [ChainId.ARBITRUM_ONE_CHAIN_ID]: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
            [ChainId.OPTIMISM_CHAIN_ID]: "0x7f5c764cbc14f9669b88837ca1490cca17c31607",
        },
    },
    dependencyCompiler: {
        // We have to compile from source since UniswapV3 doesn't provide artifacts in their npm package
        paths: ["@uniswap/v3-core/contracts/UniswapV3Factory.sol", "@uniswap/v3-core/contracts/UniswapV3Pool.sol"],
    },
    external: {
        contracts: [
            {
                artifacts: "node_modules/@openzeppelin/contracts/build",
            },
            {
                artifacts: "node_modules/@perp/perp-oracle-contract/artifacts",
            },
        ],
    },
    contractSizer: {
        alphaSort: true,
        runOnCompile: true,
        disambiguatePaths: false,
    },
    gasReporter: {
        excludeContracts: ["test"],
    },
    mocha: {
        require: ["ts-node/register/files"],
        jobs: 4,
        timeout: 120000,
        color: true,
    },
    tenderly: {
        project: "curie-op-kovan-0-15",
        username: "perpprotocol",
    },
}

export default config
