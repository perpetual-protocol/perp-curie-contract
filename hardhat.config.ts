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
import { HardhatUserConfig, task } from "hardhat/config"
import "solidity-coverage"
import {
    ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC,
    ARBITRUM_RINKEBY_WEB3_ENDPOINT,
    RINKEBY_DEPLOYER_MNEMONIC,
    RINKEBY_WEB3_ENDPOINT,
} from "./constants"
import "./mocha-test"
import { verifyAndPushContract } from "./scripts/tenderly"

enum ChainId {
    ARBITRUM_ONE_CHAIN_ID = 42161,
    ARBITRUM_RINKEBY_CHAIN_ID = 421611,
    RINKEBY_CHAIN_ID = 4,
}

task("tenderly", "Contract verification and push on Tenderly")
    .addParam("stage", "stage")
    .setAction(async ({ stage }, hre) => {
        await verifyAndPushContract(hre, stage)
    })

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
        },
    },
    namedAccounts: {
        deployer: 0, // 0 means ethers.getSigners[0]
        uniswapV3Factory: {
            default: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        },
        // Chainlink addresses
        // Rinkeby: https://docs.chain.link/docs/ethereum-addresses/#Rinkeby%20Testnet
        // Arbitrum: https://docs.chain.link/docs/arbitrum-price-feeds/
        ethUsdChainlinkAggregator: {
            [ChainId.RINKEBY_CHAIN_ID]: "0x8A753747A1Fa494EC906cE90E9f37563A8AF630e",
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0x5f0423B1a6935dc5596e7A24d98532b67A0AeFd8",
        },
        btcUsdChainlinkAggregator: {
            [ChainId.RINKEBY_CHAIN_ID]: "0xECe365B379E1dD183B20fc5f022230C044d51404",
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0x0c9973e7a27d00e656B9f153348dA46CaD70d03d",
        },
        // USDC addresses (only needed for production)
        // Arbitrum: https://arbiscan.io/token/0xff970a61a04b1ca14834a43f5de4533ebddb5cc8
        usdc: {
            [ChainId.ARBITRUM_ONE_CHAIN_ID]: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
        },
        // follow up this page : https://www.notion.so/perp/Arbitrum-Faucet-0ded856b8ff1499180559fba6e79ef62
        faucetIssuer: {
            [ChainId.RINKEBY_CHAIN_ID]: "0xA9818F7A9CBF0483366fBe43B90b62E52655F404",
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0xA9818F7A9CBF0483366fBe43B90b62E52655F404",
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
        project: "lushan-staging-0-7-0",
        username: "perpprotocol",
    },
}

export default config
