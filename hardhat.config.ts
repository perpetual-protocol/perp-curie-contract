import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import { HardhatUserConfig } from "hardhat/config"
import _ from "lodash"
import "solidity-coverage"

const RINKEBY_MNEMONIC = _.defaultTo(process.env.RINKEBY_MNEMONIC, "")
if (_.isEmpty(RINKEBY_MNEMONIC)) {
    console.warn("RINKEBY_MNEMONIC is empty")
}

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
            url: "https://rinkeby.infura.io/v3/c8aa0d69c3e64141bc40de909cd33ad6",
            accounts: {
                mnemonic: RINKEBY_MNEMONIC,
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
