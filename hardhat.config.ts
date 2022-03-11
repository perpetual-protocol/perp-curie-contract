import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@openzeppelin/hardhat-upgrades"
import "@typechain/hardhat"
import "hardhat-contract-sizer"
import "hardhat-dependency-compiler"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import "hardhat-gas-reporter"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"
import "./mocha-test"

const config: HardhatUserConfig = {
    solidity: {
        version: "0.7.6",
        settings: {
            optimizer: { enabled: true, runs: 100 },
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
    },
    namedAccounts: {
        deployer: 0, // 0 means ethers.getSigners[0]
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
}

export default config
