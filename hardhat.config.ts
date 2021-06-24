import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"
import { RINKEBY_DEPLOYER_MNEMONIC, RINKEBY_WEB3_ENDPOINT } from "./constants"

const config: HardhatUserConfig = {
    solidity: {
        version: "0.7.6",
        settings: {
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
        rinkeby: {
            url: RINKEBY_WEB3_ENDPOINT,
            accounts: {
                mnemonic: RINKEBY_DEPLOYER_MNEMONIC,
            },
        },
    },
    external: {
        contracts: [
            {
                artifacts: "node_modules/@openzeppelin/contracts/build",
            },
        ],
    },
}

export default config
