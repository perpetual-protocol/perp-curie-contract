import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"

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
